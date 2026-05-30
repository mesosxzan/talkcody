/**
 * Reactive compaction - handles context overflow at the API boundary.
 *
 * Inspired by cc-haha's approach:
 * - When the API returns a prompt-too-long (PTL) error, this module
 *   attempts progressive compaction to recover without losing the conversation.
 * - PTL retry: If the compaction request itself exceeds context, incrementally
 *   truncate the oldest message groups until the request fits.
 * - Micro-compact time window: Between turns, clear old tool result content
 *   that has likely expired from the server's prompt cache.
 * - Context usage warning: Calculate warning/error thresholds for UI display.
 */

import { logger } from '@/lib/logger';
import { getContextLength } from '@/providers/config/model-config';
import type { ContextCompactor } from '@/services/context/context-compactor';
import type { ContentPart, Message as ModelMessage } from '@/services/llm/types';
import type { CompressionConfig, CompressionResult } from '@/types/agent';

// === Context Usage Warning ===

/** Buffer tokens reserved for output during compaction. */
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
/** Buffer tokens before warning threshold. */
const WARNING_BUFFER_TOKENS = 20_000;
/** Buffer tokens before error threshold. */
const ERROR_BUFFER_TOKENS = 20_000;

export interface ContextWarningState {
  /** Percentage of context window remaining (0-100). */
  percentLeft: number;
  /** True when context usage exceeds warning threshold. */
  isAboveWarningThreshold: boolean;
  /** True when context usage exceeds error threshold. */
  isAboveErrorThreshold: boolean;
  /** True when auto-compact should trigger. */
  isAboveAutoCompactThreshold: boolean;
  /** True when context is at blocking limit. */
  isAtBlockingLimit: boolean;
}

/**
 * Calculate context usage warning state.
 * Inspired by cc-haha's calculateTokenWarningState with 3-level thresholds.
 */
export function calculateContextWarningState(
  tokenUsage: number,
  model: string,
  compressionEnabled: boolean = true
): ContextWarningState {
  const maxContextTokens = getContextLength(model);
  const autoCompactThreshold = maxContextTokens - AUTOCOMPACT_BUFFER_TOKENS;
  const threshold = compressionEnabled ? autoCompactThreshold : maxContextTokens;

  const percentLeft = Math.max(0, Math.round(((threshold - tokenUsage) / threshold) * 100));
  const warningThreshold = threshold - WARNING_BUFFER_TOKENS;
  const errorThreshold = threshold - ERROR_BUFFER_TOKENS;

  return {
    percentLeft,
    isAboveWarningThreshold: tokenUsage >= warningThreshold,
    isAboveErrorThreshold: tokenUsage >= errorThreshold,
    isAboveAutoCompactThreshold: compressionEnabled && tokenUsage >= autoCompactThreshold,
    isAtBlockingLimit: tokenUsage >= maxContextTokens - 3_000,
  };
}

// === Error Detection ===

/**
 * Check if an error is a context-length-exceeded / prompt-too-long error.
 * These errors indicate the conversation has grown beyond the model's context window.
 */
export function isPromptTooLongError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return (
    message.includes('context length exceeded') ||
    message.includes('prompt is too long') ||
    message.includes('prompt-too-long') ||
    message.includes('maximum context length') ||
    message.includes('token limit') ||
    message.includes('input is too long') ||
    message.includes('too many tokens') ||
    // OpenAI specific
    (message.includes('max_tokens') && message.includes('context')) ||
    // Anthropic specific
    (message.includes('prompt is too long') && message.includes('tokens'))
  );
}

// === PTL Retry (Prompt-Too-Long Retry) ===

/**
 * Identify API-round groups in the messages.
 * An API-round group is: an assistant message + all following user/tool messages
 * until the next assistant message. Removing entire rounds maintains
 * message format validity.
 */
function identifyAPIRoundGroups(messages: ModelMessage[]): { start: number; end: number }[] {
  const groups: { start: number; end: number }[] = [];
  let groupStart = -1;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === 'assistant') {
      // Start a new group
      if (groupStart >= 0) {
        groups.push({ start: groupStart, end: i - 1 });
      }
      groupStart = i;
    }
  }

  // Close the last group
  if (groupStart >= 0) {
    groups.push({ start: groupStart, end: messages.length - 1 });
  }

  return groups;
}

