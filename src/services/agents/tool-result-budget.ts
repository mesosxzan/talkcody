/**
 * Tool result budget management and large result persistence.
 *
 * Inspired by cc-haha's approach:
 * - Per-tool maxResultSizeChars declaration
 * - Large results persisted to disk, replaced with preview in conversation
 * - Message-level aggregate budget across all tool results in a single message
 * - ContentReplacementState for cross-turn consistency (stable prompt cache)
 *
 * This prevents large tool outputs (e.g., reading a 50K-line file) from
 * consuming the entire context window and forcing premature compaction.
 */

import { dirname, join } from '@tauri-apps/api/path';
import { mkdir, writeTextFile } from '@tauri-apps/plugin-fs';
import { logger } from '@/lib/logger';
import type { ToolWithUI } from '@/types/tool';

// === Configuration ===

/** Maximum total tool result characters per message across all tools */
const MESSAGE_LEVEL_BUDGET = 200000;

/** Characters to show in the preview when a result is persisted */
const PREVIEW_LENGTH = 500;

/** Maximum number of preview lines */
const PREVIEW_MAX_LINES = 20;

/** Directory for persisted tool results */
const PERSISTED_RESULTS_DIR = '.talkcody/persisted-results';

// === Content Replacement State ===

/**
 * Tracks which tool results have been replaced with previews.
 * This state is maintained across turns so that the AI can consistently
 * reference persisted results without re-reading them.
 *
 * The key insight from cc-haha: once a decision is made to persist a result,
 * it should remain persisted for the entire conversation to preserve prompt
 * cache stability. Flipping between persisted/inline would break caching.
 */
interface ContentReplacement {
  /** The tool call ID that produced this result */
  toolCallId: string;
  /** The path where the full result is persisted */
  persistedPath: string;
  /** The preview text shown to the AI */
  previewText: string;
  /** Original result size in characters */
  originalSize: number;
  /** Turn number when this was first persisted */
  persistedAtTurn: number;
}

export class ContentReplacementState {
  private replacements = new Map<string, ContentReplacement>();
  #currentTurn = 0;

  /**
   * Advance to a new turn (called at the start of each agent loop iteration)
   */
  advanceTurn(): void {
    this.#currentTurn++;
  }

  /**
   * Check if a tool result has already been persisted
   */
  hasReplacement(toolCallId: string): boolean {
    return this.replacements.has(toolCallId);
  }

  /**
   * Get the replacement info for a previously persisted result
   */
  getReplacement(toolCallId: string): ContentReplacement | undefined {
    return this.replacements.get(toolCallId);
  }

  /**
   * Record a new content replacement
   */
  recordReplacement(replacement: ContentReplacement): void {
    this.replacements.set(replacement.toolCallId, replacement);
  }

  /**
   * Get all current replacements (for serialization/deserialization)
   */
  getAllReplacements(): ContentReplacement[] {
    return Array.from(this.replacements.values());
  }

  /**
   * Clear all replacements (e.g., on conversation reset)
   */
  clear(): void {
    this.replacements.clear();
    this.#currentTurn = 0;
  }
}

// === Result Budget Calculator ===

/**
 * Tracks the total result size for a single message to enforce
 * the message-level budget.
 */
export class MessageResultBudget {
  private totalChars = 0;
  private readonly budget: number;

  constructor(budget: number = MESSAGE_LEVEL_BUDGET) {
    this.budget = budget;
  }

  /**
   * Check if adding a result of the given size would exceed the budget.
   */
  wouldExceedBudget(additionalChars: number): boolean {
    return this.totalChars + additionalChars > this.budget;
  }

  /**
   * Record that a result of the given size was added.
   */
  recordResult(chars: number): void {
    this.totalChars += chars;
  }

  /**
   * Get the remaining budget in characters.
   */
  remainingBudget(): number {
    return Math.max(0, this.budget - this.totalChars);
  }

  /**
   * Reset the budget for a new message.
   */
  reset(): void {
    this.totalChars = 0;
  }
}

// === Tool Result Persistence ===

/**
 * Persist a large tool result to disk and return a preview.
 *
 * @param taskId The task/conversation ID
 * @param toolCallId The tool call ID
 * @param content The full content to persist
 * @param rootPath The workspace root path
 * @returns The preview text to show the AI, plus the path to the persisted file
 */
