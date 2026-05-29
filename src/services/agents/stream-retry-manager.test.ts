import { describe, expect, it } from 'vitest';
import {
  StreamRetryManager,
  MAX_STREAM_RETRIES,
  STREAM_RETRY_BACKOFF_MS,
  RetryableStreamError,
  ModelFallbackSwitchError,
} from './stream-retry-manager';

describe('StreamRetryManager', () => {
  const manager = new StreamRetryManager();

  // ── classifyStreamRetry ──────────────────────────────────────

  describe('classifyStreamRetry', () => {
    it('classifies rate limit errors', () => {
      expect(manager.classifyStreamRetry(new Error('rate_limit exceeded'))).toBe(
        'retryable_rate_limit'
      );
      expect(manager.classifyStreamRetry(new Error('Rate limited'))).toBe(
        'retryable_rate_limit'
      );
      expect(manager.classifyStreamRetry(new Error('HTTP 429 Too Many Requests'))).toBe(
        'retryable_rate_limit'
      );
    });

    it('classifies overloaded errors', () => {
      expect(manager.classifyStreamRetry(new Error('overloaded - please retry'))).toBe(
        'retryable_overloaded'
      );
      expect(manager.classifyStreamRetry(new Error('capacity exceeded'))).toBe(
        'retryable_overloaded'
      );
      expect(manager.classifyStreamRetry(new Error('HTTP 529'))).toBe(
        'retryable_overloaded'
      );
    });

    it('classifies server errors', () => {
      expect(manager.classifyStreamRetry(new Error('503 Service Unavailable'))).toBe(
        'retryable_server_error'
      );
      expect(manager.classifyStreamRetry(new Error('server_error'))).toBe(
        'retryable_server_error'
      );
      expect(manager.classifyStreamRetry(new Error('internal_error'))).toBe(
        'retryable_server_error'
      );
      expect(manager.classifyStreamRetry(new Error('service_unavailable'))).toBe(
        'retryable_server_error'
      );
    });

    it('classifies connection errors', () => {
      expect(manager.classifyStreamRetry(new Error('timeout connecting to server'))).toBe(
        'retryable_connection'
      );
      expect(manager.classifyStreamRetry(new Error('connection reset'))).toBe(
        'retryable_connection'
      );
      expect(manager.classifyStreamRetry(new Error('network error'))).toBe(
        'retryable_connection'
      );
    });

    it('returns non_retryable for unknown errors', () => {
      expect(manager.classifyStreamRetry(new Error('something went wrong'))).toBe(
        'non_retryable'
      );
      expect(manager.classifyStreamRetry(new Error('invalid API key'))).toBe(
        'non_retryable'
      );
    });

    it('handles non-Error inputs', () => {
      expect(manager.classifyStreamRetry('rate_limit')).toBe('retryable_rate_limit');
      expect(manager.classifyStreamRetry('timeout')).toBe('retryable_connection');
      expect(manager.classifyStreamRetry('generic failure')).toBe('non_retryable');
    });

    it('handles non-string non-Error inputs', () => {
      // Number 429 is stringified to "429" which matches the rate limit hint
      expect(manager.classifyStreamRetry(429)).toBe('retryable_rate_limit');
      // Number 503 is stringified to "503" which matches server error hint
      expect(manager.classifyStreamRetry(503)).toBe('retryable_server_error');
      // Number 500 stringifies to "500" which does not match any retryable hint
      expect(manager.classifyStreamRetry(500)).toBe('non_retryable');
      expect(manager.classifyStreamRetry(null)).toBe('non_retryable');
      expect(manager.classifyStreamRetry(undefined)).toBe('non_retryable');
      expect(manager.classifyStreamRetry({})).toBe('non_retryable');
    });
  });

  // ── isAbortError ─────────────────────────────────────────────

  describe('isAbortError', () => {
    it('returns true for DOMException with name AbortError', () => {
      const error = new DOMException('The operation was aborted', 'AbortError');
      expect(manager.isAbortError(error)).toBe(true);
    });

    it('returns true for Error with name AbortError', () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      expect(manager.isAbortError(error)).toBe(true);
    });

    it('returns false for regular errors', () => {
      expect(manager.isAbortError(new Error('Something else'))).toBe(false);
    });

    it('returns false for non-Error values', () => {
      expect(manager.isAbortError('AbortError')).toBe(false);
      expect(manager.isAbortError(null)).toBe(false);
      expect(manager.isAbortError(undefined)).toBe(false);
    });

    it('returns false for DOMException with a different name', () => {
      const error = new DOMException('Not found', 'NotFoundError');
      expect(manager.isAbortError(error)).toBe(false);
    });
  });

  // ── hasVisibleStreamOutput ───────────────────────────────────

  describe('hasVisibleStreamOutput', () => {
    it('returns true when chunks contain text with visible characters', () => {
      const chunks = [{ type: 'text', text: 'Hello world' }];
      expect(manager.hasVisibleStreamOutput(chunks)).toBe(true);
    });

    it('returns true when chunks use content field instead of text', () => {
      const chunks = [{ type: 'text', content: 'Response content' }];
      expect(manager.hasVisibleStreamOutput(chunks)).toBe(true);
    });

    it('returns false for empty string text', () => {
      const chunks = [{ type: 'text', text: '' }];
      expect(manager.hasVisibleStreamOutput(chunks)).toBe(false);
    });

    it('returns false for whitespace-only text', () => {
      const chunks = [{ type: 'text', text: '   \n\t  ' }];
      expect(manager.hasVisibleStreamOutput(chunks)).toBe(false);
    });

    it('returns false when chunks have no text or content fields', () => {
      const chunks = [{ type: 'tool-call' }];
      expect(manager.hasVisibleStreamOutput(chunks)).toBe(false);
    });

    it('returns false for an empty array', () => {
      expect(manager.hasVisibleStreamOutput([])).toBe(false);
    });

    it('returns true if any chunk has visible text', () => {
      const chunks = [
        { type: 'tool-call' },
        { type: 'text', text: '' },
        { type: 'text', text: 'visible' },
      ];
      expect(manager.hasVisibleStreamOutput(chunks)).toBe(true);
    });
  });

  // ── calculateBackoff ─────────────────────────────────────────

  describe('calculateBackoff', () => {
    it('returns base backoff for attempt 1', () => {
      expect(manager.calculateBackoff(1)).toBe(STREAM_RETRY_BACKOFF_MS);
    });

    it('doubles the backoff for each subsequent attempt', () => {
      expect(manager.calculateBackoff(1)).toBe(1000);
      expect(manager.calculateBackoff(2)).toBe(2000);
      expect(manager.calculateBackoff(3)).toBe(4000);
    });

    it('continues exponential growth for higher attempts', () => {
      expect(manager.calculateBackoff(4)).toBe(8000);
      expect(manager.calculateBackoff(5)).toBe(16000);
    });
  });

  // ── evaluateRetryOutcome ─────────────────────────────────────

  describe('evaluateRetryOutcome', () => {
    it('returns non_retryable for non-retryable errors', () => {
      const result = manager.evaluateRetryOutcome(
        new Error('invalid API key'),
        1,
        true,
        'gpt-4',
        []
      );
      expect(result.type).toBe('non_retryable');
      if (result.type === 'non_retryable') {
        expect(result.reason).toContain('Non-retryable error');
      }
    });

    it('returns exhausted when max retries are exceeded', () => {
      const result = manager.evaluateRetryOutcome(
        new Error('rate_limit'),
        MAX_STREAM_RETRIES,
        true,
        'gpt-4',
        []
      );
      expect(result.type).toBe('exhausted');
      if (result.type === 'exhausted') {
        expect(result.reason).toContain(`Max retries (${MAX_STREAM_RETRIES})`);
      }
    });

    it('returns model_fallback for rate limit when preferSameModel is false and fallbacks exist', () => {
      const result = manager.evaluateRetryOutcome(
        new Error('rate_limit'),
        1,
        false,
        'gpt-4',
        ['claude-sonnet']
      );
      expect(result.type).toBe('model_fallback');
      if (result.type === 'model_fallback') {
        expect(result.fromModel).toBe('gpt-4');
        expect(result.toModel).toBe('claude-sonnet');
      }
    });

    it('returns model_fallback for overloaded when preferSameModel is false and fallbacks exist', () => {
      const result = manager.evaluateRetryOutcome(
        new Error('overloaded'),
        1,
        false,
        'gpt-4',
        ['claude-sonnet']
      );
      expect(result.type).toBe('model_fallback');
      if (result.type === 'model_fallback') {
        expect(result.fromModel).toBe('gpt-4');
        expect(result.toModel).toBe('claude-sonnet');
      }
    });

    it('does not fall back when preferSameModel is true', () => {
      const result = manager.evaluateRetryOutcome(
        new Error('rate_limit'),
        1,
        true,
        'gpt-4',
        ['claude-sonnet']
      );
      expect(result.type).toBe('retry');
    });

    it('does not fall back when there are no fallback models', () => {
      const result = manager.evaluateRetryOutcome(
        new Error('rate_limit'),
        1,
        false,
        'gpt-4',
        []
      );
      expect(result.type).toBe('retry');
    });

    it('returns retry with exponential backoff for retryable errors', () => {
      const result = manager.evaluateRetryOutcome(
        new Error('timeout'),
        1,
        true,
        'gpt-4',
        []
      );
      expect(result.type).toBe('retry');
      if (result.type === 'retry') {
        expect(result.backoffMs).toBe(STREAM_RETRY_BACKOFF_MS);
        expect(result.attempt).toBe(2);
        expect(result.reason).toContain('retryable_connection');
      }
    });

    it('increases backoff on subsequent attempts', () => {
      const result = manager.evaluateRetryOutcome(
        new Error('timeout'),
        2,
        true,
        'gpt-4',
        []
      );
      expect(result.type).toBe('retry');
      if (result.type === 'retry') {
        expect(result.backoffMs).toBe(STREAM_RETRY_BACKOFF_MS * 2);
        expect(result.attempt).toBe(3);
      }
    });

    it('returns retry for server errors when under max retries', () => {
      const result = manager.evaluateRetryOutcome(
        new Error('503'),
        2,
        true,
        'gpt-4',
        []
      );
      expect(result.type).toBe('retry');
      if (result.type === 'retry') {
        expect(result.attempt).toBe(3);
      }
    });
  });

  // ── Exported constants ───────────────────────────────────────

  describe('exported constants', () => {
    it('MAX_STREAM_RETRIES is 3', () => {
      expect(MAX_STREAM_RETRIES).toBe(3);
    });

    it('STREAM_RETRY_BACKOFF_MS is 1000', () => {
      expect(STREAM_RETRY_BACKOFF_MS).toBe(1000);
    });
  });

  // ── Error classes ────────────────────────────────────────────

  describe('RetryableStreamError', () => {
    it('stores statusCode and providerMessage', () => {
      const error = new RetryableStreamError('retry later', 429, 'rate limited');
      expect(error.message).toBe('retry later');
      expect(error.name).toBe('RetryableStreamError');
      expect(error.statusCode).toBe(429);
      expect(error.providerMessage).toBe('rate limited');
    });

    it('allows optional statusCode and providerMessage', () => {
      const error = new RetryableStreamError('retry later');
      expect(error.statusCode).toBeUndefined();
      expect(error.providerMessage).toBeUndefined();
    });
  });

  describe('ModelFallbackSwitchError', () => {
    it('stores fromModel and toModel', () => {
      const error = new ModelFallbackSwitchError('switching', 'gpt-4', 'claude-sonnet');
      expect(error.message).toBe('switching');
      expect(error.name).toBe('ModelFallbackSwitchError');
      expect(error.fromModel).toBe('gpt-4');
      expect(error.toModel).toBe('claude-sonnet');
    });
  });
});
