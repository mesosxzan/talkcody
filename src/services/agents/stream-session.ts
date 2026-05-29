/**
 * Stream session manager - handles a single LLM streaming session.
 * Extracted from LLMService.runAgentLoop to separate stream processing
 * concerns (retry, fallback, error classification) from the agent loop logic.
 *
 * Inspired by cc-haha's QueryEngine pattern where stream management
 * is a distinct concern from agent orchestration.
 */

import { isContextLengthExceededError } from '@/lib/error-utils';
import { logger } from '@/lib/logger';

// === Error Types ===

export type StreamRetryCategory = 'openrouter-stream' | 'network' | 'server';

export interface StreamRetryDecision {
  retryable: boolean;
  category?: StreamRetryCategory;
  reason: string;
  status?: number;
  hasVisibleOutput: boolean;
  preferRetryBeforeModelFallback?: boolean;
}

export class RetryableStreamError extends Error {
  readonly decision: StreamRetryDecision;

  constructor(decision: StreamRetryDecision) {
    super(decision.reason);
    this.name = 'RetryableStreamError';
    this.decision = decision;
  }
}

export class ModelFallbackSwitchError extends Error {
  readonly nextModel: string;
  readonly reason: string;

  constructor(nextModel: string, reason: string) {
    super(reason);
    this.name = 'ModelFallbackSwitchError';
    this.nextModel = nextModel;
    this.reason = reason;
  }
}

// === Retry Classification ===

const RETRYABLE_NETWORK_HINTS = [
  'load failed',
  'network',
  'timeout',
  'timed out',
  'connection reset',
  'connection refused',
  'upstream connect error',
  'disconnect/reset',
  'reset before headers',
  'fetch failed',
  'econnreset',
  'econnrefused',
  'enotfound',
  'eai_again',
] as const;

const RETRYABLE_PROVIDER_PROCESSING_HINTS = [
  'an error occurred while processing your request',
  'retry your request',
] as const;

const RETRYABLE_PROVIDER_OVERLOAD_HINT = 'our servers are currently overloaded';

/**
 * Classify a stream error to determine if it's retryable and what category it falls into.
 */
export function classifyStreamRetry(
  error: unknown,
  _model: string,
  _iteration: number,
  hasVisibleOutput: boolean
): StreamRetryDecision {
  const errorObj = error instanceof Error ? error : new Error(String(error));
  const message = errorObj.message.toLowerCase();

  // Check for OpenRouter stream errors
  if (
    message.includes('openrouter') &&
    (message.includes('stream') || message.includes('timeout'))
  ) {
    return {
      retryable: true,
      category: 'openrouter-stream',
      reason: `OpenRouter stream error: ${errorObj.message}`,
      hasVisibleOutput,
      preferRetryBeforeModelFallback: true,
    };
  }

  // Check for network errors
  for (const hint of RETRYABLE_NETWORK_HINTS) {
    if (message.includes(hint)) {
      return {
        retryable: true,
        category: 'network',
        reason: `Network error (${hint}): ${errorObj.message}`,
        hasVisibleOutput,
      };
    }
  }

  // Check for server/provider errors
  for (const hint of RETRYABLE_PROVIDER_PROCESSING_HINTS) {
    if (message.includes(hint)) {
      return {
        retryable: true,
        category: 'server',
        reason: `Server error: ${errorObj.message}`,
        hasVisibleOutput,
        preferRetryBeforeModelFallback: true,
      };
    }
  }

  if (message.includes(RETRYABLE_PROVIDER_OVERLOAD_HINT)) {
    return {
      retryable: true,
      category: 'server',
      reason: `Server overloaded: ${errorObj.message}`,
      hasVisibleOutput,
      preferRetryBeforeModelFallback: true,
    };
  }

  // HTTP status-based classification
  const status = extractHttpStatus(message);
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return {
      retryable: true,
      category: 'server',
      reason: `HTTP ${status} error: ${errorObj.message}`,
      status,
      hasVisibleOutput,
      preferRetryBeforeModelFallback: status !== 429,
    };
  }

  // Not retryable
  return {
    retryable: false,
    reason: `Non-retryable error: ${errorObj.message}`,
    hasVisibleOutput,
  };
}

