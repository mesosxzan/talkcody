import { logger } from '@/lib/logger';
import type { Message as ModelMessage } from '@/services/llm/types';
import type { CompressionResult } from '@/types/agent';
import { condensePreviousSummary } from './condense-previous-summary';

/**
 * @internal Assembles the final compressed message array from a CompressionResult.
 *
 * Output structure: `[systemPrompt?] + [summaryUserMsg?] + [ackAssistantMsg?] + [...preservedMessages]`
 */
export function createCompressedMessages(result: CompressionResult): ModelMessage[] {
  const compressedMessages: ModelMessage[] = [];
  let startIndex = 0;

  // Step 1: Preserve the original system message (systemPrompt) if it exists
  const firstPreserved = result.preservedMessages[0];
  if (firstPreserved?.role === 'system') {
    // Check if this is the original systemPrompt (not a previous summary)
    const isOriginalSystemPrompt =
      typeof firstPreserved.content === 'string' &&
      !firstPreserved.content.includes('[Previous conversation summary]');

    if (isOriginalSystemPrompt) {
      compressedMessages.push(firstPreserved);
      startIndex = 1;
    }
  }

  // Step 2: If we have a compressed summary, add it as a user message
  if (result.compressedSummary) {
    // Check if there's an old summary (from previous compression) that needs condensing
    let summaryContent = result.compressedSummary;

    // Look for any old system summary messages that should be condensed
    for (let i = startIndex; i < result.preservedMessages.length; i++) {
      const msg = result.preservedMessages[i];
      if (
        msg?.role === 'system' &&
        typeof msg.content === 'string' &&
        msg.content.includes('[Previous conversation summary]')
      ) {
        // Condense the old summary and include it
        const condensedPrevious = condensePreviousSummary(msg.content);
        summaryContent = `${result.compressedSummary}\n\n---\nEarlier context (condensed):\n${condensedPrevious}`;
        break;
      }
    }

    // Add summary as user message (critical for LLM APIs that require user messages)
    compressedMessages.push({
      role: 'user',
      content: `[Previous conversation summary]\n\n${summaryContent}\n\nPlease continue from where we left off.`,
    });

    // Add assistant acknowledgment to maintain message alternation
    compressedMessages.push({
      role: 'assistant',
      content: 'I understand the previous context. Continuing with the task.',
    });
  }

  // Step 3: Add remaining preserved messages (skip system messages that are summaries)
  for (let i = startIndex; i < result.preservedMessages.length; i++) {
    const msg = result.preservedMessages[i];
    if (!msg) continue;

    // Skip old system summaries (they've been condensed above)
    if (
      msg.role === 'system' &&
      typeof msg.content === 'string' &&
      msg.content.includes('[Previous conversation summary]')
    ) {
      continue;
    }

    compressedMessages.push(msg);
  }

  logger.info('Created compressed messages', {
    totalMessages: compressedMessages.length,
    hasSystemPrompt: startIndex === 1,
    hasSummary: !!result.compressedSummary,
  });

  return compressedMessages;
}
