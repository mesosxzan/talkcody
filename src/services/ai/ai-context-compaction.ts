import { logger } from '@/lib/logger';
import { modelTypeService } from '@/providers/models/model-type-service';
import { llmClient } from '@/services/llm/llm-client';
import { ModelType } from '@/types/model-types';

const COMPACTION_RETRY_BASE_DELAY_MS = 1_250;
const TRANSIENT_COMPACTION_HINTS = [
  '429',
  '500',
  '502',
  '503',
  '504',
  'overloaded',
  'capacity',
  'service unavailable',
  'service_unavailable',
  'timeout',
  'timed out',
  'connection',
  'network',
];
const INPUT_TOO_LARGE_HINTS = [
  'context length exceeded',
  'prompt is too long',
  'prompt-too-long',
  'too many tokens',
  'maximum context length',
  'input is too long',
  'request too large',
  '413',
];
const COMPACTION_HISTORY_BUDGETS = [180_000, 120_000, 80_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasAnyHint(message: string, hints: string[]): boolean {
  const normalized = message.toLowerCase();
  return hints.some((hint) => normalized.includes(hint));
}

function isTransientCompactionError(error: unknown): boolean {
  return hasAnyHint(errorToMessage(error), TRANSIENT_COMPACTION_HINTS);
}

function isCompactionInputTooLargeError(error: unknown): boolean {
  return hasAnyHint(errorToMessage(error), INPUT_TOO_LARGE_HINTS);
}

function trimConversationHistory(history: string, maxLength: number): string {
  if (history.length <= maxLength) {
    return history;
  }

  const marker = `\n\n[Earlier compaction input truncated to reduce request size. ${history.length - maxLength} chars omitted.]\n\n`;
  const available = Math.max(0, maxLength - marker.length);
  const headLength = Math.floor(available * 0.35);
  const tailLength = Math.max(0, available - headLength);

  return `${history.slice(0, headLength)}${marker}${history.slice(-tailLength)}`;
}

function buildCompactionHistoryVariants(history: string): string[] {
  const variants = [history];

  for (const budget of COMPACTION_HISTORY_BUDGETS) {
    const candidate = trimConversationHistory(history, budget);
    if (!variants.includes(candidate)) {
      variants.push(candidate);
    }
  }

  return variants;
}

class AIContextCompactionService {
  /**
   * Compresses conversation history using AI.
   *
   * @param conversationHistory - The conversation history to compress (text format)
   * @param model - Optional model identifier to use for compression
   * @param fallbackModels - Optional ordered fallback models used if the primary request fails
   * @returns Promise that resolves to the compressed summary text
   */
  async compactContext(
    conversationHistory: string,
    model?: string,
    fallbackModels: string[] = []
  ): Promise<string> {
    try {
      logger.info('Starting AI context compaction');

      const normalizedHistory = conversationHistory.trim();
      if (!normalizedHistory) {
        logger.error('No conversation history provided for compaction');
        throw new Error('Conversation history is required for compaction');
      }

      const [primaryModel, ...resolvedFallbackModels] = model
        ? [model, ...fallbackModels]
        : await modelTypeService.resolveModelTypeChain(ModelType.MESSAGE_COMPACTION);

      const historyVariants = buildCompactionHistoryVariants(normalizedHistory);
      let lastError: unknown;

      for (let variantIndex = 0; variantIndex < historyVariants.length; variantIndex++) {
        const candidateHistory = historyVariants[variantIndex];
        if (!candidateHistory) {
          continue;
        }
        const maxRetries = variantIndex === 0 ? 2 : 1;

        for (let retryIndex = 0; retryIndex < maxRetries; retryIndex++) {
          try {
            const result = await llmClient.compactContext({
              conversationHistory: candidateHistory,
              model: primaryModel,
              fallbackModels: resolvedFallbackModels,
            });

            const compressedSummaryValue = result?.compressedSummary;
            const compressedSummary =
              typeof compressedSummaryValue === 'string' ? compressedSummaryValue : '';

            if (compressedSummaryValue == null) {
              logger.warn('AI context compaction returned no summary; defaulting to empty string');
            }

            logger.info(
              `Compressed summary length: ${compressedSummary.length} characters (from ${candidateHistory.length})`
            );

            return compressedSummary;
          } catch (error) {
            lastError = error;
            const transient = isTransientCompactionError(error);
            const inputTooLarge = isCompactionInputTooLargeError(error);
            const hasSmallerVariant = variantIndex < historyVariants.length - 1;

            if (transient && retryIndex < maxRetries - 1) {
              const delayMs = COMPACTION_RETRY_BASE_DELAY_MS * 2 ** retryIndex;
              logger.warn('AI context compaction hit transient error; retrying same payload', {
                attempt: retryIndex + 1,
                delayMs,
                candidateLength: candidateHistory.length,
                error: errorToMessage(error),
              });
              await sleep(delayMs);
              continue;
            }

            if ((transient || inputTooLarge) && hasSmallerVariant) {
              logger.warn('AI context compaction failed; retrying with smaller payload', {
                candidateLength: candidateHistory.length,
                nextCandidateLength:
                  historyVariants[variantIndex + 1]?.length ?? candidateHistory.length,
                error: errorToMessage(error),
                reason: inputTooLarge ? 'input_too_large' : 'transient_error',
              });
              break;
            }

            throw error;
          }
        }
      }

      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    } catch (error) {
      logger.error('AI context compaction error:', error);
      throw error;
    }
  }
}

export const aiContextCompactionService = new AIContextCompactionService();