function extractHttpStatus(message: string): number | undefined {
  const match = message.match(/http(?:\s+error)?\s+(\d{3})/i);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// === Stream Session State ===

export interface StreamSessionConfig {
  maxRetries: number;
  retryBackoffMs: readonly number[];
  model: string;
  fallbackModels: string[];
  iteration: number;
}

export interface StreamSessionResult {
  /** Whether the stream completed successfully */
  success: boolean;
  /** Whether context-length-exceeded was detected */
  contextLengthExceeded: boolean;
  /** Whether a model fallback occurred */
  modelFallback: boolean;
  /** The new model if a fallback occurred */
  fallbackModel?: string;
  /** Whether a transport fallback occurred */
  transportFallback: boolean;
  /** Number of retries attempted */
  retryCount: number;
  /** Error if the session failed */
  error?: Error;
}

/**
 * Manages a single LLM stream session with retry and fallback logic.
 * This class is responsible for:
 * - Tracking retry state
 * - Classifying errors for retry/fallback decisions
 * - Computing backoff delays
 * - Detecting when to switch to fallback models
 */
export class StreamSessionManager {
  private retryCount = 0;
  private currentModel: string;
  private fallbackModels: string[];

  constructor(config: StreamSessionConfig) {
    this.currentModel = config.model;
    this.fallbackModels = [...config.fallbackModels];
  }

  /**
   * Get the current active model (may have changed due to fallback)
   */
  getActiveModel(): string {
    return this.currentModel;
  }

  /**
   * Get the current retry count
   */
  getRetryCount(): number {
    return this.retryCount;
  }

  /**
   * Compute the backoff delay for the current retry
   */
  getBackoffMs(config: StreamSessionConfig): number {
    const index = Math.min(this.retryCount, config.retryBackoffMs.length - 1);
    return config.retryBackoffMs[index] ?? 1000;
  }

  /**
   * Handle a stream error - classify and decide retry vs fallback.
   * Returns the decision or throws if the error is not recoverable.
   */
  handleStreamError(
    error: unknown,
    config: StreamSessionConfig,
    hasVisibleOutput: boolean
  ): { action: 'retry' | 'fallback' | 'abort'; decision: StreamRetryDecision; nextModel?: string } {
    const decision = classifyStreamRetry(
      error,
      this.currentModel,
      config.iteration,
      hasVisibleOutput
    );

    // Context length exceeded - not retryable
    if (isContextLengthExceededError(error)) {
      return { action: 'abort', decision };
    }

    // Not retryable at all
    if (!decision.retryable) {
      return { action: 'abort', decision };
    }

    // If no visible output and fallback models available, prefer fallback
    if (
      !hasVisibleOutput &&
      this.fallbackModels.length > 0 &&
      !decision.preferRetryBeforeModelFallback
    ) {
      const nextModel = this.fallbackModels[0];
      return { action: 'fallback', decision, nextModel };
    }

    // Check if we've exhausted retries
    if (this.retryCount >= config.maxRetries) {
      // If we still have fallback models, try them
      if (this.fallbackModels.length > 0) {
        const nextModel = this.fallbackModels[0];
        return { action: 'fallback', decision, nextModel };
      }
      return { action: 'abort', decision };
    }

    // Retry with same model
    this.retryCount++;
    return { action: 'retry', decision };
  }

  /**
   * Switch to a fallback model
   */
  switchToFallback(nextModel: string): void {
    // Remove the model we're switching from fallback list
    this.fallbackModels = this.fallbackModels.filter((m) => m !== nextModel);
    this.currentModel = nextModel;
    this.retryCount = 0;

    logger.info(`[StreamSession] Switched to fallback model: ${nextModel}`, {
      remainingFallbacks: this.fallbackModels.length,
    });
  }

  /**
   * Reset retry count (e.g., after a successful stream)
   */
  resetRetries(): void {
    this.retryCount = 0;
  }
}
