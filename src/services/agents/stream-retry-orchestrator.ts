// src/services/agents/stream-retry-orchestrator.ts
/**
 * StreamRetryOrchestrator — Unified stream retry logic extracted from LLMService.
 *
 * Responsibilities:
 * - Classify stream errors into retryable / non-retryable categories
 * - Decide between same-model retry vs. model fallback
 * - Execute retries with exponential backoff
 * - Handle Responses Chain session cleanup on retry
 *
 * Previously this logic was duplicated in the error event handler and the
 * catch block of the stream retry loop inside LLMService.runAgentLoop().
 */

import { createErrorContext, extractAndFormatError } from '@/lib/error-utils';
import { logger } from '@/lib/logger';
import { getLocale, type SupportedLocale } from '@/locales';
import { parseModelIdentifier } from '@/providers/core/provider-utils';
import { useSettingsStore } from '@/stores/settings-store';
import type { AgentLoopState } from '@/types/agent';
import { invalidateResponsesChain } from './llm-response-chaining';
import type { LoopStoreAccess } from './loop-store-access';
import type { ResponsesChainManager } from './responses-chain-manager';
import type { StreamProcessor, StreamProcessorState } from './stream-processor';
import { MAX_STREAM_RETRIES } from './stream-retry-manager';

// ── Constants ──────────────────────────────────────────────

export const STREAM_RETRY_BACKOFF_MS = [1000, 2000, 3000] as const;

/** Maximum number of auto-compaction attempts per iteration. */
export const MAX_AUTO_COMPACTIONS = 1;

/** Maximum depth when serializing error cause chains. */
export const MAX_ERROR_CAUSE_CHAIN_DEPTH = 5;

/**
 * Provider-specific backoff multipliers for unknown finish reason retries.
 * Some providers need longer waits before retrying.
 */
export const PROVIDER_BACKOFF_MULTIPLIERS: Record<string, number> = {
  openrouter: 2.0,
  zhipu: 1.5,
  deepseek: 1.5,
};

const DEFAULT_BACKOFF_MULTIPLIER = 1.0;

/**
 * Maximum time (ms) to wait for a stream event before considering the stream stalled.
 * If no event is received within this window, the stream is treated as a network-level
 * failure and retried via the normal retry pipeline.
 */
export const STREAM_STALL_TIMEOUT_MS = 120_000; // 2 minutes

// ── Types ──────────────────────────────────────────────────

export type StreamRetryCategory = 'openrouter-stream' | 'network' | 'server';

export type StreamRetryDecision = {
  retryable: boolean;
  category?: StreamRetryCategory;
  reason: string;
  status?: number;
  hasVisibleOutput: boolean;
  preferRetryBeforeModelFallback?: boolean;
};

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

/** Mutable state tracked across the stream retry loop */
export type StreamRetryState = {
  activeModel: string;
  activeFallbackModels: string[];
  activeProviderId: string | undefined;
  autoCompactionAttempts: number;
};

/** Result of a single retry attempt */
export type StreamRetryAttemptResult = {
  shouldAutoCompact: boolean;
  shouldRetryStateless: boolean;
  shouldRetryFreshWebsocketBaseline: boolean;
  /** If true, the orchestrator decided to promote a fallback model */
  didPromoteFallback: boolean;
};

// ── Orchestrator ───────────────────────────────────────────

export class StreamRetryOrchestrator {
  private readonly taskId: string;
  private readonly isSubagent: boolean;
  private readonly storeAccess: LoopStoreAccess;
  private readonly responsesChainManager: ResponsesChainManager;
  private readonly streamProcessor: StreamProcessor;

  constructor(options: {
    taskId: string;
    isSubagent: boolean;
    storeAccess: LoopStoreAccess;
    responsesChainManager: ResponsesChainManager;
    streamProcessor: StreamProcessor;
  }) {
    this.taskId = options.taskId;
    this.isSubagent = options.isSubagent;
    this.storeAccess = options.storeAccess;
    this.responsesChainManager = options.responsesChainManager;
    this.streamProcessor = options.streamProcessor;
  }

  // ── Error classification ───────────────────────────────

  hasVisibleStreamOutput(state: StreamProcessorState): boolean {
    return (
      state.hasReceivedText || state.reasoningBlocks.some((block) => block.text.trim().length > 0)
    );
  }

