// src/services/agents/llm-service.ts

import {
  createErrorContext,
  extractAndFormatError,
  isContextLengthExceededError,
} from '@/lib/error-utils';
import { convertMessages } from '@/lib/llm-utils';
import { logger } from '@/lib/logger';
import { convertToAnthropicFormat } from '@/lib/message-convert';
import { MessageTransform } from '@/lib/message-transform';
import { toOpenAIToolDefinition } from '@/lib/tool-schema';
import { createLlmTraceContext } from '@/lib/trace-utils';
import { UsageTokenUtils } from '@/lib/usage-token-utils';
import { generateId } from '@/lib/utils';
import { getLocale, type SupportedLocale } from '@/locales';
import { getContextLength } from '@/providers/config/model-config';
import { parseModelIdentifier } from '@/providers/core/provider-utils';
import { LLMStreamParams } from '@/services/agents/llm-stream-params';
import { lastReviewedChangeTimestamp } from '@/services/auto-code-review-service';
import { ContextCompactor } from '@/services/context/context-compactor';
import { databaseService } from '@/services/database-service';
import { hookService } from '@/services/hooks/hook-service';
import { hookStateService } from '@/services/hooks/hook-state-service';
import { llmClient, type StreamTextResult } from '@/services/llm/llm-client';
import type { ContentPart, Message as ModelMessage } from '@/services/llm/types';
import { getEffectiveWorkspaceRoot } from '@/services/workspace-root-service';
import { useSettingsStore } from '@/stores/settings-store';
import type { ToolSummary } from '@/types/completion-hooks';
import type {
  AgentLoopOptions,
  AgentLoopState,
  CompressionConfig,
  MessageAttachment,
  UIMessage,
} from '../../types/agent';
import { aiPricingService } from '../ai/ai-pricing-service';
import { resolveCachedMessages } from './compaction-cache-resolver';
import { CompactionManager } from './compaction-manager';
import { completionHookPipeline } from './llm-completion-hooks';
import {
  applyTransportFallbackEvent,
  invalidateResponsesChain,
  planStreamTextRequest,
  type ResponseMetadataEvent,
  type TransportFallbackEvent,
} from './llm-response-chaining';
import { createDefaultLoopStoreAccess, type LoopStoreAccess } from './loop-store-access';
import { toLlmMessages } from './message-adapter';
import { attemptReactiveCompaction, clearExpiredToolResults } from './reactive-compaction';
import { ResponsesChainManager } from './responses-chain-manager';
import { MAX_STREAM_RETRIES } from './stream-retry-manager';
import {
  isNormalFinishReason,
  isTruncationFinishReason,
  MAX_AUTO_COMPACTIONS,
  MAX_AUTO_CONTINUE_ATTEMPTS,
  MAX_ERROR_CAUSE_CHAIN_DEPTH,
  ModelFallbackSwitchError,
  PROVIDER_BACKOFF_MULTIPLIERS,
  RetryableStreamError,
  STREAM_RETRY_BACKOFF_MS,
  STREAM_STALL_TIMEOUT_MS,
  StreamRetryOrchestrator,
} from './stream-retry-orchestrator';

/**
 * Callbacks for agent loop
 * NOTE: Persistence is now handled by ExecutionService
 */
export interface AgentLoopCallbacks {
  /** Called when text streaming starts */
  onAssistantMessageStart?: () => void;
  /** Called for each text chunk during streaming */
  onChunk: (chunk: string) => void;
  /** Called when the agent loop completes successfully */
  onComplete?: (fullText: string) => void;
  /** Called when an error occurs */
  onError?: (error: Error) => void;
  /** Called when status changes (e.g., "Thinking...", "Executing tool...") */
  onStatus?: (status: string) => void;
  /** Called when a tool message is generated */
  onToolMessage?: (message: UIMessage) => void;
  /** Called when an assistant turn's raw reasoning_content is finalized */
  onAssistantReasoning?: (reasoningContent?: string) => void;
  /** Called when streamed reasoning text updates or finishes */
  onReasoningUpdate?: (payload: { reasoningContent: string; isStreaming: boolean }) => void;
  /** Called when an attachment is generated (e.g., images) */
  onAttachment?: (attachment: MessageAttachment) => void;
}

import { ErrorHandler } from './error-handler';
import { StreamProcessor } from './stream-processor';
import { ToolExecutor } from './tool-executor';

function getTranslations() {
  const language = (useSettingsStore.getState().language || 'en') as SupportedLocale;
  return getLocale(language);
}

/**
 * Wrap an async event stream with a stall timeout.
 * If no event is received within `timeoutMs` milliseconds, the iterator
 * throws a RetryableStreamError so the outer retry pipeline can recover.
 *
 * This prevents the agent loop from hanging indefinitely when a provider
 * silently drops the connection without sending a terminal event.
 */
async function* withStallTimeout(
  events: AsyncGenerator<import('@/services/llm/types').StreamEvent, void, unknown>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  getHasVisibleOutput?: () => boolean
): AsyncGenerator<import('@/services/llm/types').StreamEvent, void, unknown> {
  let lastEventTime = Date.now();

  for (;;) {
    // Race between the next event, the stall timer, and the abort signal
    const nextPromise = events.next();

    let stallTimerId: ReturnType<typeof setTimeout> | undefined;
    const stallPromise = new Promise<'stall'>((resolve) => {
      const remaining = timeoutMs - (Date.now() - lastEventTime);
      stallTimerId = setTimeout(() => resolve('stall'), Math.max(remaining, 0));
    });

    const abortPromise = abortSignal
      ? new Promise<'aborted'>((resolve) => {
          if (abortSignal.aborted) {
            resolve('aborted');
            return;
          }
          const handler = () => resolve('aborted');
          abortSignal.addEventListener('abort', handler, { once: true });
          // Clean up the listener if another promise wins the race
          stallPromise.finally(() => abortSignal.removeEventListener('abort', handler));
        })
      : new Promise<'aborted'>(() => {}); // never resolves if no signal

    const result = await Promise.race([nextPromise, stallPromise, abortPromise]);

    // Clear the stall timer to prevent leaks
    if (stallTimerId !== undefined) {
      clearTimeout(stallTimerId);
    }

    if (result === 'aborted') {
      return;
    }

    if (result === 'stall') {
      // Stream stalled — throw a retryable error so the retry pipeline can recover
      throw new RetryableStreamError({
        retryable: true,
        category: 'network',
        reason: `Stream stalled: no event received for ${timeoutMs}ms`,
        hasVisibleOutput: getHasVisibleOutput?.() ?? false,
        preferRetryBeforeModelFallback: true,
      });
    }

    const { value, done } = result as IteratorResult<
      import('@/services/llm/types').StreamEvent,
      void
    >;
    if (done) {
      return;
    }

    lastEventTime = Date.now();
    yield value;
  }
}

export class LLMService {
  private readonly compactionManager: CompactionManager;
  private readonly responsesChainManager: ResponsesChainManager;
  private readonly toolExecutor: ToolExecutor;
  private readonly errorHandler: ErrorHandler;
  private readonly storeAccess: LoopStoreAccess;
  private readonly messageCompactor: ContextCompactor;
  /** Task ID for this LLM service instance (used for parallel task execution) */
  private readonly taskId: string;

