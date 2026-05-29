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
 */

import { logger } from '@/lib/logger';
import type { ContextCompactor } from '@/services/context/context-compactor';
import type { ContentPart, Message as ModelMessage } from '@/services/llm/types';
import type { CompressionConfig, CompressionResult } from '@/types/agent';

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
 * Incrementally truncate the oldest API-round message groups
 * until the request fits within the context window.
 *
 * An "API-round group" is a pair of assistant message + following user message
 * (which contains tool results). We remove entire rounds to maintain
 * message format validity.
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
    // Find the first non-system message pair to remove
    // System message is always index 0, so we start removing from index 1
    let removeCount = 0;
    let removeStart = 1; // Skip system message

    // Find the first complete API round (assistant + user pair)
    for (let i = removeStart; i < currentMessages.length - 1; i++) {
      const msg = currentMessages[i];
      const nextMsg = currentMessages[i + 1];

      if (!msg || !nextMsg) continue;

      // Remove a complete round: assistant message followed by user/tool-result message
      if (msg.role === 'assistant' && (nextMsg.role === 'user' || nextMsg.role === 'tool')) {
        removeCount = 2;
        removeStart = i;
        break;
      }

      // Or just remove a single orphaned message
      if (msg.role === 'assistant' || msg.role === 'user') {
        removeCount = 1;
        removeStart = i;
        break;
      }
    }

    if (removeCount === 0) {
      logger.warn('[PTL Retry] No removable message groups found');
      return null;
    }

    // Remove the identified messages
    currentMessages = [
      ...currentMessages.slice(0, removeStart),
      ...currentMessages.slice(removeStart + removeCount),
    ];

    logger.info(`[PTL Retry] Attempt ${attempt}: removed ${removeCount} messages from head`, {
      remainingMessages: currentMessages.length,
      removedFrom: removeStart,
    });

    if (currentMessages.length <= minMessages) {
      logger.info('[PTL Retry] Reached minimum message count');
      return currentMessages;
    }
  }

  return currentMessages;
}

// === Micro-Compact Time Window ===

/**
 * Clear old tool result content that has likely expired from the
 * server's prompt cache. This is a lightweight operation that
 * doesn't require an API call - it just replaces old tool results
 * with a placeholder in the conversation history.
 *
 * The key insight: if the server's prompt cache has expired (typically
 * after 5 minutes of inactivity), the cached content is no longer
 * providing a benefit, so we can safely clear it to free up context.
 *
 * @param messages The messages to process
 * @param lastAssistantTimestamp When the last assistant message was sent
 * @param cacheExpiryMs How long before the server cache expires (default 5 min)
 * @returns Messages with old tool results cleared
 */
export function clearExpiredToolResults(
  messages: ModelMessage[],
  lastAssistantTimestamp: number,
  cacheExpiryMs: number = 5 * 60 * 1000
): ModelMessage[] {
  const now = Date.now();
  const timeSinceLastAssistant = now - lastAssistantTimestamp;

  // Only clear if the cache has likely expired
  if (timeSinceLastAssistant < cacheExpiryMs) {
    return messages;
  }

  let clearedCount = 0;
  const processedMessages = messages.map((msg) => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) {
      return msg;
    }

    // Check if this tool result is old enough to clear
    const hasLargeContent = msg.content.some((part) => {
      if (typeof part === 'object' && part !== null && 'type' in part) {
        const p = part as { type: string; output?: unknown };
        if (p.type === 'tool-result' && p.output) {
          const outputStr = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
          return outputStr.length > 5000; // Only clear large results
        }
      }
      return false;
    });

    if (!hasLargeContent) {
      return msg;
    }

    // Replace large tool results with a placeholder
    const clearedContent: ContentPart[] = msg.content.map((part) => {
      if (typeof part === 'object' && part !== null && 'type' in part) {
        const p = part as { type: string; output?: unknown; toolName?: string };
        if (p.type === 'tool-result' && p.output) {
          const outputStr = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
          if (outputStr.length > 5000) {
            clearedCount++;
            return {
              ...part,
              output: `[Old tool result content cleared to free context. Tool: ${p.toolName || 'unknown'}]`,
            } as ContentPart;
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
