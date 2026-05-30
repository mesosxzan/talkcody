// src/services/agents/compaction-manager.ts

/**
 * Manages context compaction for the agent loop.
 * Extracted from LLMService to consolidate compaction logic,
 * eliminate duplicate MAX_AUTO_COMPACTIONS declarations,
 * and decouple from direct store access.
 */

import { logger } from '@/lib/logger';
import { convertToAnthropicFormat } from '@/lib/message-convert';
import { getLocale } from '@/locales';
import { modelTypeService } from '@/providers/models/model-type-service';
import { ContextCompactor } from '@/services/context/context-compactor';
import type { Message as ModelMessage } from '@/services/llm/types';
import { taskFileService } from '@/services/task-file-service';
import { ModelType } from '@/types/model-types';
import type { AgentLoopState, CompressionConfig } from '../../types/agent';
import { invalidateResponsesChain } from './llm-response-chaining';
import type { LoopStoreAccess } from './loop-store-access';

// ── Constants ──────────────────────────────────────────────

/** Maximum number of auto-compaction attempts per iteration.
 * Previously declared twice (at lines 1353 and 1440 in the original LLMService).
 * Now unified as a single module constant.
 */
const MAX_AUTO_COMPACTIONS = 1;

/** File name for compacted messages storage */
const COMPACTED_MESSAGES_FILE = 'compacted-messages.json';