  /**
   * Merge continuation messages using message ID-based deduplication.
   * Uses UIMessage.id for identity comparison instead of content signatures,
   * which avoids false positives when different messages have identical content
   * (e.g., two separate "yes" responses at different points in the conversation).
   */
  private mergeAppendContinuationMessages(
    taskMessages: UIMessage[],
    nextMessages: UIMessage[]
  ): { messages: UIMessage[]; appendedCount: number } {
    const existingIds = new Set(taskMessages.map((message) => message.id));
    const missingMessages = nextMessages.filter((message) => {
      if (existingIds.has(message.id)) {
        return false;
      }
      existingIds.add(message.id);
      return true;
    });

    return {
      messages: [...taskMessages, ...missingMessages],
      appendedCount: missingMessages.length,
    };
  }

  /**
   * Create a new LLMService instance.
   * @param taskId Optional task ID for parallel task execution. Each task should have its own instance.
   * @param storeAccess Optional store access interface for dependency injection (defaults to Zustand stores)
   */
  constructor(taskId: string, storeAccess?: LoopStoreAccess) {
    this.taskId = taskId;
    this.storeAccess = storeAccess ?? createDefaultLoopStoreAccess();
    this.compactionManager = new CompactionManager(taskId, this.storeAccess);
    this.responsesChainManager = new ResponsesChainManager();
    this.toolExecutor = new ToolExecutor();
    this.errorHandler = new ErrorHandler();
    this.messageCompactor = new ContextCompactor();
  }

  /** Get the task ID for this instance */
  getTaskId(): string | undefined {
    return this.taskId;
  }

  /**
   * Capture tool result for completion hook evaluation.
   * Appends to loopState.toolSummaries instead of an instance field,
   * ensuring per-iteration isolation and thread safety in parallel execution.
   */
  private captureToolResult(
    toolName: string,
    result: unknown,
    toolCallId: string,
    loopState: AgentLoopState
  ): void {
    const summary: ToolSummary = {
      toolName,
      toolCallId,
    };

    // Extract structured data from bash tool results
    if (toolName === 'bash' && result && typeof result === 'object') {
      const bashResult = result as {
        command?: string;
        success?: boolean;
        output?: string;
        error?: string;
      };
      summary.command = bashResult.command;
      summary.success = bashResult.success;
      summary.output = bashResult.output;
      summary.error = bashResult.error;
    } else if (result && typeof result === 'object' && 'error' in result) {
      summary.error = String((result as { error?: string }).error);
    }

    loopState.toolSummaries.push(summary);
  }

