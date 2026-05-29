// src/services/agents/stream-retry-manager.ts

/**
 * Manages retry decisions and error classification for the LLM streaming loop.
 * Extracted from LLMService to isolate retry logic from the core agent loop.
 */

// ── Constants ──────────────────────────────────────────────────

export const MAX_STREAM_RETRIES = 3;
export const STREAM_RETRY_BACKOFF_MS = 1000;

// Retryable error hints from various providers
const RETRYABLE_HINTS = [
  'rate_limit',
  'overloaded',
  'capacity',
  'timeout',
  'connection',
  'network',
  '529',
  '503',
  '429',
  'server_error',
  'internal_error',
  'service_unavailable',
];

// ── Error Classes ──────────────────────────────────────────────

export class RetryableStreamError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly providerMessage?: string
  ) {
    super(message);
    this.name = 'RetryableStreamError';
  }
}

export class ModelFallbackSwitchError extends Error {
  constructor(
    message: string,
    public readonly fromModel: string,
    public readonly toModel: string
  ) {
    super(message);
    this.name = 'ModelFallbackSwitchError';
  }
}

// ── Types ──────────────────────────────────────────────────────

export type StreamRetryCategory =
  | 'retryable_rate_limit'
  | 'retryable_server_error'
  | 'retryable_connection'
  | 'retryable_overloaded'
  | 'non_retryable';

export type RetryDecision =
  | { action: 'retry'; backoffMs: number; attempt: number; reason: string }
  | { action: 'fallback_model'; reason: string }
  | { action: 'fail'; reason: string };

export type RetryOutcome =
  | { type: 'retry'; backoffMs: number; attempt: number; reason: string }
  | { type: 'model_fallback'; fromModel: string; toModel: string; reason: string }
  | { type: 'exhausted'; reason: string }
  | { type: 'non_retryable'; reason: string };

// ── Manager ────────────────────────────────────────────────────

export class StreamRetryManager {
  /**
   * Classify an error to determine if it's retryable.
   */
  classifyStreamRetry(error: unknown): StreamRetryCategory {
    const message = error instanceof Error ? error.message : String(error).toLowerCase();
    const lowerMessage = message.toLowerCase();

    // Check for rate limiting
    if (
      lowerMessage.includes('rate') ||
      lowerMessage.includes('429') ||
      lowerMessage.includes('rate_limit')
    ) {
      return 'retryable_rate_limit';
    }

    // Check for overloaded
    if (
      lowerMessage.includes('overloaded') ||
      lowerMessage.includes('capacity') ||
      lowerMessage.includes('529')
    ) {
      return 'retryable_overloaded';
    }

    // Check for server errors
    if (
      lowerMessage.includes('503') ||
      lowerMessage.includes('server_error') ||
      lowerMessage.includes('internal_error') ||
      lowerMessage.includes('service_unavailable')
    ) {
      return 'retryable_server_error';
    }

    // Check for connection issues
    if (
      lowerMessage.includes('timeout') ||
      lowerMessage.includes('connection') ||
      lowerMessage.includes('network')
    ) {
      return 'retryable_connection';
    }

    // Check against retryable hints
    for (const hint of RETRYABLE_HINTS) {
      if (lowerMessage.includes(hint)) {
        return 'retryable_server_error';
      }
    }

    return 'non_retryable';
  }

  /**
   * Extract HTTP status code from an error message.
   */
  extractHttpStatusFromMessage(error: unknown): number | null {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/\b(\d{3})\b/);
    return match?.[1] ? parseInt(match[1], 10) : null;
  }

  /**
   * Check if a provider transient error is retryable.
   */
  isRetryableProviderTransientError(error: unknown): boolean {
    const category = this.classifyStreamRetry(error);
    return category !== 'non_retryable';
  }

  /**
   * Build a formatted error message when retries are exhausted.
   */
  buildRetryExhaustedError(error: unknown, attempts: number, category: StreamRetryCategory): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(
      `Stream retry exhausted after ${attempts} attempts (category: ${category}): ${message}`
    );
  }

  /**
   * Check if the error is an abort error.
   */
  isAbortError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'AbortError') return true;
    if (error instanceof Error && error.name === 'AbortError') return true;
    return false;
  }

  /**
   * Check if the stream has already produced visible output before the error.
   */
  hasVisibleStreamOutput(
    chunks: Array<{ type: string; text?: string; content?: string }>
  ): boolean {
    return chunks.some((chunk) => {
      const text = chunk.text ?? chunk.content ?? '';
      return text.trim().length > 0;
    });
  }

  /**
   * Evaluate the outcome of a retry decision.
   * This unifies the two previously duplicated retry paths in runAgentLoop.
   *
   * @param error - The stream error
   * @param attempt - Current attempt number (1-based)
   * @param preferSameModel - Whether to try the same model first
   * @param activeModel - Currently active model
   * @param fallbackModels - Available fallback models
   */
  evaluateRetryOutcome(
    error: unknown,
    attempt: number,
    preferSameModel: boolean,
    activeModel: string,
    fallbackModels: string[]
  ): RetryOutcome {
    const category = this.classifyStreamRetry(error);

    if (category === 'non_retryable') {
      return {
        type: 'non_retryable',
        reason: `Non-retryable error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (attempt >= MAX_STREAM_RETRIES) {
      return {
        type: 'exhausted',
        reason: `Max retries (${MAX_STREAM_RETRIES}) exceeded for category: ${category}`,
      };
    }

    // For rate limits, try fallback model first if available
    if (category === 'retryable_rate_limit' || category === 'retryable_overloaded') {
      if (!preferSameModel && fallbackModels.length > 0) {
        const nextModel = fallbackModels[0]!;
        return {
          type: 'model_fallback',
          fromModel: activeModel,
          toModel: nextModel,
          reason: `${category}: switching from ${activeModel} to ${nextModel}`,
        };
      }
    }

    // Default: retry same model with exponential backoff
    const backoffMs = STREAM_RETRY_BACKOFF_MS * 2 ** (attempt - 1);
    return {
      type: 'retry',
      backoffMs,
      attempt: attempt + 1,
      reason: `Retryable error (${category}): attempt ${attempt + 1}/${MAX_STREAM_RETRIES}`,
    };
  }

  /**
   * Calculate backoff delay for a given attempt.
   */
  calculateBackoff(attempt: number): number {
    return STREAM_RETRY_BACKOFF_MS * 2 ** (attempt - 1);
  }
}
