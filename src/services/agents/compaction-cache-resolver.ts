// src/services/agents/compaction-cache-resolver.ts
/**
 * CompactionCacheResolver — Encapsulates the three-branch logic for resolving
 * compacted message caches, extracted from LLMService.runAgentLoop().
 *
 * Previously this logic was an inline 60-line if/else-if/else block that was
 * hard to test and easy to break. Now it's a pure function with explicit inputs
 * and outputs.
 */

import { convertMessages } from '@/lib/llm-utils';
import { logger } from '@/lib/logger';
import { convertToAnthropicFormat } from '@/lib/message-convert';
import { validateAnthropicMessages } from '@/lib/message-validate';
import type { Message as ModelMessage } from '@/services/llm/types';
import type { UIMessage } from '@/types/agent';

export type CompactionCache = {
  messages: ModelMessage[];
  lastRequestTokens: number;
  sourceUIMessageCount: number;
};

export type ResolveCacheInput = {
  inputMessages: UIMessage[];
  compacted: CompactionCache | null;
  rootPath: string;
  systemPrompt: string;
  activeModel: string;
  activeProviderId: string | undefined;
};

export type ResolveCacheOutput = {
  messages: ModelMessage[];
  lastRequestTokens: number;
};

/**
 * Resolve the initial loop messages from compacted cache and/or input messages.
 *
 * Three branches:
 * 1. inputMessages > compacted.sourceUIMessageCount → incremental merge
 * 2. inputMessages === compacted.sourceUIMessageCount → use cached directly
 * 3. inputMessages < compacted.sourceUIMessageCount → reprocess all (user deleted messages)
 *
 * If compacted is null, convert all input messages from scratch.
 */
export async function resolveCachedMessages(input: ResolveCacheInput): Promise<ResolveCacheOutput> {
  const { inputMessages, compacted, rootPath, systemPrompt, activeModel, activeProviderId } = input;

  if (!compacted) {
    return resolveFromScratch(inputMessages, rootPath, systemPrompt, activeModel, activeProviderId);
  }

  if (inputMessages.length > compacted.sourceUIMessageCount) {
    return resolveIncremental(inputMessages, compacted, rootPath, activeModel, activeProviderId);
  }

  if (inputMessages.length === compacted.sourceUIMessageCount) {
    logger.info('No new input messages, using compacted directly', {
      sourceUIMessageCount: compacted.sourceUIMessageCount,
      currentInputCount: inputMessages.length,
    });
    return {
      messages: compacted.messages,
      lastRequestTokens: compacted.lastRequestTokens,
    };
  }

  // inputMessages count decreased (user may have deleted messages), reprocess all
  logger.warn('Input message count decreased, reprocessing all', {
    sourceUIMessageCount: compacted.sourceUIMessageCount,
    currentInputCount: inputMessages.length,
  });
  return resolveFromScratch(inputMessages, rootPath, systemPrompt, activeModel, activeProviderId);
}

// ── Private helpers ──────────────────────────────────────

async function resolveFromScratch(
  inputMessages: UIMessage[],
  rootPath: string,
  systemPrompt: string,
  activeModel: string,
  activeProviderId: string | undefined
): Promise<ResolveCacheOutput> {
  const modelMessages = await convertMessages(inputMessages, {
    rootPath,
    systemPrompt,
    model: activeModel,
    providerId: activeProviderId,
  });

  logValidationIssues(modelMessages, 'Initial');

  return {
    messages: convertToAnthropicFormat(modelMessages, {
      autoFix: true,
      trimAssistantWhitespace: true,
    }),
    // No cached token count available for fresh conversions
    lastRequestTokens: 0,
  };
}

async function resolveIncremental(
  inputMessages: UIMessage[],
  compacted: CompactionCache,
  rootPath: string,
  activeModel: string,
  activeProviderId: string | undefined
): Promise<ResolveCacheOutput> {
  const newMessages = inputMessages.slice(compacted.sourceUIMessageCount);

  logger.info('Found new input messages after compaction', {
    sourceUIMessageCount: compacted.sourceUIMessageCount,
    currentInputCount: inputMessages.length,
    newMessageCount: newMessages.length,
  });

  const newModelMessages = await convertMessages(newMessages, {
    rootPath,
    systemPrompt: undefined, // Don't add system message again — compacted.messages already has it
    model: activeModel,
    providerId: activeProviderId,
  });

  logValidationIssues(newModelMessages, 'New');

  return {
    messages: [
      ...compacted.messages,
      ...convertToAnthropicFormat(newModelMessages, {
        autoFix: true,
        trimAssistantWhitespace: true,
      }),
    ],
    lastRequestTokens: compacted.lastRequestTokens,
  };
}

function logValidationIssues(messages: ModelMessage[], label: string): void {
  const validationResult = validateAnthropicMessages(messages);
  if (!validationResult.valid) {
    logger.warn(`[CompactionCacheResolver] ${label} message validation issues:`, {
      issues: validationResult.issues,
    });
  }
}

/**
 * Shared utility: convert UI messages to Anthropic-compliant model messages.
 * Used throughout LLMService wherever message conversion is needed.
 */
export async function prepareModelMessages(
  uiMessages: UIMessage[],
  options: {
    rootPath: string;
    systemPrompt?: string;
    model: string;
    providerId: string | undefined;
  }
): Promise<unknown[]> {
  const modelMessages = await convertMessages(uiMessages, {
    rootPath: options.rootPath,
    systemPrompt: options.systemPrompt,
    model: options.model,
    providerId: options.providerId,
  });

  const validationResult = validateAnthropicMessages(modelMessages);
  if (!validationResult.valid) {
    logger.warn('[prepareModelMessages] Validation issues:', {
      issues: validationResult.issues,
    });
  }

  return convertToAnthropicFormat(modelMessages, {
    autoFix: true,
    trimAssistantWhitespace: true,
  });
}
