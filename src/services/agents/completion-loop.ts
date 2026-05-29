/**
 * Completion loop manager - handles the iteration logic for the agent loop.
 * Extracted from LLMService.runAgentLoop to separate iteration control
 * (continuation, hooks, iteration limits) from stream processing.
 *
 * Inspired by cc-haha's QueryEngine where the completion loop is a
 * distinct orchestration concern from streaming and tool execution.
 */

import { logger } from '@/lib/logger';
import type { AgentLoopState } from '@/types/agent';

// === Types ===

export interface CompletionLoopConfig {
  /** Maximum number of iterations before forcing stop */
  maxIterations: number;
  /** Whether to enable iteration-limit extension */
  allowIterationExtension: boolean;
  /** Number of iterations to extend when approaching the limit */
  iterationExtensionCount: number;
  /** Whether the loop is a subagent (more constrained) */
  isSubagent: boolean;
}

export interface CompletionLoopResult {
  /** Whether the loop should continue */
  shouldContinue: boolean;
  /** Reason for stopping (if shouldContinue is false) */
  stopReason?: 'max_iterations' | 'user_stop' | 'error' | 'no_tool_calls' | 'completion';
  /** Whether the iteration limit was extended */
  extended?: boolean;
  /** Current iteration number */
  iteration: number;
}

// === Completion Loop Manager ===

export class CompletionLoopManager {
  private config: CompletionLoopConfig;
  private currentIteration = 0;
  private lastStopReason?: string;

  constructor(config: CompletionLoopConfig) {
    this.config = config;
  }

  /**
   * Get the current iteration number
   */
  getIteration(): number {
    return this.currentIteration;
  }

  /**
   * Increment the iteration counter
   */
  incrementIteration(): void {
    this.currentIteration++;
  }

  /**
   * Check if the loop should continue based on the current state.
   *
   * This encapsulates the "should we keep going?" logic that was
   * previously spread across the runAgentLoop method.
   */
  shouldContinue(
    loopState: AgentLoopState,
    hasToolCalls: boolean,
    isAborted: boolean
  ): CompletionLoopResult {
    // Check for user abort
    if (isAborted) {
      return {
        shouldContinue: false,
        stopReason: 'user_stop',
        iteration: this.currentIteration,
      };
    }

    // Check for error state - if the last finish reason was an error, stop
    if (loopState.lastFinishReason === 'error') {
      return {
        shouldContinue: false,
        stopReason: 'error',
        iteration: this.currentIteration,
      };
    }

    // If no tool calls, the assistant finished its response
    if (!hasToolCalls) {
      return {
        shouldContinue: false,
        stopReason: 'completion',
        iteration: this.currentIteration,
      };
    }

    // Check iteration limit
    if (this.currentIteration >= this.config.maxIterations) {
      // Try to extend the limit
      if (this.config.allowIterationExtension) {
        this.config.maxIterations += this.config.iterationExtensionCount;
        logger.info(`[CompletionLoop] Extended iteration limit to ${this.config.maxIterations}`, {
          currentIteration: this.currentIteration,
        });
        return {
          shouldContinue: true,
          extended: true,
          iteration: this.currentIteration,
        };
      }

      return {
        shouldContinue: false,
        stopReason: 'max_iterations',
        iteration: this.currentIteration,
      };
    }

    // Continue the loop
    return {
      shouldContinue: true,
      iteration: this.currentIteration,
    };
  }

  /**
   * Get a summary of the completion loop state for logging.
   */
  getStateSummary(): {
    iteration: number;
    maxIterations: number;
    isSubagent: boolean;
    lastStopReason?: string;
  } {
    return {
      iteration: this.currentIteration,
      maxIterations: this.config.maxIterations,
      isSubagent: this.config.isSubagent,
      lastStopReason: this.lastStopReason,
    };
  }

  /**
   * Record the final stop reason.
   */
  recordStopReason(reason: string): void {
    this.lastStopReason = reason;
  }

  /**
   * Reset the completion loop for reuse.
   */
  reset(): void {
    this.currentIteration = 0;
    this.lastStopReason = undefined;
  }
}

// === Iteration Hooks ===

export interface IterationHookCallbacks {
  /** Called before each iteration starts */
  onIterationStart?: (iteration: number, loopState: AgentLoopState) => void;
  /** Called after each iteration completes */
  onIterationEnd?: (iteration: number, loopState: AgentLoopState, hasToolCalls: boolean) => void;
  /** Called when the loop is about to stop */
  onLoopStopping?: (reason: string, iteration: number) => void;
}

/**
 * Create a default completion loop config based on the task type.
 */
export function createDefaultCompletionLoopConfig(
  isSubagent: boolean = false
): CompletionLoopConfig {
  return {
    maxIterations: isSubagent ? 25 : 50,
    allowIterationExtension: !isSubagent,
    iterationExtensionCount: 10,
    isSubagent,
  };
}
