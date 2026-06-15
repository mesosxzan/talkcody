import { logger } from '@/lib/logger';
import type { Message as ModelMessage } from '@/services/llm/types';
import type { CompressionResult } from '@/types/agent';
import { condensePreviousSummary } from './condense-previous-summary';

/** Maximum number of recently-read files to restore after compaction. */
const POST_COMPACT_MAX_FILES_TO_RESTORE = 5;

export function formatCompactionSummary(summary: string): string {
  let formattedSummary = summary.trim();

  formattedSummary = formattedSummary.replace(/<analysis>[\s\S]*?<\/analysis>/i, '').trim();

  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch?.[1]) {
    formattedSummary = summaryMatch[1].trim();
  }

  return formattedSummary.replace(/\n{3,}/g, '\n\n').trim();
}

export function buildContinuationSummaryMessage(summaryContent: string): string {
  return [
    '[Previous conversation summary]',
    '',
    'This session is continuing after context compaction. The summary below covers the earlier portion of the work.',
    '',
    summaryContent,
    '',
    'Resume directly from the latest active task. Treat preserved recent messages as the most current source of truth if they are more recent than the summary. Do not restart solved work or ask the user to repeat context unless the preserved messages show that clarification is still needed.',
  ].join('\n');
}

export function buildSummaryAcknowledgement(): string {
  return 'Understood. I will continue from the latest active task and use preserved recent context as the source of truth.';
}

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
  lines.push('Recent file context worth preserving after compaction:');
  lines.push(`- Recently accessed files: ${recentFiles.join(', ')}`);
  lines.push(
    '- Re-read these files only if the preserved recent messages do not already contain enough context.'
  );

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
    let summaryContent = formatCompactionSummary(result.compressedSummary);

    // Look for any old summary messages that should be condensed
    for (let i = startIndex; i < result.preservedMessages.length; i++) {
      const msg = result.preservedMessages[i];
      if (
        (msg?.role === 'system' || msg?.role === 'user') &&
        typeof msg.content === 'string' &&
        msg.content.includes('[Previous conversation summary]')
      ) {
        // Condense the old summary and include it
        const condensedPrevious = condensePreviousSummary(msg.content);
        summaryContent = `${summaryContent}\n\n---\nEarlier context (condensed):\n${condensedPrevious}`;
        break;
      }
    }

    // Add summary as user message (critical for LLM APIs that require user messages)
    compressedMessages.push({
      role: 'user',
      content: buildContinuationSummaryMessage(summaryContent),
    });

    // Add assistant acknowledgment to maintain message alternation
    compressedMessages.push({
      role: 'assistant',
      content: buildSummaryAcknowledgement(),
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
