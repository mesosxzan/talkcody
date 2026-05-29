/**
 * Streaming tool executor - processes tool calls as they stream in,
 * rather than waiting for the entire response to complete.
 *
 * Inspired by cc-haha's StreamingToolExecutor:
 * - Tools start executing as soon as their content_block_stop event arrives
 * - Concurrency-safe tools run in parallel; non-safe tools run serially
 * - Bash errors cascade to sibling tools (cancel them)
 * - Results are yielded in tool-receive order
 * - Progress messages are yielded immediately for UI updates
 * - Discard mode for streaming fallback
 */

import { logger } from '@/lib/logger';
import type { ToolExecuteContext, ToolWithUI } from '@/types/tool';

// === Types ===

export interface StreamingToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface StreamingToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  duration: number;
  error?: boolean;
}

export type TrackedToolStatus = 'queued' | 'executing' | 'completed' | 'cancelled';

interface TrackedTool {
  toolCall: StreamingToolCall;
  tool: ToolWithUI;
  status: TrackedToolStatus;
  result?: unknown;
  error?: boolean;
  startTime?: number;
  duration?: number;
  abortController?: AbortController;
}

// === Streaming Tool Executor ===

export class StreamingToolExecutor {
  private trackedTools = new Map<string, TrackedTool>();
  private completedResults: StreamingToolResult[] = [];
  private executingCount = 0;
  private discarded = false;
  private siblingAbortController = new AbortController();
  private onResult?: (result: StreamingToolResult) => void;
  private onProgress?: (toolCallId: string, status: TrackedToolStatus) => void;

  constructor(options?: {
    onResult?: (result: StreamingToolResult) => void;
    onProgress?: (toolCallId: string, status: TrackedToolStatus) => void;
  }) {
    this.siblingAbortController = new AbortController();
    this.onResult = options?.onResult;
    this.onProgress = options?.onProgress;
  }

  /**
   * Add a tool call to the executor as it streams in.
   * If the tool is concurrency-safe and all currently executing tools are
   * also safe, the new tool starts executing immediately in parallel.
   * Otherwise, it is queued for sequential execution.
   */
  async addTool(
    toolCall: StreamingToolCall,
    tool: ToolWithUI,
    executeContext: ToolExecuteContext
  ): Promise<void> {
    if (this.discarded) {
      logger.info(`[StreamingToolExecutor] Discarded, not adding tool ${toolCall.toolName}`);
      return;
    }

    const tracked: TrackedTool = {
      toolCall,
      tool,
      status: 'queued',
      abortController: new AbortController(),
    };

    this.trackedTools.set(toolCall.toolCallId, tracked);

    // Check if we can start executing immediately
    if (this.canExecuteTool(tool)) {
      await this.startExecution(tracked, executeContext);
    }
    // Otherwise, it stays queued and will be started when current tools finish
  }

  /**
   * Check if a new tool can start executing now.
   * A tool can execute if:
   * - All currently executing tools are concurrency-safe, AND
   * - The new tool is also concurrency-safe
   */
  private canExecuteTool(tool: ToolWithUI): boolean {
    if (this.executingCount === 0) {
      return true; // No tools executing, can start
    }

    // Check if all executing tools are concurrency-safe
    for (const tracked of this.trackedTools.values()) {
      if (tracked.status === 'executing' && !tracked.tool.isConcurrencySafe) {
        return false; // A non-safe tool is executing, must wait
      }
    }

    // All executing tools are safe - can we join them?
    return tool.isConcurrencySafe;
  }

  /**
   * Start executing a tracked tool.
   */
  private async startExecution(
    tracked: TrackedTool,
    executeContext: ToolExecuteContext
  ): Promise<void> {
    tracked.status = 'executing';
    tracked.startTime = Date.now();
    this.executingCount++;

    this.onProgress?.(tracked.toolCall.toolCallId, 'executing');

    try {
      // Execute the tool
      const result = await tracked.tool.execute(
        tracked.toolCall.input as Record<string, unknown>,
        executeContext
      );

      tracked.result = result;
      tracked.status = 'completed';
      tracked.duration = Date.now() - (tracked.startTime ?? Date.now());

      const streamingResult: StreamingToolResult = {
        toolCallId: tracked.toolCall.toolCallId,
        toolName: tracked.toolCall.toolName,
        result,
        duration: tracked.duration,
      };

      this.completedResults.push(streamingResult);
      this.onResult?.(streamingResult);
      this.onProgress?.(tracked.toolCall.toolCallId, 'completed');
    } catch (error) {
      tracked.result = error;
      tracked.error = true;
      tracked.status = 'completed';
      tracked.duration = Date.now() - (tracked.startTime ?? Date.now());

      const streamingResult: StreamingToolResult = {
        toolCallId: tracked.toolCall.toolCallId,
        toolName: tracked.toolCall.toolName,
        result: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        duration: tracked.duration,
        error: true,
      };

      this.completedResults.push(streamingResult);
      this.onResult?.(streamingResult);
      this.onProgress?.(tracked.toolCall.toolCallId, 'completed');

      // Bash errors cascade to sibling tools
      if (tracked.toolCall.toolName === 'bash') {
        this.cancelSiblings(tracked.toolCall.toolCallId);
      }
    } finally {
      this.executingCount--;

      // Start queued tools that can now execute
      await this.startQueuedTools(executeContext);
    }
  }

