import { logger } from '@/lib/logger';
import type { Message as ModelMessage } from '@/services/llm/types';
import type {
  CompressionStrategyResult,
  CompressionStrategyType,
  StrategyContext,
} from '@/types/agent';
import { aiContextCompactionService } from '../../ai/ai-context-compaction';
import { estimateTokens } from '../../code-navigation-service';
import { ContextRewriter } from '../context-rewriter';
import {
  buildContinuationSummaryMessage,
  buildSummaryAcknowledgement,
  formatCompactionSummary,
  messagesToText,
  parseSections,
} from '../utils';

export interface AISummarizationOptions {
  /** Whether to run code summarization (tree-sitter) before AI compression */
  preRunCodeSummarization?: boolean;
}

/**
 * AISummarization strategy: uses an AI model to generate a compressed summary.
 * Highest cost, highest quality. Can optionally pre-run tree-sitter code summarization
 * for backward compatibility with the original pipeline.
 */
export class AISummarizationStrategy {
  readonly type = 'ai_summarization' as CompressionStrategyType;
  readonly cost = 'high' as const;
  readonly quality = 'high' as const;

  private options: AISummarizationOptions;
  private messageRewriter = new ContextRewriter();

  constructor(options: AISummarizationOptions = {}) {
    this.options = options;
  }

  isApplicable(_context: StrategyContext): boolean {
    return true; // AI can handle any context
  }

  estimateCompressionRatio(_context: StrategyContext): number {
    return 0.3;
  }

  async execute(context: StrategyContext): Promise<CompressionStrategyResult> {
    const tokensBefore = await this.countTokens(context.messages);
    const startTime = Date.now();

    let messages = context.messages;

    // Optionally pre-run code summarization (for backward compatibility)
    let preSummarized = false;
    if (this.options.preRunCodeSummarization) {
      try {
        messages = await this.messageRewriter.rewriteMessages(messages);
        preSummarized = true;
        logger.info('AISummarization: pre-ran code summarization');
      } catch (error) {
        logger.warn('AISummarization: code summarization failed, continuing', error);
      }
    }

    // Convert messages to text for AI compression
    const conversationHistory = messagesToText(messages);

    // Perform AI compression
    let compressedSummary: string;
    try {
      compressedSummary = await aiContextCompactionService.compactContext(
        conversationHistory,
        context.compressionModel,
        context.compressionFallbackModels
      );
    } catch (error) {
      logger.warn('AISummarization: AI compression failed', error);
      // Return original messages on failure
      return {
        messages: context.messages,
        tokensBefore,
        tokensAfter: tokensBefore,
        compressionRatio: 1,
        strategyType: this.type,
        metadata: {
          modelUsed: context.compressionModel,
          latencyMs: Date.now() - startTime,
          failed: true,
        },
      };
    }

    const formattedSummary = formatCompactionSummary(compressedSummary);

    // Parse sections from the normalized summary content
    const sections = parseSections(formattedSummary);

    // Build compressed messages: summary user + ack assistant
    const compressedMessages: ModelMessage[] = [];
    if (formattedSummary) {
      compressedMessages.push({
        role: 'user',
        content: buildContinuationSummaryMessage(formattedSummary),
      });
      compressedMessages.push({
        role: 'assistant',
        content: buildSummaryAcknowledgement(),
      });
    }

    const tokensAfter = await this.countTokens(compressedMessages);
    const latencyMs = Date.now() - startTime;

    logger.info('AISummarization strategy executed', {
      tokensBefore,
      tokensAfter,
      latencyMs,
      sectionsGenerated: sections.length,
      preSummarized,
    });

    return {
      messages: compressedMessages,
      tokensBefore,
      tokensAfter,
      compressionRatio: tokensAfter / tokensBefore,
      strategyType: this.type,
      metadata: {
        modelUsed: context.compressionModel,
        latencyMs,
        sectionsGenerated: sections.length,
        preSummarized,
      },
    };
  }

  private async countTokens(messages: ModelMessage[]): Promise<number> {
    try {
      const text = messages
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n');
      return estimateTokens(text);
    } catch {
      return messages.reduce((sum, m) => {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return sum + Math.ceil(c.length / 4);
      }, 0);
    }
  }
}