/**
 * Incrementally truncate the oldest API-round message groups
 * until the request fits within the context window.
 *
 * Improved version: groups messages by API rounds (assistant + following user/tool)
 * for cleaner truncation that maintains message format validity.
 *
 * @param messages The messages that are too long
 * @param maxRetries Maximum number of truncation attempts
 * @param minMessages Minimum messages to keep (system + recent context)
 * @returns Truncated messages, or null if can't truncate further
 */
export function truncateHeadForPTLRetry(
  messages: ModelMessage[],
  maxRetries: number = 5,
  minMessages: number = 6
): ModelMessage[] | null {
  if (messages.length <= minMessages) {
    logger.warn('[PTL Retry] Cannot truncate further - already at minimum messages');
    return null;
  }

  let currentMessages = [...messages];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Find the system message to preserve
    const systemMsgIndex = currentMessages[0]?.role === 'system' ? 0 : -1;
    const contentStart = systemMsgIndex + 1;

    // Identify API round groups after the system message
    const groups = identifyAPIRoundGroups(currentMessages.slice(contentStart));

    if (groups.length === 0) {
      logger.warn('[PTL Retry] No API round groups found to remove');
      return null;
    }

    // Remove the oldest group
    const oldestGroup = groups[0];
    if (!oldestGroup) {
      logger.warn('[PTL Retry] No API round groups found to remove');
      return null;
    }
    const removeStart = contentStart + oldestGroup.start;
    const removeEnd = contentStart + oldestGroup.end;
    const removeCount = removeEnd - removeStart + 1;

    currentMessages = [
      ...currentMessages.slice(0, removeStart),
      ...currentMessages.slice(removeEnd + 1),
    ];

    logger.info(
      `[PTL Retry] Attempt ${attempt}: removed API round group (${removeCount} messages)`,
      {
        remainingMessages: currentMessages.length,
        groupRange: `${oldestGroup.start}-${oldestGroup.end}`,
      }
    );

    if (currentMessages.length <= minMessages) {
      logger.info('[PTL Retry] Reached minimum message count');
      return currentMessages;
    }
  }

  return currentMessages;
}

// === Micro-Compact Time Window ===

/** Default cache expiry time (5 minutes). */
const DEFAULT_CACHE_EXPIRY_MS = 5 * 60 * 1000;

/**
 * Tool names whose results are safe to clear in micro-compact.
 * These are read-only tools whose output can be stale after cache expiry.
 */
const MICRO_COMPACTABLE_TOOLS = new Set([
  'readFile',
  'read_file',
  'glob',
  'Glob',
  'grep',
  'Grep',
  'codeSearch',
  'listFiles',
  'list_files',
  'bash',
  'shell',
  'executeCommand',
]);

/**
 * Clear old tool result content that has likely expired from the
 * server's prompt cache. This is a lightweight operation that
 * doesn't require an API call - it just replaces old tool results
 * with a placeholder in the conversation history.
 *
 * Cache-aware: Only clears results from compactable (read-only) tools,
 * keeping results from write tools (file edits, etc.) since those
 * represent actual state changes that shouldn't be discarded.
 *
 * The key insight: if the server's prompt cache has expired (typically
 * after 5 minutes of inactivity), the cached content is no longer
 * providing a benefit, so we can safely clear it to free up context.
 *
 * Inspired by cc-haha's time-based microcompact.
 *
 * @param messages The messages to process
 * @param lastAssistantTimestamp When the last assistant message was sent
 * @param cacheExpiryMs How long before the server cache expires (default 5 min)
 * @returns Messages with old tool results cleared
 */