  isAbortError(error: unknown): boolean {
    if (
      typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError'
    ) {
      return true;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      return true;
    }

    return false;
  }

  private extractHttpStatusFromMessage(message: string): number | undefined {
    const match = message.match(/http(?:\s+error)?\s+(\d{3})/i);
    if (!match) {
      return undefined;
    }

    const parsed = Number.parseInt(match[1] ?? '', 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private isRetryableProviderTransientError(message: string): boolean {
    const normalizedMessage = message.toLowerCase();
    const isProcessingRequestError =
      normalizedMessage.includes('an error occurred while processing your request') &&
      (normalizedMessage.includes('retry your request') ||
        normalizedMessage.includes('help.openai.com') ||
        normalizedMessage.includes('request id'));
    const isOverloaded = normalizedMessage.includes('our servers are currently overloaded');

    return isProcessingRequestError || isOverloaded;
  }

  classifyStreamRetry(
    error: unknown,
    model: string,
    iteration: number,
    hasVisibleOutput: boolean
  ): StreamRetryDecision {
    const errorContext = createErrorContext(model, {
      iteration,
      phase: 'stream-retry',
    });
    const { errorDetails } = extractAndFormatError(error, errorContext);
    const message = errorDetails.message.toLowerCase();

    if (this.isAbortError(error)) {
      return {
        retryable: false,
        reason: errorDetails.message,
        hasVisibleOutput,
      };
    }

    if (
      errorDetails.name === 'AI_InvalidResponseDataError' &&
      errorDetails.message.includes("Expected 'id' to be a string")
    ) {
      return {
        retryable: !hasVisibleOutput,
        category: 'openrouter-stream',
        reason: errorDetails.message,
        hasVisibleOutput,
      };
    }

    if (this.isRetryableProviderTransientError(errorDetails.message)) {
      return {
        retryable: true,
        category: 'server',
        reason: errorDetails.message,
        hasVisibleOutput,
        preferRetryBeforeModelFallback: true,
      };
    }

    const status =
      typeof errorDetails.status === 'number'
        ? errorDetails.status
        : this.extractHttpStatusFromMessage(errorDetails.message);

    if (typeof status === 'number') {
      if (status >= 500) {
        return {
          retryable: true,
          category: 'server',
          reason: `HTTP ${status}: ${errorDetails.message}`,
          status,
          hasVisibleOutput,
        };
      }

      return {
        retryable: false,
        reason: `HTTP ${status}: ${errorDetails.message}`,
        status,
        hasVisibleOutput,
      };
    }

    const isNetworkError = [
      'timeout',
      'connection',
      'network',
      'econnreset',
      'econnrefused',
      'socket hang up',
      'fetchfailed',
      'fetch error',
      'aborted',
    ].some((hint) => message.includes(hint));
    if (isNetworkError) {
      return {
        retryable: true,
        category: 'network',
        reason: errorDetails.message,
        hasVisibleOutput,
      };
    }

    return {
      retryable: false,
      reason: errorDetails.message,
      hasVisibleOutput,
    };
  }

  // ── Context-length-exceeded handling ────────────────────

  /**
   * Decide whether auto-compaction should be attempted for a context-length error.
   * Returns true if auto-compaction should be triggered, false if all attempts exhausted.
   */
  shouldAutoCompact(state: StreamRetryState): boolean {
    if (state.autoCompactionAttempts < MAX_AUTO_COMPACTIONS) {
      state.autoCompactionAttempts++;
      return true;
    }
    return false;
  }

  // ── Model fallback ──────────────────────────────────────

  /**
   * Promote the first fallback model to active, closing the responses chain session.
   */
  async promoteFallbackModel(
    nextModel: string,
    reason: string,
    loopState: AgentLoopState,
    state: StreamRetryState
  ): Promise<void> {
    const previousModel = state.activeModel;
    state.activeModel = nextModel;
    state.activeFallbackModels = state.activeFallbackModels.filter(
      (modelIdentifier) => modelIdentifier !== nextModel
    );
    state.activeProviderId = parseModelIdentifier(state.activeModel).providerId ?? undefined;
    const sessionId = loopState.responsesChain?.transportSessionId ?? null;
    await this.responsesChainManager.closeResponsesChainSession(loopState, sessionId);
    invalidateResponsesChain(loopState, 'manual_reset');
    if (this.taskId && !this.isSubagent) {
      this.storeAccess.updateTask(this.taskId, { model: state.activeModel });
    }
    logger.warn('[StreamRetryOrchestrator] Switching to fallback model after provider failure', {
      iteration: loopState.currentIteration,
      previousModel,
      nextModel: state.activeModel,
      reason,
    });
  }

  // ── Retry execution ─────────────────────────────────────

  /**
   * Attempt a same-model retry with backoff.
   * Returns true if a retry was performed, false if retries are exhausted.
   */
  async attemptRetryWithBackoff(
    retryCount: number,
    retryDecision: StreamRetryDecision,
    loopState: AgentLoopState,
    responseMetadataEvent: unknown,
    transportFallbackEvent: unknown
  ): Promise<{ performed: boolean; newRetryCount: number }> {
    if (retryCount >= MAX_STREAM_RETRIES) {
      return { performed: false, newRetryCount: retryCount };
    }

    const newRetryCount = retryCount + 1;
    const sleepMs = STREAM_RETRY_BACKOFF_MS[newRetryCount - 1] ?? 3000;

    logger.warn(
      `[StreamRetryOrchestrator] Retryable stream failure (${retryDecision.category || 'unknown'}) ` +
        `retry ${newRetryCount}/${MAX_STREAM_RETRIES}`,
      {
        iteration: loopState.currentIteration,
        reason: retryDecision.reason,
        status: retryDecision.status,
        hasVisibleOutput: retryDecision.hasVisibleOutput,
      }
    );

    await this.responsesChainManager.prepareRetryableResponsesRequestRetry(
      loopState,
      responseMetadataEvent as never,
      transportFallbackEvent as never
    );
    await new Promise((resolve) => setTimeout(resolve, sleepMs));

    return { performed: true, newRetryCount };
  }

  /**
   * Build the error message for when all retry attempts are exhausted.
   */
  buildRetryExhaustedError(decision: StreamRetryDecision): Error {
    const language = (useSettingsStore.getState().language || 'en') as SupportedLocale;
    const t = getLocale(language);
    const category =
      decision.category === 'server'
        ? t.LLMService.errors.retryCategoryServer
        : t.LLMService.errors.retryCategoryNetwork;

    return new Error(
      t.LLMService.errors.streamRetryExhausted(MAX_STREAM_RETRIES, category, decision.reason)
    );
  }

  // ── Unknown finish reason handling ───────────────────────

  /**
   * Calculate the backoff delay for unknown finish reason retries,
   * adjusted by provider-specific multiplier.
   */
  getUnknownFinishReasonBackoffMs(retryCount: number, providerId: string | undefined): number {
    const baseDelaySeconds = retryCount; // 1s, 2s, 3s
    const multiplier = providerId
      ? (PROVIDER_BACKOFF_MULTIPLIERS[providerId] ?? DEFAULT_BACKOFF_MULTIPLIER)
      : DEFAULT_BACKOFF_MULTIPLIER;
    return Math.round(baseDelaySeconds * multiplier * 1000);
  }
}

// ── Error serialization helper ───────────────────────────

/**
 * Serialize an error object including its cause chain up to MAX_ERROR_CAUSE_CHAIN_DEPTH levels.
 */
export function serializeErrorWithCauseChain(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') {
    return { error: String(error) };
  }

  const errorObj = error as Record<string, unknown>;

  const serializedError: Record<string, unknown> = {
    name: errorObj.name,
    message: errorObj.message,
    stack: errorObj.stack,
    context: errorObj.context,
  };

  if (errorObj.cause) {
    const causeChain: Array<Record<string, unknown>> = [];
    let currentCause: unknown = errorObj.cause;
    let depth = 0;

    while (currentCause && depth < MAX_ERROR_CAUSE_CHAIN_DEPTH) {
      const causeObj = currentCause as {
        name?: string;
        message?: string;
        stack?: string;
        context?: unknown;
        cause?: unknown;
      };
      causeChain.push({
        name: causeObj.name || 'Unknown',
        message: causeObj.message || String(currentCause),
        stack: causeObj.stack,
        context: causeObj.context,
      });
      currentCause = causeObj.cause;
      depth++;
    }

    if (causeChain.length > 0) {
      serializedError.causeChain = causeChain;
    }
  }

  return serializedError;
}
