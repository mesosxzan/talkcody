import { logger } from '@/lib/logger';
import type { Message as ModelMessage } from '@/services/llm/types';
import type { CompressionResult } from '@/types/agent';
import { condensePreviousSummary } from './condense-previous-summary';

/** Maximum number of recently-read files to restore after compaction. */
const POST_COMPACT_MAX_FILES_TO_RESTORE = 5;

/**
 * Deduplicate file content in compressed messages.
 * After compaction, the same file content may appear both in the summary
 * and in preserved tool results. This function removes duplicate content
 * in tool results if the same content appears in earlier messages.
 */
function deduplicateFileContent(messages: ModelMessage[]): ModelMessage[] {
  const seenFileContents = new Set<string>();

  return messages.map((msg, index) => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

    const newContent = msg.content.map((part) => {
      if (
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'tool-result'
      ) {
        const output = (part as { output?: unknown }).output;
        if (typeof output === 'string' && output.length > 200) {
          // Use first 200 chars as a fingerprint for dedup
          const fingerprint = output.slice(0, 200);
          if (seenFileContents.has(fingerprint)) {
            return { ...part, output: '[Content already shown in conversation summary above]' };
          }
          // Only add to seen set if this is not the first occurrence
          // (first occurrence is kept, subsequent duplicates are replaced)
          if (index > 0) {
            seenFileContents.add(fingerprint);
          }
        }
      }
      return part;
    });

    return { ...msg, content: newContent };
  });
}

/**
 * Extract file paths from recent tool results (file reads) in the preserved messages.
 * These represent the most recently-accessed files that should be re-injected
 * after compaction so the model retains awareness of the working context.
 */
function extractRecentFilePaths(preservedMessages: ModelMessage[]): string[] {
  const filePaths: string[] = [];

  for (
    let i = preservedMessages.length - 1;
    i >= 0 && filePaths.length < POST_COMPACT_MAX_FILES_TO_RESTORE;
    i--
  ) {
    const msg = preservedMessages[i];
    if (msg?.role !== 'tool' || !Array.isArray(msg.content)) continue;

    for (const part of msg.content) {
      if (
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'tool-result' &&
        'toolName' in part
      ) {
        const toolName = (part as { toolName: string }).toolName;
        if (toolName === 'readFile' || toolName === 'read_file') {
          const input = (part as { input?: unknown }).input;
          if (typeof input === 'object' && input !== null && 'path' in input) {
            const path = (input as { path: string }).path;
            if (path && !filePaths.includes(path)) {
              filePaths.push(path);
            }
          }
        }
      }
    }
  }

  return filePaths;
}

/**
 * Build a post-compact restoration message that re-injects critical context
 * lost during compaction: recently-accessed file paths and task-relevant state.
 */
function buildRestorationContext(preservedMessages: ModelMessage[]): string | null {
  const recentFiles = extractRecentFilePaths(preservedMessages);
  if (recentFiles.length === 0) return null;

  const lines = ['[Post-compact context restoration]'];
  lines.push('The conversation was compacted. Key context that should be retained:');
  lines.push(`Recently accessed files: ${recentFiles.join(', ')}`);
  lines.push('You may need to re-read these files to continue the task effectively.');

  return lines.join('\n');
}

/**
 * @internal Assembles the final compressed message array from a CompressionResult.
 *
 * Output structure: `[systemPrompt?] + [summaryUserMsg?] + [ackAssistantMsg?] + [restorationMsg?] + [...preservedMessages]`
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

  // Step 3: Inject post-compact restoration context (recently accessed files)
  const restorationText = buildRestorationContext(result.preservedMessages.slice(startIndex));
  if (restorationText) {
    compressedMessages.push({ role: 'user', content: restorationText });
    compressedMessages.push({
      role: 'assistant',
      content: 'Understood. I will re-read files as needed.',
    });
  }

  // Step 4: Add remaining preserved messages (skip system messages that are summaries)
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

  // Step 5: Deduplicate file content that appears in both summary and preserved messages
  const deduplicatedMessages = deduplicateFileContent(compressedMessages);

  logger.info('Created compressed messages', {
    totalMessages: deduplicatedMessages.length,
    hasSystemPrompt: startIndex === 1,
    hasSummary: !!result.compressedSummary,
    hasRestorationContext: !!restorationText,
  });

  return deduplicatedMessages;
}
