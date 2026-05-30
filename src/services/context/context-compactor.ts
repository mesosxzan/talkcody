import { logger } from '@/lib/logger';
import {
  mergeConsecutiveAssistantMessages,
  removeOrphanedToolMessages,
} from '@/lib/message-convert';
import { validateAnthropicMessages } from '@/lib/message-validate';
import { timedMethod } from '@/lib/timer';
import {
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
} from '@/providers/config/model-config';
import type { Message as ModelMessage } from '@/services/llm/types';
import type {
  CompressionConfig,
  CompressionResult,
  CompressionStrategyType,
  MessageCompactionOptions,
} from '@/types/agent';
import { aiContextCompactionService } from '../ai/ai-context-compaction';
import { estimateTokens } from '../code-navigation-service';
import { ContextAnalyzer } from './context-analyzer';
import { ContextFilter } from './context-filter';
import { ContextRewriter } from './context-rewriter';
import { StrategySelector } from './strategy-selector';
import { createCompressedMessages, messagesToText, parseSections } from './utils';

/**
 * Strip image and video content from messages to reduce token usage
 * before sending to the compression API. Images/videos are replaced with
 * placeholder text so the compressor knows they existed but doesn't
 * process the expensive binary content.
 */
function stripMediaContent(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'user' && msg.role !== 'assistant') return msg;
    if (!Array.isArray(msg.content)) return msg;

    let stripped = false;
    const newContent = msg.content.map((part) => {
      if (typeof part === 'object' && part !== null && 'type' in part) {
        if (part.type === 'image') {
          stripped = true;
          return { type: 'text' as const, text: '[Image content stripped for compression]' };
        }
        if (part.type === 'video') {
          stripped = true;
          return { type: 'text' as const, text: '[Video content stripped for compression]' };
        }
      }
      return part;
    });

    return stripped ? { ...msg, content: newContent } : msg;
  });
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  fixedMessages?: ModelMessage[];
}

export interface SelectMessagesToCompressResult {
  /** Messages to be compressed (after filtering) */
  messagesToCompress: ModelMessage[];
  /** Messages to preserve (includes system message, critical tool calls, recent messages) */
  preservedMessages: ModelMessage[];
  /** Original system message if present */
  originalSystemMessage: ModelMessage | null;
}

export class ContextCompactor {
  private readonly PRESERVE_TOOL_NAMES = ['exitPlanMode', 'todoWrite'];
  private readonly contextAnalyzer: ContextAnalyzer;
  private readonly strategySelector: StrategySelector;
  private messageFilter: ContextFilter;
  private messageRewriter: ContextRewriter;
  private compressionStats = {
    totalCompressions: 0,
    totalTimeSaved: 0,
    averageCompressionRatio: 0,
  };

  constructor() {
    this.messageFilter = new ContextFilter();
    this.messageRewriter = new ContextRewriter();
    this.contextAnalyzer = new ContextAnalyzer();
    this.strategySelector = new StrategySelector(this.contextAnalyzer);
  }

  /**
   * Adjusts the preserve boundary to avoid cutting tool-call/tool-result pairs.
   * Scans backwards from the cut point to include any tool-calls that have
   * matching tool-results in the preserved section.
   */
  private adjustPreserveBoundary(messages: ModelMessage[], preserveCount: number): number {
    const cutIndex = messages.length - preserveCount;

    if (cutIndex <= 0) return preserveCount;

    // Collect tool-result IDs from preserved messages
    const preservedToolResultIds = new Set<string>();
    for (let i = cutIndex; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;
      if (msg.role === 'tool' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (
            typeof part === 'object' &&
            part !== null &&
            'type' in part &&
            part.type === 'tool-result' &&
            'toolCallId' in part
          ) {
            preservedToolResultIds.add(part.toolCallId as string);
          }
        }
      }
    }

    if (preservedToolResultIds.size === 0) {
      return preserveCount; // No tool results in preserved section
    }