  /**
   * Start any queued tools that can now execute.
   */
  private async startQueuedTools(executeContext: ToolExecuteContext): Promise<void> {
    for (const tracked of this.trackedTools.values()) {
      if (tracked.status === 'queued' && this.canExecuteTool(tracked.tool)) {
        await this.startExecution(tracked, executeContext);
        // Only start one at a time to avoid over-parallelism
        // The next queued tool will be checked after this one completes
        break;
      }
    }
  }

  /**
   * Cancel all sibling tools when a Bash command errors.
   * This prevents parallel tools from continuing with potentially
   * inconsistent state.
   */
  private cancelSiblings(failedToolCallId: string): void {
    logger.info(`[StreamingToolExecutor] Bash error, cancelling sibling tools`);

    // Abort the sibling controller
    this.siblingAbortController.abort('sibling_error');

    // Cancel all executing tools except the one that failed
    for (const tracked of this.trackedTools.values()) {
      if (tracked.toolCall.toolCallId !== failedToolCallId && tracked.status === 'executing') {
        tracked.abortController?.abort(`Cancelled: parallel tool call bash errored`);
        tracked.status = 'cancelled';

        const cancelResult: StreamingToolResult = {
          toolCallId: tracked.toolCall.toolCallId,
          toolName: tracked.toolCall.toolName,
          result: {
            success: false,
            error: `Cancelled: parallel tool call bash errored`,
          },
          duration: 0,
          error: true,
        };

        this.completedResults.push(cancelResult);
        this.onResult?.(cancelResult);
        this.onProgress?.(tracked.toolCall.toolCallId, 'cancelled');
      }
    }

    // Create a new sibling controller for future tools
    this.siblingAbortController = new AbortController();
  }

  /**
   * Get all completed results in the order they were received.
   */
  getCompletedResults(): StreamingToolResult[] {
    return [...this.completedResults];
  }

  /**
   * Check if all tools have completed (or been cancelled).
   */
  isComplete(): boolean {
    for (const tracked of this.trackedTools.values()) {
      if (tracked.status === 'queued' || tracked.status === 'executing') {
        return false;
      }
    }
    return true;
  }

  /**
   * Wait for all tools to complete.
   */
  async waitForCompletion(): Promise<StreamingToolResult[]> {
    // Simple polling with backoff
    let waitTime = 10;
    while (!this.isComplete()) {
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      waitTime = Math.min(waitTime * 1.5, 100); // Cap at 100ms
    }
    return this.getCompletedResults();
  }

  /**
   * Discard the executor - no new tools will be started,
   * and in-progress tools receive synthetic errors.
   * Used when streaming fallback occurs.
   */
  discard(): void {
    this.discarded = true;
    logger.info('[StreamingToolExecutor] Discarded, cancelling in-progress tools');

    for (const tracked of this.trackedTools.values()) {
      if (tracked.status === 'executing') {
        tracked.abortController?.abort('Streaming fallback');
        tracked.status = 'cancelled';

        const discardResult: StreamingToolResult = {
          toolCallId: tracked.toolCall.toolCallId,
          toolName: tracked.toolCall.toolName,
          result: { success: false, error: 'Streaming fallback' },
          duration: 0,
          error: true,
        };

        this.completedResults.push(discardResult);
        this.onResult?.(discardResult);
      } else if (tracked.status === 'queued') {
        tracked.status = 'cancelled';
      }
    }
  }

  /**
   * Get the count of tools by status.
   */
  getStatusCounts(): { queued: number; executing: number; completed: number; cancelled: number } {
    let queued = 0;
    let executing = 0;
    let completed = 0;
    let cancelled = 0;

    for (const tracked of this.trackedTools.values()) {
      switch (tracked.status) {
        case 'queued':
          queued++;
          break;
        case 'executing':
          executing++;
          break;
        case 'completed':
          completed++;
          break;
        case 'cancelled':
          cancelled++;
          break;
      }
    }

    return { queued, executing, completed, cancelled };
  }
}