export function clearExpiredToolResults(
  messages: ModelMessage[],
  lastAssistantTimestamp: number,
  cacheExpiryMs: number = DEFAULT_CACHE_EXPIRY_MS
): ModelMessage[] {
  const now = Date.now();
  const timeSinceLastAssistant = now - lastAssistantTimestamp;

  // Only clear if the cache has likely expired
  if (timeSinceLastAssistant < cacheExpiryMs) {
    return messages;
  }

  // Count compactable tool IDs to determine keep/clear boundary.
  // Keep the most recent N results, clear the rest.
  const compactableIds: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          typeof part === 'object' &&
          part !== null &&
          'type' in part &&
          part.type === 'tool-call' &&
          'toolName' in part
        ) {
          const p = part as { toolName: string; toolCallId: string };
          if (MICRO_COMPACTABLE_TOOLS.has(p.toolName)) {
            compactableIds.push(p.toolCallId);
          }
        }
      }
    }
  }

  // Keep at least the most recent 1 compactable tool result
  const keepRecent = Math.max(1, 3);
  const keepSet = new Set(compactableIds.slice(-keepRecent));
  const clearSet = new Set(compactableIds.filter((id) => !keepSet.has(id)));

  if (clearSet.size === 0) {
    return messages;
  }

  let clearedCount = 0;
  const processedMessages = messages.map((msg) => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) {
      return msg;
    }

    // Replace large tool results from clearable IDs with placeholders
    const clearedContent: ContentPart[] = msg.content.map((part) => {
      if (typeof part === 'object' && part !== null && 'type' in part) {
        const p = part as {
          type: string;
          output?: unknown;
          toolName?: string;
          toolCallId?: string;
        };
        if (p.type === 'tool-result' && p.output && p.toolCallId && clearSet.has(p.toolCallId)) {
          const outputStr = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
          if (outputStr.length > 5000) {
            clearedCount++;
            return {
              type: 'tool-result' as const,
              toolCallId: p.toolCallId,
              toolName: p.toolName || 'unknown',
              output: `[Old tool result content cleared to free context. Tool: ${p.toolName || 'unknown'}]`,
            };
          }
        }
      }
      return part;
    });

    return { ...msg, content: clearedContent };
  });

  if (clearedCount > 0) {
    logger.info(`[Micro-Compact] Cleared ${clearedCount} expired tool results`, {
      timeSinceLastAssistant: `${Math.round(timeSinceLastAssistant / 1000)}s`,
      cacheExpiryMs: `${Math.round(cacheExpiryMs / 1000)}s`,
      toolsCleared: clearSet.size,
      toolsKept: keepSet.size,
    });
  }

  return processedMessages;
}

// === Reactive Compaction ===

/**
 * Attempt reactive compaction when a prompt-too-long error occurs.
 *
 * This is a last-resort measure when proactive compaction (auto-compact)
 * failed to prevent the context overflow. It:
 * 1. First tries PTL retry (incremental head truncation)
 * 2. Then tries full compaction with more aggressive settings
 * 3. Returns the compacted messages or null if all attempts fail
 *
 * @param messages The current messages that caused the PTL error
 * @param compactor The context compactor instance
 * @param config Compression configuration
 * @param currentModel The current model name
 * @param systemPrompt The system prompt
 * @returns Compacted messages or null if recovery failed
 */
export async function attemptReactiveCompaction(
  messages: ModelMessage[],
  compactor: ContextCompactor,
  config: CompressionConfig,
  currentModel: string,
  systemPrompt: string
): Promise<{ messages: ModelMessage[]; result: CompressionResult } | null> {
  logger.info('[Reactive Compact] Attempting recovery from prompt-too-long error', {
    messageCount: messages.length,
    model: currentModel,
  });

  // Step 1: Try PTL retry (incremental head truncation)
  const truncated = truncateHeadForPTLRetry(messages);
  if (truncated && truncated.length < messages.length) {
    logger.info('[Reactive Compact] PTL retry succeeded', {
      originalCount: messages.length,
      truncatedCount: truncated.length,
    });

    // Validate the truncated messages
    const { removeOrphanedToolMessages, mergeConsecutiveAssistantMessages } = await import(
      '@/lib/message-convert'
    );
    const fixed = mergeConsecutiveAssistantMessages(removeOrphanedToolMessages(truncated));

    return {
      messages: fixed,
      result: {
        compressedSummary: '[Reactive compact: head truncation]',
        sections: [],
        preservedMessages: fixed,
        originalMessageCount: messages.length,
        compressedMessageCount: fixed.length,
        compressionRatio: fixed.length / messages.length,
      },
    };
  }

  // Step 2: Try full compaction with aggressive settings
  try {
    const aggressiveConfig: CompressionConfig = {
      ...config,
      compressionThreshold: 0.5, // More aggressive threshold
      preserveRecentMessages: Math.max(2, config.preserveRecentMessages - 2), // Keep fewer recent messages
    };

    const result = await compactor.performCompressionIfNeeded(
      messages,
      aggressiveConfig,
      0, // Force compression by setting token count above threshold
      currentModel,
      systemPrompt
    );

    if (result) {
      logger.info('[Reactive Compact] Aggressive compaction succeeded', {
        originalCount: messages.length,
        compressedCount: result.messages.length,
      });
      return result;
    }
  } catch (error) {
    logger.error('[Reactive Compact] Aggressive compaction failed', error);
  }

  logger.warn('[Reactive Compact] All recovery attempts failed');
  return null;
}