    // Scan backwards to find tool-calls that match preserved tool-results
    let adjustedCutIndex = cutIndex;
    for (let i = cutIndex - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg) continue;
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        let hasMatchingToolCall = false;
        for (const part of msg.content) {
          if (
            typeof part === 'object' &&
            part !== null &&
            'type' in part &&
            part.type === 'tool-call' &&
            'toolCallId' in part &&
            preservedToolResultIds.has(part.toolCallId as string)
          ) {
            hasMatchingToolCall = true;
            break;
          }
        }
        if (hasMatchingToolCall) {
          adjustedCutIndex = i;
          // Continue scanning - there might be more matching calls earlier
        }
      }
    }

    const adjustedPreserveCount = messages.length - adjustedCutIndex;

    if (adjustedPreserveCount !== preserveCount) {
      logger.info('Adjusted preserve boundary to avoid orphaned tool messages', {
        originalPreserveCount: preserveCount,
        adjustedPreserveCount,
        reason: 'tool-call/tool-result pairing',
      });
    }

    return adjustedPreserveCount;
  }

  /**
   * Extracts the last occurrence of specified tool calls from messages.
   * Returns remaining messages and extracted messages (with their tool-results).
   */
  private extractLastToolCalls(
    messages: ModelMessage[],
    toolNames: string[]
  ): { remaining: ModelMessage[]; extracted: ModelMessage[] } {
    const toolNamesToFind = new Set(toolNames);
    const foundToolCallIds = new Map<string, string>(); // toolName -> toolCallId

    // Scan backwards to find the last occurrence of each tool
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

      for (const part of msg.content) {
        if (
          typeof part === 'object' &&
          part !== null &&
          'type' in part &&
          part.type === 'tool-call' &&
          'toolName' in part &&
          'toolCallId' in part
        ) {
          const toolName = part.toolName as string;
          if (toolNamesToFind.has(toolName) && !foundToolCallIds.has(toolName)) {
            foundToolCallIds.set(toolName, part.toolCallId as string);
          }
        }
      }

      // Stop early if we found all tools
      if (foundToolCallIds.size === toolNamesToFind.size) break;
    }

    if (foundToolCallIds.size === 0) {
      return { remaining: messages, extracted: [] };
    }

    const toolCallIdsToExtract = new Set(foundToolCallIds.values());
    const extracted: ModelMessage[] = [];
    const remaining: ModelMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const extractedParts: typeof msg.content = [];
        const remainingParts: typeof msg.content = [];

        for (const part of msg.content) {
          if (
            typeof part === 'object' &&
            part !== null &&
            'type' in part &&
            part.type === 'tool-call' &&
            'toolCallId' in part &&
            toolCallIdsToExtract.has(part.toolCallId as string)
          ) {
            extractedParts.push(part);
          } else {
            remainingParts.push(part);
          }
        }

        if (extractedParts.length > 0) {
          extracted.push({ ...msg, content: extractedParts });
        }
        if (remainingParts.length > 0) {
          remaining.push({ ...msg, content: remainingParts });
        }
      } else if (msg.role === 'tool' && Array.isArray(msg.content)) {
        const extractedParts: typeof msg.content = [];
        const remainingParts: typeof msg.content = [];

        for (const part of msg.content) {
          if (
            typeof part === 'object' &&
            part !== null &&
            'type' in part &&
            part.type === 'tool-result' &&
            'toolCallId' in part &&
            toolCallIdsToExtract.has(part.toolCallId as string)
          ) {
            extractedParts.push(part);
          } else {
            remainingParts.push(part);
          }
        }

        if (extractedParts.length > 0) {
          extracted.push({ ...msg, content: extractedParts });
        }
        if (remainingParts.length > 0) {
          remaining.push({ ...msg, content: remainingParts });
        }
      } else {
        remaining.push(msg);
      }
    }

    if (extracted.length > 0) {
      logger.info('Extracted critical tool calls for preservation', {
        toolNames: [...foundToolCallIds.keys()],
        extractedMessageCount: extracted.length,
      });
    }

    return { remaining, extracted };
  }

  /**
   * Selects which messages should be compressed and which should be preserved.
   * This method handles:
   * 1. Extracting and preserving the system message
   * 2. Adjusting preserve boundary to avoid cutting tool-call/tool-result pairs
   * 3. Extracting critical tool calls (exitPlanMode, todoWrite) for preservation
   * 4. Applying message filter to remove duplicate file reads and outdated exploratory tools
   */
  public selectMessagesToCompress(
    messages: ModelMessage[],
    preserveRecentMessages: number
  ): SelectMessagesToCompressResult {
    // Step 1: Extract and preserve the original system message (systemPrompt)
    // The first message is typically the system prompt, which should never be compressed
    let originalSystemMessage: ModelMessage | null = null;
    let messagesToProcess = messages;

    if (messages[0]?.role === 'system') {
      originalSystemMessage = messages[0];
      messagesToProcess = messages.slice(1);
    }

    // Determine which messages to compress and which to preserve
    // Use adjusted boundary to avoid cutting tool-call/tool-result pairs
    const initialPreserveCount = Math.min(preserveRecentMessages, messagesToProcess.length);
    const preserveCount = this.adjustPreserveBoundary(messagesToProcess, initialPreserveCount);
    const recentPreservedMessages = messagesToProcess.slice(-preserveCount);
    let messagesToCompress = messagesToProcess.slice(0, messagesToProcess.length - preserveCount);

    // Extract critical tool calls (exitPlanMode, todoWrite) for preservation
    const { remaining: afterExtraction, extracted: criticalToolMessages } =
      this.extractLastToolCalls(messagesToCompress, this.PRESERVE_TOOL_NAMES);
    messagesToCompress = afterExtraction;

    // Apply message filter to remove duplicate file reads and outdated exploratory tools
    messagesToCompress = this.messageFilter.filterMessages(messagesToCompress);

    // Combine extracted critical tool messages with recent preserved messages
    let preservedMessages = [...criticalToolMessages, ...recentPreservedMessages];

    // Prepend the original system message to preserved messages
    if (originalSystemMessage) {
      preservedMessages = [originalSystemMessage, ...preservedMessages];
    }

    return {
      messagesToCompress,
      preservedMessages,
      originalSystemMessage,
    };
  }

  @timedMethod('MessageCompactor.compactMessages')
  public async compactMessages(
    options: MessageCompactionOptions,
    lastTokenCount: number, // Original token count for early-exit check
    _abortController?: AbortController
  ): Promise<CompressionResult> {
    const { messages, config } = options;

    logger.info('Starting message compaction', {
      originalMessageCount: messages.length,
      preserveRecentMessages: config.preserveRecentMessages,
      strategyMode: config.strategyMode ?? 'auto',
    });

    // Use selectMessagesToCompress to determine which messages to compress and preserve
    const { messagesToCompress, preservedMessages } = this.selectMessagesToCompress(
      messages,
      config.preserveRecentMessages
    );

    if (messagesToCompress.length === 0) {
      logger.info('No messages to compress, returning original/preserved messages');
      return {
        compressedSummary: '',
        sections: [],
        preservedMessages: preservedMessages.length > 0 ? preservedMessages : messages,
        originalMessageCount: messages.length,
        compressedMessageCount:
          preservedMessages.length > 0 ? preservedMessages.length : messages.length,
        compressionRatio:
          preservedMessages.length > 0 ? preservedMessages.length / messages.length : 1.0,
      };
    }

    // If strategyMode is configured, use the multi-strategy pipeline
    if (config.strategyMode && config.strategyMode !== 'ai_only') {
      return this.compactWithStrategies(
        messages,
        messagesToCompress,
        preservedMessages,
        config,
        lastTokenCount
      );
    }

    // Legacy pipeline: tree-sitter → early-exit → AI compression
    // (Also used for 'ai_only' mode which matches the original behavior)
    return this.compactWithLegacyPipeline(
      messages,
      messagesToCompress,
      preservedMessages,
      config,
      lastTokenCount
    );
  }

  /**
   * Multi-strategy compression pipeline: analyze → select strategy → execute → assemble result.
   */
  private async compactWithStrategies(
    messages: ModelMessage[],
    messagesToCompress: ModelMessage[],
    preservedMessages: ModelMessage[],
    config: CompressionConfig,
    _lastTokenCount: number
  ): Promise<CompressionResult> {
    // Analyze context
    const analysis = await this.contextAnalyzer.analyze(messagesToCompress);

    // Select strategy
    const strategy = this.strategySelector.select(config);

    // Build strategy context
    const maxContextTokens = config.compressionModel
      ? getEffectiveContextWindowSize(config.compressionModel)
      : 200000;
    const targetTokenBudget = Math.floor(maxContextTokens * (1 - config.compressionThreshold));
    const strategyContext = this.strategySelector.buildContext(
      messagesToCompress,
      config,
      analysis,
      targetTokenBudget,
      config.preserveRecentMessages
    );

    // Execute strategy
    const strategyResult = await strategy.execute(strategyContext);

    // Assemble final CompressionResult
    const hasSummary = strategyResult.messages.length < messagesToCompress.length;
    const compressedSummary = hasSummary
      ? strategyResult.messages
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n')
      : '';

    const sections = hasSummary ? parseSections(compressedSummary) : [];

    const result: CompressionResult = {
      compressedSummary,
      sections,
      preservedMessages: [...strategyResult.messages, ...preservedMessages],
      originalMessageCount: messages.length,
      compressedMessageCount: strategyResult.messages.length + preservedMessages.length,
      compressionRatio: strategyResult.compressionRatio,
      strategyChain: (strategyResult.metadata.strategyChain as
        | CompressionStrategyType[]
        | undefined) ?? [strategyResult.strategyType],
      strategyResults: [strategyResult],
      analysis,
    };

    this.updateStats(result);

    logger.info('Multi-strategy compaction completed', {
      strategyType: strategyResult.strategyType,
      originalCount: result.originalMessageCount,
      compressedCount: result.compressedMessageCount,
      ratio: result.compressionRatio,
    });

    return result;
  }

  /**
   * Legacy compression pipeline: tree-sitter → early-exit → AI.
   * Used when strategyMode is undefined or 'ai_only' for backward compatibility.
   */
  private async compactWithLegacyPipeline(
    messages: ModelMessage[],
    messagesToCompress: ModelMessage[],
    preservedMessages: ModelMessage[],
    config: CompressionConfig,
    lastTokenCount: number
  ): Promise<CompressionResult> {
    let currentMessagesToCompress = messagesToCompress;

    // Strip image/video content before compression to reduce token usage.
    // Images and videos are expensive in context but not useful for summarization.
    currentMessagesToCompress = stripMediaContent(currentMessagesToCompress);

    // Apply tree-sitter based code summarization to reduce token usage
    try {
      currentMessagesToCompress =
        await this.messageRewriter.rewriteMessages(currentMessagesToCompress);
      logger.info('Applied message rewriting for code summarization');
    } catch (error) {
      logger.error('Failed to apply message rewriting, continuing with original messages:', error);
    }

    if (currentMessagesToCompress.length === 0) {
      logger.info('No messages to compress after rewriting, returning preserved messages');
      return {
        compressedSummary: '',
        sections: [],
        preservedMessages: preservedMessages.length > 0 ? preservedMessages : messages,
        originalMessageCount: messages.length,
        compressedMessageCount:
          preservedMessages.length > 0 ? preservedMessages.length : messages.length,
        compressionRatio:
          preservedMessages.length > 0 ? preservedMessages.length / messages.length : 1.0,
      };
    }

    // Convert messages to text for compression
    const conversationHistory = messagesToText(currentMessagesToCompress);

    // Estimate tokens for early-exit optimization
    let estimatedTokens: number | undefined;

    if (lastTokenCount && lastTokenCount > 0) {
      try {
        estimatedTokens = await estimateTokens(conversationHistory);
      } catch (error) {
        logger.warn('Failed to estimate tokens:', error);
      }

      if (estimatedTokens !== undefined) {
        const reductionRatio = 1 - estimatedTokens / lastTokenCount;

        if (reductionRatio >= 0.75) {
          logger.info(
            `Token reduction ${(reductionRatio * 100).toFixed(1)}% >= 75%, skipping AI compression`,
            { originalTokens: lastTokenCount, estimatedTokens, reductionRatio }
          );

          return {
            compressedSummary: '',
            sections: [],
            preservedMessages: [...currentMessagesToCompress, ...preservedMessages],
            originalMessageCount: messages.length,
            compressedMessageCount: currentMessagesToCompress.length + preservedMessages.length,
            compressionRatio: estimatedTokens / lastTokenCount,
          };
        }

        logger.info(
          `Token reduction ${(reductionRatio * 100).toFixed(1)}% < 75%, proceeding with AI compression`,
          { originalTokens: lastTokenCount, estimatedTokens, reductionRatio }
        );
      }
    }

    // Perform AI compression
    let compressedSummary = '';
    try {
      compressedSummary = await aiContextCompactionService.compactContext(
        conversationHistory,
        config.compressionModel,
        config.compressionFallbackModels
      );
    } catch (error) {
      logger.warn('AI compression failed, falling back to tree-sitter rewriting:', error);
      return {
        compressedSummary: '',
        sections: [],
        preservedMessages: [...currentMessagesToCompress, ...preservedMessages],
        originalMessageCount: messages.length,
        compressedMessageCount: currentMessagesToCompress.length + preservedMessages.length,
        compressionRatio:
          estimatedTokens && lastTokenCount ? estimatedTokens / lastTokenCount : 1.0,
      };
    }

    // Parse sections from the compressed summary
    const sections = parseSections(compressedSummary);

    // Create the final result
    const result: CompressionResult = {
      compressedSummary,
      sections,
      preservedMessages,
      originalMessageCount: messages.length,
      compressedMessageCount: 1 + preservedMessages.length,
      compressionRatio: (1 + preservedMessages.length) / messages.length,
    };

    this.updateStats(result);

    logger.info('Message compaction completed', {
      originalCount: result.originalMessageCount,
      compressedCount: result.compressedMessageCount,
      ratio: result.compressionRatio,
    });

    return result;
  }

  public shouldCompress(
    _messages: ModelMessage[],
    config: CompressionConfig,
    lastTokenCount: number,
    currentModel: string
  ): boolean {
    if (!config.enabled) {
      return false;
    }

    // Use actual token count from last AI request if available
    if (!lastTokenCount) {
      return false;
    }

    // Use the auto-compact threshold which accounts for output reservation and buffer
    const thresholdTokens = currentModel
      ? getAutoCompactThreshold(currentModel)
      : 200000 * config.compressionThreshold;

    if (lastTokenCount > thresholdTokens) {
      const effectiveWindow = currentModel ? getEffectiveContextWindowSize(currentModel) : 200000;
      logger.info('Compression triggered by token count', {
        actualTokens: lastTokenCount,
        threshold: thresholdTokens,
        model: currentModel,
        effectiveWindow,
        ratio: lastTokenCount / effectiveWindow,
      });
      return true;
    }

    return false;
  }

  /**
   * Validates compressed messages to ensure no orphaned tool-calls or tool-results.
   * Returns validation result with optional auto-fixed messages.
   * Delegates to message-validate module for validation.
   */
  public validateCompressedMessages(messages: ModelMessage[]): ValidationResult {
    // Use the new validation module
    const anthropicValidation = validateAnthropicMessages(messages);

    if (anthropicValidation.valid) {
      return { valid: true, errors: [] };
    }

    // Convert validation issues to error strings for backward compatibility
    const errors = anthropicValidation.issues.map((issue) => issue.message);

    // Try to fix using the new conversion module
    const fixedMessages = this.fixOrphanedMessages(messages);

    logger.warn('Compressed messages validation failed', { errors });

    return { valid: false, errors, fixedMessages };
  }

  /**
   * Removes orphaned tool messages and fixes consecutive assistant messages.
   * Delegates to message-convert module for fixing.
   */
  private fixOrphanedMessages(messages: ModelMessage[]): ModelMessage[] {
    // Step 1: Remove orphaned tool messages
    let result = removeOrphanedToolMessages(messages);

    // Step 2: Merge consecutive assistant messages
    result = mergeConsecutiveAssistantMessages(result);

    return result;
  }

  public createCompressedMessages(result: CompressionResult): ModelMessage[] {
    return createCompressedMessages(result);
  }

  public getCompressionStats() {
    return { ...this.compressionStats };
  }

  /**
   * Performs full compression workflow: check, compress, validate, and convert.
   * Returns the compressed messages or null if compression is not needed or fails.
   */
  public async performCompressionIfNeeded(
    messages: ModelMessage[],
    config: CompressionConfig,
    lastTokenCount: number,
    currentModel: string,
    systemPrompt: string,
    abortController?: AbortController,
    onStatus?: (status: string) => void
  ): Promise<{ messages: ModelMessage[]; result: CompressionResult } | null> {
    // Check if compression is needed
    if (!this.shouldCompress(messages, config, lastTokenCount, currentModel)) {
      return null;
    }

    logger.info('Starting message compression', {
      messageCount: messages.length,
      config,
    });

    onStatus?.('Compacting messages...');

    const compressionResult = await this.compactMessages(
      {
        messages,
        config,
        systemPrompt,
      },
      lastTokenCount, // Pass for early-exit token check
      abortController
    );

    // Create compressed messages
    const compressedMessages = createCompressedMessages(compressionResult);

    // Validate compressed messages to catch orphaned tool-calls/results
    const validation = this.validateCompressedMessages(compressedMessages);

    let finalMessages: ModelMessage[];

    if (!validation.valid) {
      logger.warn('Compressed messages validation failed', {
        errors: validation.errors,
      });

      if (validation.fixedMessages) {
        finalMessages = validation.fixedMessages;
        logger.info('Applied auto-fix for compressed messages', {
          originalCount: compressedMessages.length,
          fixedCount: finalMessages.length,
        });
      } else {
        finalMessages = compressedMessages;
        logger.warn('No auto-fix available, using compressed messages as-is');
      }
    } else {
      finalMessages = compressedMessages;
    }

    logger.info('Message compression completed', {
      originalCount: compressionResult.originalMessageCount,
      compressedCount: compressionResult.compressedMessageCount,
      ratio: compressionResult.compressionRatio,
      validationPassed: validation.valid,
    });

    return { messages: finalMessages, result: compressionResult };
  }

  private updateStats(result: CompressionResult): void {
    this.compressionStats.totalCompressions++;

    // Update average compression ratio
    const currentAvg = this.compressionStats.averageCompressionRatio;
    const newRatio = result.compressionRatio;
    this.compressionStats.averageCompressionRatio =
      (currentAvg * (this.compressionStats.totalCompressions - 1) + newRatio) /
      this.compressionStats.totalCompressions;
  }
}