  /**
   * Run the agent loop with the given options and callbacks.
   * @param options Agent loop configuration
   * @param callbacks Event callbacks for streaming, completion, errors, etc.
   * @param abortController Optional controller to abort the loop
   */
  async runAgentLoop(
    options: AgentLoopOptions,
    callbacks: AgentLoopCallbacks,
    abortController?: AbortController
  ): Promise<void> {
    // Use taskId as trace ID for the entire agent loop
    // This ensures all LLM calls in the same agent loop are grouped under one trace
    const traceId = this.taskId;
    // Note: parentSpanId is intentionally omitted until we create a real root span.
    // Passing a non-existent parentSpanId causes FK failures on spans.
    logger.info('[LLMService] Starting agent loop with trace', {
      traceId,
      taskId: this.taskId,
    });

    const {
      onChunk,
      onComplete,
      onError,
      onStatus,
      onToolMessage,
      onAssistantMessageStart,
      onAssistantReasoning,
      onReasoningUpdate,
    } = callbacks;

    const rejectOnAbort = (message: string) => {
      logger.info(message);
      const abortError = new DOMException('Aborted', 'AbortError');
      onError?.(abortError);
      throw abortError;
    };

    let loopState: AgentLoopState | null = null;
    let activeModel = options.model;
    let activeFallbackModels = [...(options.fallbackModels ?? [])];
    let activeProviderId = parseModelIdentifier(activeModel).providerId ?? undefined;

    try {
      const {
        messages: inputMessages,
        model,
        fallbackModels = [],
        systemPrompt = '',
        tools = {},
        isThink = true,
        isSubagent = false,
        subagentId,
        suppressReasoning = false,
        maxIterations = 500,
        compression,
        agentId,
        freshContext = false,
        rootPath: providedRootPath,
      } = options;

      activeModel = model;
      activeFallbackModels = [...fallbackModels];
      activeProviderId = parseModelIdentifier(activeModel).providerId ?? undefined;

      // Merge compression config with defaults
      const compressionConfig: CompressionConfig = {
        ...this.compactionManager.getDefaultCompressionConfig(),
        ...compression,
      };

      const totalStartTime = Date.now();
      const reasoningEffort = this.storeAccess.getReasoningEffort();

      logger.info('Starting agent loop with model', {
        model,
        maxIterations: options.maxIterations,
        taskId: this.taskId,
        inputMessageCount: inputMessages.length,
        agentId: agentId || 'default',
        reasoningEffort,
      });
      const t = getTranslations();
      onStatus?.(t.LLMService.status.initializing);

      // Update task with the model being used if it's a main task
      if (this.taskId && !isSubagent) {
        this.storeAccess.updateTask(this.taskId, { model: activeModel });
      }

      const isAvailable = this.storeAccess.isModelAvailable(activeModel);
      if (!isAvailable) {
        const errorContext = createErrorContext(activeModel, {
          phase: 'model-initialization',
        });
        logger.error(`Model not available: ${activeModel}`, undefined, {
          ...errorContext,
          availableModels: this.storeAccess.getAvailableModels() || [],
        });
        throw new Error(
          t.LLMService.errors.noProvider(activeModel, errorContext.provider || 'unknown')
        );
      }
      this.storeAccess.getProviderModel(activeModel);

      const rootPath = providedRootPath ?? (await getEffectiveWorkspaceRoot(this.taskId));

      // Initialize agent loop state
      loopState = {
        messages: [],
        currentIteration: 0,
        isComplete: false,
        lastFinishReason: undefined,
        lastRequestTokens: 0,
        toolSummaries: [],
      };

      // Resolve initial messages using CompactionCacheResolver
      // (handles incremental merge, cache hit, and full-rebuild branches)
      const resolvedCache = await resolveCachedMessages({
        compacted:
          freshContext || inputMessages.length <= compressionConfig.preserveRecentMessages
            ? null
            : await this.compactionManager.loadCompactedMessages(),
        inputMessages,
        rootPath,
        systemPrompt,
        activeModel,
        activeProviderId,
      });
      loopState.messages = resolvedCache.messages;
      loopState.lastRequestTokens = resolvedCache.lastRequestTokens;

      // Create a new StreamProcessor instance for each agent loop
      // This ensures nested agent calls (e.g., callAgent) don't interfere with parent agent's state
      // Previously, using a shared instance caused tool call ID mismatches when nested agents reset the processor
      const streamProcessor = new StreamProcessor();

      const retryOrchestrator = new StreamRetryOrchestrator({
        taskId: this.taskId,
        isSubagent,
        storeAccess: this.storeAccess,
        responsesChainManager: this.responsesChainManager,
        streamProcessor,
      });

      let didRunSessionStart = false;
      let autoCompactionAttempts = 0;
      let ralphIteration = 0; // Track Ralph loop iterations separately from agent steps

      while (!loopState.isComplete && loopState.currentIteration < maxIterations) {
        if (this.taskId && !isSubagent && !didRunSessionStart) {
          const sessionStartSummary = await hookService.runSessionStart(this.taskId, 'startup');
          hookService.applyHookSummary(sessionStartSummary);
          didRunSessionStart = true;
        }

        if (this.taskId && !isSubagent) {
          const extraContext = hookStateService.consumeAdditionalContext();
          if (extraContext.length > 0) {
            loopState.messages.push({
              role: 'system',
              content: extraContext.join('\n'),
              providerOptions: {
                anthropic: { cacheControl: { type: 'ephemeral' } },
              },
            });
          }
        }
        // Check for abort signal
        if (abortController?.signal.aborted) {
          rejectOnAbort('Agent loop aborted by user');
          return;
        }

        loopState.currentIteration++;

        // Reset tool summaries at the start of each iteration to ensure
        // completion hooks only see results from the current iteration
        loopState.toolSummaries = [];

        const filteredTools = { ...tools };
        onStatus?.(t.LLMService.status.step(loopState.currentIteration));

        // Reset stream processor state for new iteration
        // Use resetState() instead of resetCurrentStepText() to ensure isAnswering flag is also reset
        // This is critical for multi-iteration scenarios (e.g., text -> tool call -> text)
        streamProcessor.resetState();

        // === Micro-compact: clear expired tool results ===
        // Between turns, clear old tool result content that has likely expired
        // from the server's prompt cache. This is a lightweight operation that
        // doesn't require an API call.
        if (!freshContext && loopState.messages.length > 10) {
          // Derive the last assistant timestamp from the messages themselves
          const lastAssistantTime = (() => {
            for (let i = loopState.messages.length - 1; i >= 0; i--) {
              if (loopState.messages[i]?.role === 'assistant') {
                // Use current time as approximation; messages don't carry timestamps
                return Date.now();
              }
            }
            return 0;
          })();
          loopState.messages = clearExpiredToolResults(loopState.messages, lastAssistantTime);
        }

        // Check and perform message compression if needed
        try {
          if (!freshContext) {
            const compressionResult = await this.messageCompactor.performCompressionIfNeeded(
              loopState.messages,
              compressionConfig,
              loopState.lastRequestTokens,
              activeModel,
              systemPrompt,
              abortController,
              onStatus
            );

            if (compressionResult) {
              // Apply Anthropic format conversion to compressed messages
              loopState.messages = convertToAnthropicFormat(compressionResult.messages, {
                autoFix: true,
                trimAssistantWhitespace: true,
              });
              const sessionId = loopState.responsesChain?.transportSessionId ?? null;
              await this.responsesChainManager.closeResponsesChainSession(loopState, sessionId);
              invalidateResponsesChain(loopState, 'history_rewritten');
              onStatus?.(
                t.LLMService.status.compressed(compressionResult.result.compressionRatio.toFixed(2))
              );

              // Save compacted messages to file (only when compression is triggered)
              if (this.taskId && !isSubagent) {
                // Query taskStore for current UI message count
                const currentUIMessageCount = this.storeAccess.getMessages(this.taskId).length;

                this.compactionManager
                  .saveCompactedMessages(
                    loopState.messages,
                    currentUIMessageCount,
                    loopState.lastRequestTokens
                  )
                  .catch((err) => {
                    logger.warn('Failed to save compacted messages', err);
                  });
              }
            }
          }
        } catch (error) {
          // Extract and format error using utility
          const errorContext = createErrorContext(activeModel, {
            iteration: loopState.currentIteration,
            messageCount: loopState.messages.length,
            phase: 'message-compression',
          });
          const { formattedError } = extractAndFormatError(error, errorContext);

          logger.warn('Message compression failed, continuing without compression', {
            formattedError,
          });
          onStatus?.(t.LLMService.status.compressionFailed);
          // Continue with original messages if compression fails
        }

        // Log request context before calling streamText
        const requestStartTime = Date.now();

        // Create tool definitions without execute methods
        // This prevents auto-executing tools, which would bypass ToolExecutor
        // ToolExecutor will manually execute tools using the filtered tools object
        const toolsForAI: Record<string, unknown> = Object.fromEntries(
          Object.entries(filteredTools).map(([name, toolDef]) => {
            if (toolDef && typeof toolDef === 'object' && 'execute' in toolDef) {
              // Remove execute method from tool definition
              // Cast through unknown to avoid type issues with ToolWithUI
              const toolDefAny = toolDef as unknown as Record<string, unknown>;
              const { execute: _execute, ...toolDefWithoutExecute } = toolDefAny;
              return [name, toolDefWithoutExecute];
            }
            return [name, toolDef];
          })
        );

        // Normalize provider-specific assistant history once per iteration.
        // Retries reuse the same loopState.messages, so repeating this on every retry is unnecessary.
        const { messages: transformedMessages } = MessageTransform.transform(
          loopState.messages,
          activeModel,
          activeProviderId
        );
        loopState.messages = transformedMessages;

        const promoteFallbackModel = async (nextModel: string, reason: string): Promise<void> => {
          const currentLoopState = loopState;
          if (!currentLoopState) {
            return;
          }

          const previousModel = activeModel;
          activeModel = nextModel;
          activeFallbackModels = activeFallbackModels.filter(
            (modelIdentifier) => modelIdentifier !== nextModel
          );
          activeProviderId = parseModelIdentifier(activeModel).providerId ?? undefined;
          const sessionId = currentLoopState.responsesChain?.transportSessionId ?? null;
          await this.responsesChainManager.closeResponsesChainSession(currentLoopState, sessionId);
          invalidateResponsesChain(currentLoopState, 'manual_reset');
          if (this.taskId && !isSubagent) {
            this.storeAccess.updateTask(this.taskId, { model: activeModel });
          }
          logger.warn('[LLMService] Switching to fallback model after provider failure', {
            iteration: currentLoopState.currentIteration,
            previousModel,
            nextModel: activeModel,
            reason,
          });
        };

        // Retry loop for transient network/provider failures.
        // 3 retries means 1 initial attempt + up to 3 additional attempts.
        let streamRetryCount = 0;
        let streamResult: StreamTextResult | null = null;
        let shouldAutoCompact = false;
        let shouldRetryStateless = false;
        let shouldRetryFreshWebsocketBaseline = false;
        let responseMetadataEvent: ResponseMetadataEvent | null = null;
        let transportFallbackEvent: TransportFallbackEvent | null = null;
        let didFallbackToStateless = false;

        while (streamRetryCount <= MAX_STREAM_RETRIES) {
          try {
            responseMetadataEvent = null;
            transportFallbackEvent = null;
            didFallbackToStateless = false;
            shouldRetryStateless = false;
            shouldRetryFreshWebsocketBaseline = false;

            // Reset stream processor state before each attempt
            if (streamRetryCount > 0) {
              streamProcessor.resetState();
              logger.info(`Stream retry attempt ${streamRetryCount}/${MAX_STREAM_RETRIES}`, {
                iteration: loopState.currentIteration,
              });
            }

            const { providerOptions, temperature, topP, topK } = LLMStreamParams.build({
              modelIdentifier: activeModel,
              reasoningEffort,
              enableReasoningOptions: isThink,
            });

            const tools = Object.entries(toolsForAI).map(([name, tool]) => {
              const toolDef = tool as { description?: string; inputSchema?: unknown };
              return toOpenAIToolDefinition(name, toolDef.description, toolDef.inputSchema, {
                modelIdentifier: activeModel,
              });
            });

            const traceEnabled = this.storeAccess.getTraceEnabled();
            const traceContext = traceEnabled
              ? createLlmTraceContext(traceId, activeModel, loopState.currentIteration)
              : null;

            const llmMessages = toLlmMessages(loopState.messages);
            const requestPlan = planStreamTextRequest(loopState, {
              model: activeModel,
              fallbackModels: activeFallbackModels,
              iteration: loopState.currentIteration,
              messages: llmMessages,
              tools: tools.length > 0 ? tools : undefined,
              temperature,
              maxTokens: 15000,
              topP,
              topK,
              providerOptions: providerOptions ?? undefined,
              traceContext,
            });

            logger.debug('[LLMService] Planned OpenAI request turn', {
              iteration: loopState.currentIteration,
              model: activeModel,
              conversationMode: requestPlan.request.conversationMode,
              inputMode: requestPlan.request.inputMode,
              messageCount: requestPlan.request.messages.length,
              hasPreviousResponseId: !!requestPlan.request.previousResponseId,
              transportSessionId: requestPlan.request.transportSessionId ?? null,
              usesIncrementalInput: requestPlan.usesIncrementalInput,
            });

            streamResult = await llmClient.streamText(requestPlan.request, abortController?.signal);

            const streamCallbacks = {
              onChunk,
              onStatus,
              onAssistantMessageStart,
              onReasoningUpdate,
            };
            const streamContext = { suppressReasoning };

            // Process current step stream with stall timeout protection.
            // If the provider silently drops the connection, the stall timer
            // will fire and throw a RetryableStreamError for automatic recovery.
            const stallProtectedEvents = withStallTimeout(
              streamResult.events,
              STREAM_STALL_TIMEOUT_MS,
              abortController?.signal,
              () => retryOrchestrator.hasVisibleStreamOutput(streamProcessor.getState())
            );

            for await (const delta of stallProtectedEvents) {
              if (abortController?.signal.aborted) {
                rejectOnAbort('Agent loop aborted during streaming');
                return;
              }

              switch (delta.type) {
                case 'text-start':
                  streamProcessor.processTextStart(streamCallbacks);
                  break;
                case 'text-delta':
                  if (delta.text) {
                    streamProcessor.processTextDelta(delta.text, streamCallbacks);
                  }
                  break;
                case 'tool-call':
                  streamProcessor.processToolCall(
                    {
                      toolCallId: delta.toolCallId,
                      toolName: delta.toolName,
                      input: delta.input,
                      providerMetadata: delta.providerMetadata ?? undefined,
                    },
                    streamCallbacks
                  );
                  break;
                case 'reasoning-start':
                  streamProcessor.processReasoningStart(
                    delta.id,
                    delta.providerMetadata ?? undefined,
                    streamCallbacks
                  );
                  break;
                case 'reasoning-delta':
                  streamProcessor.processReasoningDelta(
                    delta.id || 'default',
                    delta.text || '',
                    delta.providerMetadata ?? undefined,
                    streamContext,
                    streamCallbacks
                  );
                  break;
                case 'reasoning-end':
                  streamProcessor.processReasoningEnd(delta.id, streamCallbacks);
                  break;
                case 'response-metadata':
                  logger.debug('[LLMService] Received response metadata', {
                    iteration: loopState.currentIteration,
                    responseId: delta.responseId,
                    transport: delta.transport,
                    provider: delta.provider,
                    continuationAccepted: delta.continuationAccepted,
                    transportSessionId: delta.transportSessionId ?? null,
                  });
                  responseMetadataEvent = delta;
                  break;
                case 'transport-fallback':
                  logger.warn('[LLMService] Received transport fallback', {
                    iteration: loopState.currentIteration,
                    reason: delta.reason,
                    from: delta.from,
                    to: delta.to,
                  });
                  transportFallbackEvent = delta;
                  didFallbackToStateless = delta.to === 'stateless';
                  break;
                case 'usage': {
                  const requestDuration = Date.now() - requestStartTime;
                  const normalizedUsage = UsageTokenUtils.normalizeUsageTokens(
                    {
                      inputTokens: delta.input_tokens,
                      outputTokens: delta.output_tokens,
                      cachedInputTokens: delta.cached_input_tokens ?? undefined,
                      cacheCreationInputTokens: delta.cache_creation_input_tokens ?? undefined,
                      totalTokens: delta.total_tokens ?? undefined,
                    },
                    undefined
                  );

                  if (normalizedUsage?.totalTokens) {
                    if (loopState.lastRequestTokens > 0) {
                      const tokenIncrease =
                        normalizedUsage.totalTokens - loopState.lastRequestTokens;
                      if (tokenIncrease > 10000) {
                        logger.warn('Token count increased significantly', {
                          currentTokens: normalizedUsage.totalTokens,
                          previousTokens: loopState.lastRequestTokens,
                          increase: tokenIncrease,
                          iteration: loopState.currentIteration,
                        });
                      }
                    }
                    loopState.lastRequestTokens = normalizedUsage.totalTokens;
                  }

                  if (normalizedUsage) {
                    const {
                      inputTokens,
                      outputTokens,
                      cachedInputTokens,
                      cacheCreationInputTokens,
                    } = normalizedUsage;
                    const cost = await aiPricingService.calculateCost(activeModel, {
                      inputTokens,
                      outputTokens,
                      cachedInputTokens,
                      cacheCreationInputTokens,
                    });

                    let contextUsage: number | undefined;
                    if (loopState.lastRequestTokens > 0) {
                      const maxContextTokens = getContextLength(activeModel);
                      contextUsage = Math.min(
                        100,
                        (loopState.lastRequestTokens / maxContextTokens) * 100
                      );
                    }

                    if (this.taskId && !isSubagent) {
                      this.storeAccess.updateTask(this.taskId, {
                        last_request_input_token: inputTokens,
                      });
                      this.storeAccess.updateTaskUsage(this.taskId, {
                        costDelta: cost,
                        inputTokensDelta: inputTokens,
                        outputTokensDelta: outputTokens,
                        requestCountDelta: 1,
                        contextUsage,
                      });
                    }

                    databaseService
                      .insertApiUsageEvent({
                        id: generateId(),
                        conversationId:
                          this.taskId && this.taskId !== 'nested' ? this.taskId : null,
                        model: activeModel,
                        providerId: activeProviderId ?? null,
                        inputTokens,
                        outputTokens,
                        cost,
                        createdAt: Date.now(),
                      })
                      .catch((error) => {
                        logger.warn('[LLMService] Failed to insert usage event', error);
                      });
                  }

                  logger.info('onFinish', {
                    finishReason: delta.total_tokens ? 'stop' : 'unknown',
                    requestDuration,
                    totalUsage: delta.total_tokens,
                    lastRequestTokens: loopState.lastRequestTokens,
                    request: 'llm_stream_text',
                  });
                  break;
                }
                case 'done':
                  loopState.lastFinishReason = delta.finish_reason ?? undefined;
                  break;
                case 'raw': {
                  if (!loopState.rawChunks) {
                    loopState.rawChunks = [];
                  }
                  loopState.rawChunks.push(delta.raw_value);
                  break;
                }
                case 'error': {
                  const continuationRejected =
                    didFallbackToStateless ||
                    transportFallbackEvent?.to === 'fresh-websocket-baseline' ||
                    responseMetadataEvent?.continuationAccepted === false;

                  if (continuationRejected) {
                    const sessionIdToClose =
                      responseMetadataEvent?.transportSessionId ??
                      loopState.responsesChain?.transportSessionId ??
                      null;
                    if (transportFallbackEvent) {
                      applyTransportFallbackEvent(loopState, transportFallbackEvent);
                    } else {
                      invalidateResponsesChain(loopState, 'provider_rejected');
                    }
                    await this.responsesChainManager.closeResponsesChainSession(
                      loopState,
                      sessionIdToClose
                    );
                    shouldRetryFreshWebsocketBaseline =
                      transportFallbackEvent?.to === 'fresh-websocket-baseline';
                    shouldRetryStateless = !shouldRetryFreshWebsocketBaseline;
                    break;
                  }

                  streamProcessor.markError();

                  const errorObj = new Error(delta.message);
                  if (delta.name) {
                    errorObj.name = delta.name;
                  }

                  if (isContextLengthExceededError(errorObj)) {
                    if (autoCompactionAttempts < MAX_AUTO_COMPACTIONS) {
                      autoCompactionAttempts++;
                      shouldAutoCompact = true;
                      break;
                    }

                    const errorMessage = t.LLMService.errors.contextTooLongCompactionFailed;
                    const error = new Error(errorMessage);
                    onError?.(error);
                    throw error;
                  }

                  const visibleOutput = retryOrchestrator.hasVisibleStreamOutput(
                    streamProcessor.getState()
                  );
                  const retryDecision = retryOrchestrator.classifyStreamRetry(
                    errorObj,
                    activeModel,
                    loopState.currentIteration,
                    visibleOutput
                  );

                  const shouldPreferSameModelRetries =
                    retryDecision.retryable && retryDecision.preferRetryBeforeModelFallback;

                  if (!visibleOutput && activeFallbackModels[0] && !shouldPreferSameModelRetries) {
                    throw new ModelFallbackSwitchError(
                      activeFallbackModels[0],
                      retryDecision.reason
                    );
                  }

                  if (retryDecision.retryable) {
                    throw new RetryableStreamError(retryDecision);
                  }

                  const errorHandlerOptions = {
                    model: activeModel,
                    tools: filteredTools,
                    loopState,
                    onError,
                  };

                  const errorResult = this.errorHandler.handleStreamError(
                    errorObj,
                    errorHandlerOptions
                  );

                  if (errorResult.shouldStop) {
                    const error =
                      errorResult.error || new Error('Unknown error occurred during streaming');
                    onError?.(error);
                    throw error;
                  }

                  if (errorResult.error) {
                    onError?.(errorResult.error);
                  }

                  const consecutiveErrors = streamProcessor.getConsecutiveToolErrors();
                  // Add guidance message when too many consecutive errors occur, but continue the loop
                  this.errorHandler.addConsecutiveErrorGuidance(
                    consecutiveErrors,
                    errorHandlerOptions
                  );

                  break;
                }
              }
            }

            // Stream processing succeeded, exit retry loop
            break;
          } catch (streamError) {
            if (streamError instanceof ModelFallbackSwitchError) {
              await promoteFallbackModel(streamError.nextModel, streamError.reason);
              streamRetryCount = 0;
              streamProcessor.resetState();
              continue;
            }

            if (isContextLengthExceededError(streamError)) {
              if (autoCompactionAttempts < MAX_AUTO_COMPACTIONS) {
                autoCompactionAttempts++;
                shouldAutoCompact = true;
                break;
              }

              throw new Error(t.LLMService.errors.contextTooLongCompactionFailed);
            }

            const visibleOutput = retryOrchestrator.hasVisibleStreamOutput(
              streamProcessor.getState()
            );
            const retryDecision =
              streamError instanceof RetryableStreamError
                ? streamError.decision
                : retryOrchestrator.classifyStreamRetry(
                    streamError,
                    activeModel,
                    loopState.currentIteration,
                    visibleOutput
                  );
            const shouldPreferSameModelRetries =
              retryDecision.retryable && retryDecision.preferRetryBeforeModelFallback;

            if (shouldPreferSameModelRetries && streamRetryCount < MAX_STREAM_RETRIES) {
              streamRetryCount++;
              const sleepMs = STREAM_RETRY_BACKOFF_MS[streamRetryCount - 1] ?? 3000;

              logger.warn(
                `[LLMService] Retryable stream failure (${retryDecision.category || 'unknown'}) ` +
                  `retry ${streamRetryCount}/${MAX_STREAM_RETRIES}`,
                {
                  iteration: loopState.currentIteration,
                  reason: retryDecision.reason,
                  status: retryDecision.status,
                  hasVisibleOutput: retryDecision.hasVisibleOutput,
                }
              );

              await this.responsesChainManager.prepareRetryableResponsesRequestRetry(
                loopState,
                responseMetadataEvent,
                transportFallbackEvent
              );
              await new Promise((resolve) => setTimeout(resolve, sleepMs));
              continue;
            }

            if (
              !visibleOutput &&
              activeFallbackModels[0] &&
              !retryOrchestrator.isAbortError(streamError)
            ) {
              await promoteFallbackModel(activeFallbackModels[0], retryDecision.reason);
              streamRetryCount = 0;
              streamProcessor.resetState();
              continue;
            }

            if (retryDecision.retryable && streamRetryCount < MAX_STREAM_RETRIES) {
              streamRetryCount++;
              const sleepMs = STREAM_RETRY_BACKOFF_MS[streamRetryCount - 1] ?? 3000;

              logger.warn(
                `[LLMService] Retryable stream failure (${retryDecision.category || 'unknown'}) ` +
                  `retry ${streamRetryCount}/${MAX_STREAM_RETRIES}`,
                {
                  iteration: loopState.currentIteration,
                  reason: retryDecision.reason,
                  status: retryDecision.status,
                  hasVisibleOutput: retryDecision.hasVisibleOutput,
                }
              );

              await this.responsesChainManager.prepareRetryableResponsesRequestRetry(
                loopState,
                responseMetadataEvent,
                transportFallbackEvent
              );
              await new Promise((resolve) => setTimeout(resolve, sleepMs));
              continue;
            }

            if (retryDecision.retryable) {
              throw retryOrchestrator.buildRetryExhaustedError(retryDecision);
            }

            throw streamError;
          }
        } // End of streamRetryLoop

        if (transportFallbackEvent && !shouldRetryFreshWebsocketBaseline && !shouldRetryStateless) {
          const sessionIdToClose =
            responseMetadataEvent?.transportSessionId ??
            loopState.responsesChain?.transportSessionId ??
            null;
          applyTransportFallbackEvent(loopState, transportFallbackEvent);
          await this.responsesChainManager.closeResponsesChainSession(loopState, sessionIdToClose);
          shouldRetryFreshWebsocketBaseline =
            transportFallbackEvent.to === 'fresh-websocket-baseline';
          shouldRetryStateless = transportFallbackEvent.to === 'stateless';
        }

        // This should never happen as the loop exits via break on success or throw on error
        if (!streamResult) {
          throw new Error(t.LLMService.errors.streamResultNull);
        }

        if (shouldAutoCompact) {
          const wasCompacted = await this.compactionManager.runAutoCompaction(
            loopState,
            compressionConfig,
            systemPrompt,
            activeModel,
            isSubagent,
            (ls, sessionId) => this.responsesChainManager.closeResponsesChainSession(ls, sessionId),
            abortController,
            onStatus
          );

          if (!wasCompacted) {
            // === Reactive Compaction ===
            // Auto-compaction failed - try reactive compaction (PTL retry + aggressive truncation)
            logger.info('[LLMService] Auto-compaction failed, attempting reactive compaction');
            try {
              const reactiveResult = await attemptReactiveCompaction(
                loopState.messages,
                this.messageCompactor,
                compressionConfig,
                activeModel,
                systemPrompt
              );

              if (reactiveResult) {
                loopState.messages = convertToAnthropicFormat(reactiveResult.messages, {
                  autoFix: true,
                });
                logger.info('[LLMService] Reactive compaction succeeded, retrying iteration');
                continue;
              }
            } catch (reactiveError) {
              logger.error('[LLMService] Reactive compaction also failed', reactiveError);
            }

            throw new Error(t.LLMService.errors.contextTooLongCompactionFailed);
          }

          // Retry the same iteration with compacted messages.
          continue;
        }

        if (shouldRetryFreshWebsocketBaseline) {
          logger.info('[LLMService] Retrying turn with a fresh websocket full-history baseline', {
            iteration: loopState.currentIteration,
            providerId: activeProviderId ?? 'unknown',
            model: activeModel,
          });
          continue;
        }

        if (shouldRetryStateless) {
          logger.info(
            '[LLMService] Retrying follow-up turn in stateless mode after chain rejection',
            {
              iteration: loopState.currentIteration,
              providerId: activeProviderId ?? 'unknown',
              model: activeModel,
            }
          );
          continue;
        }

        // Get processed data from stream processor
        const toolCalls = streamProcessor.getToolCalls();
        const hasError = streamProcessor.hasError();

        // Process tool calls manually
        // Check if we should finish the loop
        if (hasError) {
          // If there was an error, continue to next iteration
          logger.info('Error occurred, continuing to next iteration');
          continue;
        }

        if (!loopState.lastFinishReason) {
          loopState.lastFinishReason = 'stop';
        }

        // Handle truncation finish reasons (length/max_tokens) by auto-continuing.
        // When the model hits the output token limit, it returns a truncation finish
        // reason. Instead of treating this as a normal stop, we continue the conversation
        // by appending the partial assistant message and a "continue" user message,
        // so the model picks up where it left off.
        if (isTruncationFinishReason(loopState.lastFinishReason) && toolCalls.length === 0) {
          loopState.autoContinueCount = (loopState.autoContinueCount || 0) + 1;

          if (loopState.autoContinueCount <= MAX_AUTO_CONTINUE_ATTEMPTS) {
            logger.info('Output truncated, auto-continuing', {
              finishReason: loopState.lastFinishReason,
              autoContinueCount: loopState.autoContinueCount,
              maxAutoContinue: MAX_AUTO_CONTINUE_ATTEMPTS,
              iteration: loopState.currentIteration,
            });

            // Add assistant message with current (truncated) content
            const assistantContent = streamProcessor.getAssistantContent();
            if (assistantContent.length > 0) {
              const { messages: transformedMessages, transformedContent } =
                MessageTransform.transform(
                  loopState.messages,
                  activeModel,
                  activeProviderId,
                  assistantContent
                );
              loopState.messages = transformedMessages;

              const assistantMessage: ModelMessage = {
                role: 'assistant',
                content: transformedContent?.content ?? assistantContent,
                ...(transformedContent?.providerOptions && {
                  providerOptions: transformedContent.providerOptions,
                }),
              };
              loopState.messages.push(assistantMessage);
            }

            // Finalize responses chain turn before continuing
            this.responsesChainManager.finalizeResponsesChainTurn(
              loopState,
              responseMetadataEvent,
              transportFallbackEvent,
              didFallbackToStateless,
              loopState.messages.length
            );

            // Add continuation user message to prompt the model to resume
            const continueMessage: ModelMessage = {
              role: 'user',
              content: 'Continue from where you left off.',
            };
            loopState.messages.push(continueMessage);

            // Reset for next iteration but do NOT set isComplete
            streamProcessor.resetState();
            loopState.toolSummaries = [];
            loopState.unknownFinishReasonCount = 0;
            continue;
          }

          // Max auto-continue attempts reached — fall through to normal completion
          logger.warn('Max auto-continue attempts reached after truncation', {
            autoContinueCount: loopState.autoContinueCount,
            iteration: loopState.currentIteration,
          });
        }

        // Handle "unknown" finish reason by retrying without modifying messages.
        // Also treat finish reasons that are neither normal, truncation, nor 'other'
        // as unknown (e.g., unrecognized provider-specific values).
        const isUnknownReason =
          loopState.lastFinishReason !== 'other' &&
          !isNormalFinishReason(loopState.lastFinishReason) &&
          !isTruncationFinishReason(loopState.lastFinishReason);

        if ((loopState.lastFinishReason === 'other' || isUnknownReason) && toolCalls.length === 0) {
          const maxUnknownRetries = 3;
          loopState.unknownFinishReasonCount = (loopState.unknownFinishReasonCount || 0) + 1;

          logger.warn('Unknown finish reason detected', {
            provider: activeProviderId ?? 'unknown',
            model: activeModel,
            retryCount: loopState.unknownFinishReasonCount,
            maxRetries: maxUnknownRetries,
            iteration: loopState.currentIteration,
          });

          if (loopState.unknownFinishReasonCount <= maxUnknownRetries) {
            // Apply provider-specific backoff multiplier — some providers
            // (e.g., OpenRouter, Zhipu) need longer waits before retrying.
            const baseSleepSeconds = loopState.unknownFinishReasonCount; // 1s, 2s, 3s
            const providerMultiplier = PROVIDER_BACKOFF_MULTIPLIERS[activeProviderId ?? ''] ?? 1.0;
            const sleepSeconds = Math.ceil(baseSleepSeconds * providerMultiplier);
            logger.info(
              `Retrying for unknown finish reason (${loopState.unknownFinishReasonCount}/${maxUnknownRetries}), sleeping ${sleepSeconds}s` +
                (providerMultiplier > 1
                  ? ` (provider=${activeProviderId}, multiplier=${providerMultiplier})`
                  : '')
            );
            await new Promise((resolve) => setTimeout(resolve, sleepSeconds * 1000));
            // Retry without modifying loopState.messages
            continue;
          }

          // Max retries reached
          logger.error('Max unknown finish reason retries reached', {
            retries: loopState.unknownFinishReasonCount,
            provider: activeProviderId ?? 'unknown',
            model: activeModel,
          });
          throw new Error(t.LLMService.errors.unknownFinishReason);
        }

        if (abortController?.signal.aborted) {
          rejectOnAbort('Agent loop aborted before completion hooks');
          return;
        }

        // Run completion hook pipeline on successful finish (no tool calls)
        const shouldRunCompletionHooks =
          this.taskId &&
          toolCalls.length === 0 &&
          !isSubagent &&
          (!agentId || agentId === 'planner');

        logger.info('[LLMService] Completion hook eligibility evaluated', {
          taskId: this.taskId,
          iteration: loopState.currentIteration,
          toolCallCount: toolCalls.length,
          isSubagent,
          agentId: agentId ?? 'default',
          shouldRunCompletionHooks,
        });

        if (shouldRunCompletionHooks) {
          const fullText = streamProcessor.getFullText();

          // Increment Ralph iteration counter (separate from agent step counter)
          ralphIteration++;

          // Build completion context
          const completionContext = {
            taskId: this.taskId,
            fullText,
            toolSummaries: loopState.toolSummaries,
            loopState,
            iteration: ralphIteration,
            startTime: totalStartTime,
            userMessage: inputMessages.find((m) => m.role === 'user')?.content as
              | string
              | undefined,
            systemPrompt,
          };

          // Run completion hook pipeline
          const result = await completionHookPipeline.run(completionContext);

          if (result.action === 'continue') {
            const continuationMode = result.continuationMode || 'replace';
            let shouldContinueLoop = false;
            let continuationSource:
              | 'replace'
              | 'task-store'
              | 'task-store+next-messages'
              | 'next-messages'
              | 'none' = 'none';

            logger.info('[LLMService] Completion hook requested continuation', {
              taskId: this.taskId,
              iteration: loopState.currentIteration,
              continuationMode,
              nextMessageCount: result.nextMessages?.length || 0,
            });

            if (continuationMode === 'append') {
              if (this.taskId && this.taskId !== 'nested') {
                const latestTaskMessages = this.storeAccess.getMessages(this.taskId);

                logger.info('[LLMService] Inspecting task-store messages for append continuation', {
                  taskId: this.taskId,
                  latestTaskMessageCount: latestTaskMessages.length,
                  latestTaskMessageRoles: latestTaskMessages.map((message) => message.role),
                });

                if (latestTaskMessages.length > 0) {
                  const mergedTaskMessages = result.nextMessages?.length
                    ? this.mergeAppendContinuationMessages(latestTaskMessages, result.nextMessages)
                    : { messages: latestTaskMessages, appendedCount: 0 };

                  const rebuiltMessages = await convertMessages(mergedTaskMessages.messages, {
                    rootPath,
                    systemPrompt,
                    model: activeModel,
                    providerId: activeProviderId,
                  });

                  loopState.messages = convertToAnthropicFormat(rebuiltMessages, {
                    autoFix: true,
                    trimAssistantWhitespace: true,
                  });
                  const sessionId = loopState.responsesChain?.transportSessionId ?? null;
                  await this.responsesChainManager.closeResponsesChainSession(loopState, sessionId);
                  invalidateResponsesChain(loopState, 'history_rewritten');
                  shouldContinueLoop = true;
                  continuationSource =
                    mergedTaskMessages.appendedCount > 0
                      ? 'task-store+next-messages'
                      : 'task-store';

                  logger.info('[LLMService] Rebuilt append continuation context', {
                    taskId: this.taskId,
                    continuationSource,
                    appendedMissingNextMessageCount: mergedTaskMessages.appendedCount,
                  });
                }
              }

              if (!shouldContinueLoop && result.nextMessages && result.nextMessages.length > 0) {
                logger.info('[LLMService] Falling back to nextMessages for append continuation', {
                  taskId: this.taskId,
                  nextMessageCount: result.nextMessages.length,
                  nextMessageRoles: result.nextMessages.map((message) => message.role),
                });

                const appendedMessages = await convertMessages(result.nextMessages, {
                  rootPath,
                  systemPrompt: undefined,
                  model: activeModel,
                  providerId: activeProviderId,
                });

                loopState.messages = convertToAnthropicFormat(
                  [...loopState.messages, ...appendedMessages],
                  {
                    autoFix: true,
                    trimAssistantWhitespace: true,
                  }
                );
                shouldContinueLoop = true;
                continuationSource = 'next-messages';
              }
            } else if (result.nextMessages) {
              logger.info('[LLMService] Replacing loop context from nextMessages', {
                taskId: this.taskId,
                nextMessageCount: result.nextMessages.length,
                nextMessageRoles: result.nextMessages.map((message) => message.role),
              });

              const newModelMessages = await convertMessages(result.nextMessages, {
                rootPath,
                systemPrompt,
                model: activeModel,
                providerId: activeProviderId,
              });

              loopState.messages = convertToAnthropicFormat(newModelMessages, {
                autoFix: true,
                trimAssistantWhitespace: true,
              });
              const sessionId = loopState.responsesChain?.transportSessionId ?? null;
              await this.responsesChainManager.closeResponsesChainSession(loopState, sessionId);
              invalidateResponsesChain(loopState, 'history_rewritten');
              shouldContinueLoop = true;
              continuationSource = 'replace';
            }

            if (!shouldContinueLoop) {
              logger.warn('[LLMService] Completion continue request ignored due to empty context', {
                taskId: this.taskId,
                continuationMode,
                taskStoreAvailable: !!this.taskId && this.taskId !== 'nested',
                nextMessageCount: result.nextMessages?.length || 0,
              });
            } else {
              logger.info('[LLMService] Applying completion continuation context', {
                taskId: this.taskId,
                continuationMode,
                continuationSource,
                messageCount: loopState.messages.length,
              });

              // Reset loop state for next iteration
              loopState.lastRequestTokens = 0;
              loopState.unknownFinishReasonCount = 0;
              loopState.autoContinueCount = 0;
              loopState.lastFinishReason = undefined;
              loopState.isComplete = false;

              // Reset tool summaries for next iteration
              loopState.toolSummaries = [];

              // Reset stream processor for fresh iteration
              streamProcessor.fullReset();

              // Continue the loop with updated context
              continue;
            }
          }

          if (result.action === 'stop') {
            // Hook requested stop
            logger.info('[LLMService] Completion hook requested stop', {
              taskId: this.taskId,
              stopReason: result.stopReason,
              stopMessage: result.stopMessage,
            });

            // Continue to final completion
          }
        }

        if (toolCalls.length > 0) {
          // Check for abort signal before execution
          if (abortController?.signal.aborted) {
            rejectOnAbort('Agent loop aborted before tool execution');
            return;
          }

          const baselineMessageCount = loopState.messages.length + 1;

          // Build combined assistant message with text/reasoning AND tool calls before
          // executing tools so emitted tool-call messages can persist the same reasoning_content.
          const assistantContent = streamProcessor.getAssistantContent();
          const toolCallParts = toolCalls.map((tc) => {
            // Defensive: ensure input is object format (some providers return JSON string)
            let input = tc.input;
            if (typeof input === 'string') {
              try {
                input = JSON.parse(input);
              } catch {
                // If parsing fails, wrap as object to satisfy API requirements
                input = { value: input };
              }
            }
            const part: ContentPart = {
              type: 'tool-call' as const,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input,
            };
            // Include providerMetadata if present (for Gemini 3 models with thoughtSignature)
            if (tc.providerMetadata) {
              part.providerMetadata = tc.providerMetadata;
            }
            return part;
          });

          const combinedAssistantContent: ContentPart[] = [...assistantContent, ...toolCallParts];

          // Apply provider-specific transformation to both history and current assistant turn.
          const { messages: transformedMessages, transformedContent } = MessageTransform.transform(
            loopState.messages,
            activeModel,
            activeProviderId,
            combinedAssistantContent
          );

          loopState.messages = transformedMessages;
          const reasoningContent =
            transformedContent?.providerOptions?.openaiCompatible?.reasoning_content;
          const toolCallsWithReasoning = toolCalls.map((toolCall) => ({
            ...toolCall,
            reasoningContent,
          }));

          const toolExecutionOptions = {
            tools: filteredTools,
            loopState,
            model: activeModel,
            abortController,
            onToolMessage,
            taskId: this.taskId,
            rootPath,
            subagentId,
          };

          // Execute tools with result capture callback
          const results = await this.toolExecutor.executeWithSmartConcurrency(
            toolCallsWithReasoning,
            toolExecutionOptions,
            onStatus,
            // Capture tool results for completion hooks
            (toolName, result, toolCallId) => {
              if (loopState) {
                this.captureToolResult(toolName, result, toolCallId, loopState);
              }
            }
          );

          onAssistantReasoning?.(reasoningContent);

          const assistantMessage: ModelMessage = {
            role: 'assistant',
            content: transformedContent?.content ?? combinedAssistantContent,
            ...(transformedContent?.providerOptions && {
              providerOptions: transformedContent.providerOptions,
            }),
          };
          loopState.messages.push(assistantMessage);

          const toolResultMessage: ModelMessage = {
            role: 'tool',
            content: results.map(({ toolCall, result }) => ({
              type: 'tool-result' as const,
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              output: {
                type: 'text' as const,
                value: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
              },
            })),
          };
          loopState.messages.push(toolResultMessage);
          this.responsesChainManager.finalizeResponsesChainTurn(
            loopState,
            responseMetadataEvent,
            transportFallbackEvent,
            didFallbackToStateless,
            baselineMessageCount
          );
        } else {
          // No tool calls - only add assistant message if there's text/reasoning content
          const assistantContent = streamProcessor.getAssistantContent();
          const baselineMessageCount =
            assistantContent.length > 0 ? loopState.messages.length + 1 : loopState.messages.length;
          if (assistantContent.length > 0) {
            const { messages: transformedMessages, transformedContent } =
              MessageTransform.transform(
                loopState.messages,
                activeModel,
                activeProviderId,
                assistantContent
              );
            loopState.messages = transformedMessages;
            onAssistantReasoning?.(
              transformedContent?.providerOptions?.openaiCompatible?.reasoning_content
            );

            const assistantMessage: ModelMessage = {
              role: 'assistant',
              content: transformedContent?.content ?? assistantContent,
              ...(transformedContent?.providerOptions && {
                providerOptions: transformedContent.providerOptions,
              }),
            };
            loopState.messages.push(assistantMessage);
          }

          this.responsesChainManager.finalizeResponsesChainTurn(
            loopState,
            responseMetadataEvent,
            transportFallbackEvent,
            didFallbackToStateless,
            baselineMessageCount
          );
          loopState.isComplete = true;
          break;
        }
      }

      const totalDuration = Date.now() - totalStartTime;
      await this.responsesChainManager.closeResponsesChainSession(loopState);
      logger.info('Agent loop completed', {
        totalIterations: loopState.currentIteration,
        finalFinishReason: loopState.lastFinishReason,
        totalDurationMs: totalDuration,
        totalDurationSeconds: (totalDuration / 1000).toFixed(2),
        fullTextLength: streamProcessor.getFullText().length,
      });
      const fullText = streamProcessor.getFullText();
      onComplete?.(fullText);
      if (this.taskId && this.taskId !== 'nested') {
        lastReviewedChangeTimestamp.delete(this.taskId);
      }
      return;
    } catch (error) {
      if (loopState) {
        await this.responsesChainManager.closeResponsesChainSession(loopState);
      }
      // Log the raw error object before processing
      logger.error('Raw error caught in main loop:', error);

      // Log error properties for debugging
      if (error && typeof error === 'object') {
        const errorObj = error as Record<string, unknown>;

        // Serialize error properties to avoid [object Object]
        const serializedError: Record<string, unknown> = {
          name: errorObj.name,
          message: errorObj.message,
          stack: errorObj.stack,
          // Include enhanced fetch context if available
          context: errorObj.context,
        };

        // Recursively serialize cause chain
        if (errorObj.cause) {
          const causeChain: Array<Record<string, unknown>> = [];
          let currentCause: unknown = errorObj.cause;
          let depth = 0;
          const maxDepth = MAX_ERROR_CAUSE_CHAIN_DEPTH;

          while (currentCause && depth < maxDepth) {
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

        logger.error('Error properties:', JSON.stringify(serializedError, null, 2));
      }

      const loopError = this.errorHandler.handleMainLoopError(error, activeModel, onError);

      if (this.taskId && this.taskId !== 'nested') {
        lastReviewedChangeTimestamp.delete(this.taskId);
      }

      logger.error('Agent loop error', error, {
        phase: 'main-loop',
        model: activeModel,
      });

      throw loopError;
    }
  }
}

/**
 * Create a new LLMService instance for a specific task.
 * Use this for parallel task execution where each task needs isolated state.
 * @param taskId The unique task ID (equivalent to conversationId)
 */
export function createLLMService(taskId: string): LLMService {
  return new LLMService(taskId);
}