/**
 * Maximum consecutive compaction failures before circuit breaker trips.
 * Without this, sessions where context is irrecoverably over the limit
 * hammer the API with doomed compaction attempts on every turn.
 * Inspired by cc-haha's MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

// ── Types ──────────────────────────────────────────────────

export type CompactionResult =
  | { action: 'compact'; newAttempts: number }
  | { action: 'fail'; errorMessage: string };

// ── Manager ────────────────────────────────────────────────

export class CompactionManager {
  private readonly messageCompactor: ContextCompactor;
  private readonly taskId: string;
  private readonly storeAccess: LoopStoreAccess;
  /** Circuit breaker: counts consecutive compaction failures. */
  private consecutiveFailures = 0;

  constructor(taskId: string, storeAccess: LoopStoreAccess) {
    this.taskId = taskId;
    this.storeAccess = storeAccess;
    this.messageCompactor = new ContextCompactor();
  }

  /** Check if the circuit breaker has tripped. */
  isCircuitBreakerTripped(): boolean {
    return this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  }

  /** Record a compaction failure (for circuit breaker tracking). */
  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.warn(
        '[CompactionManager] Circuit breaker tripped — skipping future compaction attempts this session',
        {
          consecutiveFailures: this.consecutiveFailures,
          taskId: this.taskId,
        }
      );
    }
  }

  /** Record a compaction success (resets circuit breaker). */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * Get default compression configuration.
   */
  getDefaultCompressionConfig(): CompressionConfig {
    const [resolvedCompressionModel, ...compressionFallbackModels] =
      modelTypeService.resolveModelTypeChainSync(ModelType.MESSAGE_COMPACTION);
    const compressionModel = resolvedCompressionModel || '';

    return {
      enabled: true,
      preserveRecentMessages: 6,
      compressionModel,
      compressionFallbackModels,
      compressionThreshold: 0.8,
    };
  }

  /**
   * Handle context length exceeded error.
   * Returns a decision: either compact or fail.
   *
   * This replaces the two previously duplicated error handling blocks
   * (lines 1352-1364 and 1439-1447 in the original LLMService).
   */
  handleContextLengthExceeded(autoCompactionAttempts: number): CompactionResult {
    if (autoCompactionAttempts < MAX_AUTO_COMPACTIONS) {
      return {
        action: 'compact',
        newAttempts: autoCompactionAttempts + 1,
      };
    }

    const language = this.storeAccess.getLanguage();
    const t = getLocale(language);
    return {
      action: 'fail',
      errorMessage: t.LLMService.errors.contextTooLongCompactionFailed,
    };
  }

  /**
   * Load compacted messages from file storage.
   */
  async loadCompactedMessages(): Promise<{
    messages: ModelMessage[];
    lastRequestTokens: number;
    sourceUIMessageCount: number;
  } | null> {
    if (!this.taskId || this.taskId === 'nested') {
      return null;
    }

    try {
      const json = await taskFileService.readFile('context', this.taskId, COMPACTED_MESSAGES_FILE);
      if (!json) {
        return null;
      }

      let data: unknown;
      try {
        data = JSON.parse(json);
      } catch (parseError) {
        logger.warn('Failed to parse compacted messages JSON', parseError);
        return null;
      }

      if (
        typeof data !== 'object' ||
        data === null ||
        !('messages' in data) ||
        !Array.isArray(data.messages) ||
        data.messages.length === 0
      ) {
        return null;
      }

      const dataRecord = data as Record<string, unknown>;
      const sourceUIMessageCount =
        typeof dataRecord.sourceUIMessageCount === 'number' ? dataRecord.sourceUIMessageCount : -1;
      if (sourceUIMessageCount < 0) {
        logger.warn('Invalid sourceUIMessageCount in compacted messages', {
          taskId: this.taskId,
        });
        return null;
      }

      return {
        messages: data.messages as ModelMessage[],
        lastRequestTokens:
          typeof dataRecord.lastRequestTokens === 'number' ? dataRecord.lastRequestTokens : 0,
        sourceUIMessageCount,
      };
    } catch (error) {
      logger.warn('Failed to load compacted messages', error);
      return null;
    }
  }

  /**
   * Save compacted messages to file storage.
   */
  async saveCompactedMessages(
    messages: ModelMessage[],
    sourceUIMessageCount: number,
    lastRequestTokens: number
  ): Promise<void> {
    if (!this.taskId || this.taskId === 'nested') {
      return;
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }

    if (typeof sourceUIMessageCount !== 'number' || sourceUIMessageCount < 0) {
      logger.warn('Invalid sourceUIMessageCount for save', { sourceUIMessageCount });
      return;
    }

    if (typeof lastRequestTokens !== 'number' || lastRequestTokens < 0) {
      logger.warn('Invalid lastRequestTokens for save', { lastRequestTokens });
      return;
    }

    const data = {
      messages,
      sourceUIMessageCount,
      lastRequestTokens,
      updatedAt: Date.now(),
    };

    try {
      await taskFileService.writeFile(
        'context',
        this.taskId,
        COMPACTED_MESSAGES_FILE,
        JSON.stringify(data)
      );
      logger.info('Saved compacted messages to file', {
        taskId: this.taskId,
        modelMessageCount: messages.length,
        sourceUIMessageCount,
        lastRequestTokens,
      });
    } catch (error) {
      logger.warn('Failed to save compacted messages', error);
    }
  }

  /**
   * Run auto-compaction when context is too long.
   * Returns true if compaction succeeded, false otherwise.
   */
  async runAutoCompaction(
    loopState: AgentLoopState,
    compressionConfig: CompressionConfig,
    systemPrompt: string,
    _model: string,
    isSubagent: boolean,
    closeSessionFn: (loopState: AgentLoopState, sessionId: string | null) => Promise<void>,
    abortController?: AbortController,
    onStatus?: (status: string) => void
  ): Promise<boolean> {
    // Circuit breaker: skip compaction if too many consecutive failures
    if (this.isCircuitBreakerTripped()) {
      logger.warn('[CompactionManager] Circuit breaker active — skipping auto-compaction');
      return false;
    }

    const language = this.storeAccess.getLanguage();
    const t = getLocale(language);
    onStatus?.(t.LLMService.status.contextTooLongCompacting);

    try {
      const compressionResult = await this.messageCompactor.compactMessages(
        {
          messages: loopState.messages,
          config: compressionConfig,
          systemPrompt,
        },
        loopState.lastRequestTokens,
        abortController
      );

      if (!compressionResult.compressedSummary && compressionResult.sections.length === 0) {
        this.recordFailure();
        return false;
      }

      const compressedMessages = this.messageCompactor.createCompressedMessages(compressionResult);
      const validation = this.messageCompactor.validateCompressedMessages(compressedMessages);

      const finalMessages =
        validation.valid || !validation.fixedMessages
          ? compressedMessages
          : validation.fixedMessages;

      loopState.messages = convertToAnthropicFormat(finalMessages, {
        autoFix: true,
        trimAssistantWhitespace: true,
      });
      const sessionId = loopState.responsesChain?.transportSessionId ?? null;
      await closeSessionFn(loopState, sessionId);
      invalidateResponsesChain(loopState, 'history_rewritten');
      loopState.lastRequestTokens = 0;

      this.recordSuccess();

      onStatus?.(t.LLMService.status.compressed(compressionResult.compressionRatio.toFixed(2)));

      if (this.taskId && !isSubagent) {
        const currentUIMessageCount = this.storeAccess.getMessages(this.taskId).length;

        this.saveCompactedMessages(
          loopState.messages,
          currentUIMessageCount,
          loopState.lastRequestTokens
        ).catch((err) => {
          logger.warn('Failed to save compacted messages', err);
        });
      }

      return true;
    } catch (error) {
      logger.error('[CompactionManager] Auto-compaction failed', error);
      this.recordFailure();
      return false;
    }
  }
}