export async function persistToolResult(
  taskId: string,
  toolCallId: string,
  content: string,
  rootPath: string
): Promise<{ previewText: string; persistedPath: string }> {
  const resultsDir = await join(rootPath, PERSISTED_RESULTS_DIR, taskId);
  const fileName = `${toolCallId}.txt`;
  const persistedPath = await join(resultsDir, fileName);

  try {
    // Ensure directory exists
    await mkdir(await dirname(persistedPath), { recursive: true });

    // Write full content to disk
    await writeTextFile(persistedPath, content);

    // Generate preview
    const previewText = generatePreview(content, persistedPath);

    logger.info(`Persisted tool result to ${persistedPath} (${content.length} chars)`, {
      taskId,
      toolCallId,
    });

    return { previewText, persistedPath };
  } catch (error) {
    logger.error(`Failed to persist tool result: ${persistedPath}`, error);
    // Fallback: truncate the content inline
    const truncated = content.substring(0, PREVIEW_LENGTH);
    return {
      previewText: truncated + '\n\n[Result too large to display, persistence failed]',
      persistedPath: '',
    };
  }
}

/**
 * Generate a preview of a large tool result.
 */
function generatePreview(content: string, persistedPath: string): string {
  const lines = content.split('\n');
  const totalLines = lines.length;
  const totalChars = content.length;

  // Take the first N lines
  const previewLines = lines.slice(0, PREVIEW_MAX_LINES);
  const preview = previewLines.join('\n');

  // Truncate if still too long
  let previewText: string;
  if (preview.length > PREVIEW_LENGTH) {
    previewText = preview.substring(0, PREVIEW_LENGTH);
  } else {
    previewText = preview;
  }

  // Add summary footer
  const footer = [
    '',
    `<persisted-output>`,
    `Full output saved to: ${persistedPath}`,
    `Total: ${totalLines} lines, ${totalChars} characters`,
    `Use the Read tool to view the full output if needed.`,
    `</persisted-output>`,
  ].join('\n');

  return previewText + footer;
}

/**
 * Clean up persisted results for a task.
 * Should be called when a conversation ends.
 */
export async function cleanupPersistedResults(taskId: string, rootPath: string): Promise<void> {
  const resultsDir = await join(rootPath, PERSISTED_RESULTS_DIR, taskId);

  try {
    const { remove } = await import('@tauri-apps/plugin-fs');
    await remove(resultsDir, { recursive: true });
  } catch {
    // Directory may not exist or may already be cleaned up
  }
}

// === Apply Tool Result Budget ===

/**
 * Apply the tool result budget to a tool result.
 * If the result exceeds the tool's maxResultSizeChars or the
 * message-level budget, it is persisted to disk and replaced with a preview.
 *
 * @param toolCallId The tool call ID
 * @param toolName The tool name (for logging)
 * @param result The tool result content
 * @param tool The tool definition (for maxResultSizeChars)
 * @param budget The message-level budget tracker
 * @param replacementState The cross-turn replacement state
 * @param taskId The task/conversation ID
 * @param rootPath The workspace root path
 * @returns The result content (possibly replaced with a preview)
 */
export async function applyToolResultBudget(
  toolCallId: string,
  toolName: string,
  result: string,
  tool: ToolWithUI | undefined,
  budget: MessageResultBudget,
  replacementState: ContentReplacementState,
  taskId: string,
  rootPath: string
): Promise<string> {
  // Check if already persisted in a previous turn
  const existingReplacement = replacementState.getReplacement(toolCallId);
  if (existingReplacement) {
    // Return the same preview to preserve prompt cache stability
    budget.recordResult(existingReplacement.previewText.length);
    return existingReplacement.previewText;
  }

  const resultSize = result.length;
  const toolMaxSize = tool?.maxResultSizeChars ?? Infinity;

  // Determine if we need to persist
  const exceedsToolBudget = resultSize > toolMaxSize;
  const exceedsMessageBudget = budget.wouldExceedBudget(resultSize);
  const shouldPersist = exceedsToolBudget || exceedsMessageBudget;

  if (!shouldPersist) {
    budget.recordResult(resultSize);
    return result;
  }

  // Persist the result and return preview
  const { previewText, persistedPath } = await persistToolResult(
    taskId,
    toolCallId,
    result,
    rootPath
  );

  // Record the replacement for cross-turn consistency
  replacementState.recordReplacement({
    toolCallId,
    persistedPath,
    previewText,
    originalSize: resultSize,
    persistedAtTurn: -1, // Will be set by the caller
  });

  budget.recordResult(previewText.length);

  logger.info(
    `Tool result budget applied: ${toolName} result (${resultSize} chars) ` +
      `exceeded ${exceedsToolBudget ? `tool limit (${toolMaxSize})` : `message budget`}, ` +
      `replaced with preview (${previewText.length} chars)`,
    { taskId, toolCallId }
  );

  return previewText;
}
