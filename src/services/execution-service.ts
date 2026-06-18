// src/services/execution-service.ts
/**
 * ExecutionService - LLM execution management
 *
 * This service manages the execution of AI agent loops:
 * - Starts and stops task executions
 * - Manages LLMService instances per task
 * - Coordinates between stores and services
 *
 * Design principles:
 * - Each task gets its own LLMService instance for isolation
 * - Concurrent execution support (up to maxConcurrent tasks)
 * - All callbacks route through MessageService for persistence
 */

import { logger } from '@/lib/logger';
import { autoCodeReviewHookService } from '@/services/agents/auto-code-review-hook-service';
import { autoGitCommitHookService } from '@/services/agents/auto-git-commit-hook-service';
import { checkFinishHookService } from '@/services/agents/check-finish-hook-service';
import { completionHookPipeline } from '@/services/agents/llm-completion-hooks';
import { createLLMService, type LLMService } from '@/services/agents/llm-service';
import { ralphLoopService } from '@/services/agents/ralph-loop-service';
import { stopHookService } from '@/services/agents/stop-hook-service';
import { messageService } from '@/services/message-service';
import { notificationService } from '@/services/notification-service';
import { RustRuntimeAdapter } from '@/services/rust-runtime-adapter';
import { taskQueueService } from '@/services/task-queue-service';
import { taskService } from '@/services/task-service';
import { getEffectiveWorkspaceRoot } from '@/services/workspace-root-service';
import { useExecutionStore } from '@/stores/execution-store';
import { settingsManager } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { useWorktreeStore } from '@/stores/worktree-store';
import type { AgentToolSet, UIMessage } from '@/types/agent';

/**
 * Configuration for starting an execution
 */
export interface ExecutionConfig {
  taskId: string;
  messages: UIMessage[];
  model: string;
  fallbackModels?: string[];
  systemPrompt?: string;
  tools?: AgentToolSet;
  agentId?: string;
  isNewTask?: boolean;
  userMessage?: string;
}

/**
 * Callbacks for execution events
 */
export interface ExecutionCallbacks {
  onComplete?: (result: { success: boolean; fullText: string }) => void;
  onError?: (error: Error) => void;
}

class ExecutionService {
  private llmServiceInstances = new Map<string, LLMService>();
  private rustRuntimeAdapters = new Map<string, RustRuntimeAdapter>();
  private hooksRegistered = false;

  private async getTaskProjectId(taskId: string): Promise<string | null> {
    const task = await taskService.getTaskDetails(taskId);
    return task?.project_id ?? null;
  }

  /**
   * Register completion hooks (called once during app initialization)
   */
  registerCompletionHooks(): void {
    if (this.hooksRegistered) {
      return;
    }

    // Register hooks in priority order:
    // 10: Stop Hook (first)
    // 20: Ralph Loop (second)
    // 25: Auto Git Commit (third)
    // 26: Check Finish (fourth, after git commit, before code review)
    // 30: Auto Code Review (last)
    completionHookPipeline.register(stopHookService);
    completionHookPipeline.register(ralphLoopService);
    completionHookPipeline.register(autoGitCommitHookService);
    completionHookPipeline.register(checkFinishHookService);
    completionHookPipeline.register(autoCodeReviewHookService);

    logger.info('[ExecutionService] Registered completion hooks', {
      hooks: completionHookPipeline.getRegisteredHooks(),
    });

    this.hooksRegistered = true;
  }

  /**
   * Start execution for a task
   */
  async startExecution(config: ExecutionConfig, callbacks?: ExecutionCallbacks): Promise<void> {
    const { taskId, messages, model, fallbackModels, systemPrompt, tools, agentId } = config;

    const executionStore = useExecutionStore.getState();
    const executionRootPath = await getEffectiveWorkspaceRoot(taskId);

    // 1. Check concurrency limit and start execution tracking
    const { success, abortController, error } = executionStore.startExecution(taskId);
    if (!success || !abortController) {
      const execError = new Error(error || 'Failed to start execution');
      callbacks?.onError?.(execError);
      throw execError;
    }

    // 2. Try to acquire worktree for parallel execution (if enabled and needed)
    const runningTaskIds = this.getRunningTaskIds().filter((id) => id !== taskId);
    let worktreePath: string | null = null;
    try {
      worktreePath = await useWorktreeStore.getState().acquireForTask(taskId, runningTaskIds);
      if (worktreePath) {
        logger.info('[ExecutionService] Task using worktree', { taskId, worktreePath });
      }
    } catch (worktreeError) {
      // Log warning but continue - task will work in main project directory
      logger.warn(
        '[ExecutionService] Worktree acquisition failed, using main project',
        worktreeError
      );
    }

    let currentMessageId = '';
    let streamedContent = '';
    let currentReasoningContent: string | undefined;
    let currentStreamingReasoningContent: string | undefined;
    let llmService: LLMService | undefined;

    try {
      // Helper: check if current assistant message has visible output
      const hasCurrentAssistantOutput = () => {
        return (
          streamedContent.length > 0 || (currentStreamingReasoningContent?.trim().length ?? 0) > 0
        );
      };

      // Helper: finalize the current streaming message and persist usage
      const finalizeExecution = async (finalText?: string) => {
        const text =
          finalText && finalText.length >= streamedContent.length
            ? finalText
            : streamedContent || '';
        if (currentMessageId && hasCurrentAssistantOutput()) {
          await messageService.finalizeMessage(
            taskId,
            currentMessageId,
            text,
            currentReasoningContent ?? currentStreamingReasoningContent
          );
          streamedContent = '';
          currentReasoningContent = undefined;
          currentStreamingReasoningContent = undefined;
        }

        const runningUsage = useTaskStore.getState().runningTaskUsage.get(taskId);
        if (runningUsage) {
          try {
            await taskService.updateTaskUsage(
              taskId,
              runningUsage.costDelta,
              runningUsage.inputTokensDelta,
              runningUsage.outputTokensDelta,
              runningUsage.requestCountDelta,
              runningUsage.contextUsage
            );
            useTaskStore.getState().flushRunningTaskUsage(taskId);
          } catch (err) {
            logger.warn('[ExecutionService] Failed to persist task usage', err);
          } finally {
            useTaskStore.getState().clearRunningTaskUsage(taskId);
          }
        }
      };

      // Helper: handle task completion (finalize, notify, queue)
      const handleCompletion = async (fullText: string, success: boolean = true) => {
        if (abortController.signal.aborted) return;

        await finalizeExecution(fullText);

        if (success) {
          try {
            await notificationService.notifyHooked(
              taskId,
              'Task Complete',
              'TalkCody agent has finished processing',
              'agent_complete'
            );
          } catch (err) {
            logger.warn('[ExecutionService] Notification failed', err);
          }
        }

        callbacks?.onComplete?.({ success, fullText });

        const projectId = await this.getTaskProjectId(taskId);
        if (projectId) {
          await taskQueueService.handleExecutionTerminalState({
            taskId,
            projectId,
            status: success ? 'completed' : 'error',
          });
        }
      };

      // Check if the Rust runtime should be used instead of the TS agent loop.
      // When enabled, the Rust CoreRuntime handles the full agent loop, tool
      // execution, message persistence, and streaming — the TS side only
      // renders events received via Tauri.
      const useRustRuntime = await this.shouldUseRustRuntime();

      if (useRustRuntime) {
        await this.startExecutionViaRust(
          taskId,
          agentId,
          executionRootPath,
          worktreePath,
          abortController,
          config.userMessage,
          messages,
          {
            onAssistantMessageStart: () => {
              if (abortController.signal.aborted) return;
              if (currentMessageId && !hasCurrentAssistantOutput()) return;
              if (currentMessageId && hasCurrentAssistantOutput()) {
                messageService
                  .finalizeMessage(
                    taskId,
                    currentMessageId,
                    streamedContent,
                    currentReasoningContent ?? currentStreamingReasoningContent
                  )
                  .catch((err) => logger.error('Failed to finalize previous message:', err));
                currentReasoningContent = undefined;
                currentStreamingReasoningContent = undefined;
              }
              streamedContent = '';
              currentMessageId = messageService.createAssistantMessage(taskId, agentId);
              currentReasoningContent = undefined;
              currentStreamingReasoningContent = undefined;
            },
            onChunk: (chunk: string) => {
              if (abortController.signal.aborted) return;
              streamedContent += chunk;
              if (currentMessageId) {
                messageService.updateStreamingContent(taskId, currentMessageId, streamedContent);
              }
            },
            onComplete: async (fullText: string) => {
              if (abortController.signal.aborted) return;
              await handleCompletion(fullText);
            },
            onError: async (error: Error) => {
              if (abortController.signal.aborted) return;
              logger.error('[ExecutionService] Rust runtime error', error);
              executionStore.setError(taskId, error.message);
              useTaskStore.getState().clearRunningTaskUsage(taskId);
              const projectId = await this.getTaskProjectId(taskId);
              if (projectId) {
                await taskQueueService.handleExecutionTerminalState({
                  taskId,
                  projectId,
                  status: 'error',
                });
              }
              callbacks?.onError?.(error);
            },
            onStatus: (status: string) => {
              if (abortController.signal.aborted) return;
              executionStore.setServerStatus(taskId, status);
            },
            onUsage: (usage) => {
              if (abortController.signal.aborted) return;
              useTaskStore.getState().updateTaskUsage(taskId, {
                costDelta: 0,
                inputTokensDelta: usage.inputTokens,
                outputTokensDelta: usage.outputTokens,
                requestCountDelta: 1,
                contextUsage: usage.contextUsage,
                contextPercentLeft: usage.contextPercentLeft,
                isAboveWarningThreshold: usage.isAboveWarningThreshold,
                isAboveErrorThreshold: usage.isAboveErrorThreshold,
                isAboveAutoCompactThreshold: usage.isAboveAutoCompactThreshold,
                isAtBlockingLimit: usage.isAtBlockingLimit,
              });
              useTaskStore.getState().flushRunningTaskUsage(taskId);
              useTaskStore.getState().updateTask(taskId, {
                last_request_input_token: usage.inputTokens,
              });
            },
            onToolMessage: (message: UIMessage) => {
              if (abortController.signal.aborted) return;
              const toolMessage: UIMessage = {
                ...message,
                assistantId: message.assistantId || agentId,
              };
              messageService.addToolMessage(taskId, toolMessage);
            },
            onReasoningUpdate: (payload: { reasoningContent: string; isStreaming: boolean }) => {
              if (abortController.signal.aborted) return;
              currentStreamingReasoningContent = payload.reasoningContent;
              if (currentMessageId) {
                messageService.updateStreamingReasoning(
                  taskId,
                  currentMessageId,
                  payload.reasoningContent,
                  payload.isStreaming
                );
              }
              if (!payload.isStreaming) {
                currentReasoningContent = payload.reasoningContent;
              }
            },
          }
        );
        return;
      }

      // 3. Create independent LLMService instance for this task
      llmService = createLLMService(taskId);
      this.llmServiceInstances.set(taskId, llmService);

      // Run agent loop with callbacks that route through services
      // Completion hooks (stop hook, ralph loop, auto review) are handled internally by LLMService
      await llmService.runAgentLoop(
        {
          messages,
          model,
          fallbackModels,
          systemPrompt,
          tools,
          agentId,
          rootPath: executionRootPath,
        },
        {
          onAssistantMessageStart: () => {
            if (abortController.signal.aborted) return;

            // Skip if a message was just created but hasn't received visible content yet
            if (currentMessageId && !hasCurrentAssistantOutput()) {
              logger.info('[ExecutionService] Skipping duplicate message start', { taskId });
              return;
            }

            // Finalize previous message if any
            if (currentMessageId && hasCurrentAssistantOutput()) {
              messageService
                .finalizeMessage(
                  taskId,
                  currentMessageId,
                  streamedContent,
                  currentReasoningContent ?? currentStreamingReasoningContent
                )
                .catch((err) => logger.error('Failed to finalize previous message:', err));
              currentReasoningContent = undefined;
              currentStreamingReasoningContent = undefined;
            }

            // Reset for new message
            streamedContent = '';
            currentMessageId = messageService.createAssistantMessage(taskId, agentId);
            currentReasoningContent = undefined;
            currentStreamingReasoningContent = undefined;
          },

          onChunk: (chunk: string) => {
            if (abortController.signal.aborted) return;
            streamedContent += chunk;
            if (currentMessageId) {
              messageService.updateStreamingContent(taskId, currentMessageId, streamedContent);
            }
          },

          onComplete: async (fullText: string) => {
            if (abortController.signal.aborted) return;

            await handleCompletion(fullText);
          },

          onError: async (error: Error) => {
            if (abortController.signal.aborted) return;

            logger.error('[ExecutionService] Agent loop error', error);
            executionStore.setError(taskId, error.message);

            // Clear running usage on error to avoid stale data
            useTaskStore.getState().clearRunningTaskUsage(taskId);

            const projectId = await this.getTaskProjectId(taskId);
            if (projectId) {
              await taskQueueService.handleExecutionTerminalState({
                taskId,
                projectId,
                status: 'error',
              });
            }

            callbacks?.onError?.(error);
          },

          onStatus: (status: string) => {
            if (abortController.signal.aborted) return;
            executionStore.setServerStatus(taskId, status);
          },

          onToolMessage: async (uiMessage: UIMessage) => {
            if (abortController.signal.aborted) return;

            const toolMessage: UIMessage = {
              ...uiMessage,
              assistantId: uiMessage.assistantId || agentId,
            };

            await messageService.addToolMessage(taskId, toolMessage);
          },

          onAssistantReasoning: (reasoningContent?: string) => {
            if (abortController.signal.aborted) return;
            currentReasoningContent = reasoningContent;
          },

          onReasoningUpdate: ({ reasoningContent, isStreaming }) => {
            if (abortController.signal.aborted) return;
            currentStreamingReasoningContent = reasoningContent;
            if (currentMessageId) {
              messageService.updateStreamingReasoning(
                taskId,
                currentMessageId,
                reasoningContent,
                isStreaming
              );
            }
          },

          onAttachment: async (attachment) => {
            if (abortController.signal.aborted) return;
            if (currentMessageId) {
              await messageService.addAttachment(taskId, currentMessageId, attachment);
            }
          },
        },
        abortController
      );
    } catch (error) {
      if (!abortController.signal.aborted) {
        const execError = error instanceof Error ? error : new Error(String(error));
        executionStore.setError(taskId, execError.message);
        callbacks?.onError?.(execError);
      }
    } finally {
      this.llmServiceInstances.delete(taskId);
      this.rustRuntimeAdapters.get(taskId)?.dispose();
      this.rustRuntimeAdapters.delete(taskId);

      // Release worktree if acquired
      if (worktreePath && useWorktreeStore.getState().isTaskUsingWorktree(taskId)) {
        useWorktreeStore
          .getState()
          .releaseForTask(taskId)
          .catch((err) => {
            logger.warn('[ExecutionService] Failed to release worktree', err);
          });
      }

      // Only mark as completed if still running (not already stopped or errored)
      if (executionStore.isRunning(taskId)) {
        executionStore.completeExecution(taskId);
      }
    }
  }

  /**
   * Stop execution for a task
   */
  async stopExecution(taskId: string): Promise<void> {
    const executionStore = useExecutionStore.getState();
    executionStore.stopExecution(taskId);
    this.llmServiceInstances.delete(taskId);
    const rustRuntimeAdapter = this.rustRuntimeAdapters.get(taskId);
    this.rustRuntimeAdapters.delete(taskId);
    if (rustRuntimeAdapter) {
      try {
        await rustRuntimeAdapter.cancel();
      } catch (error) {
        logger.warn('[ExecutionService] Failed to cancel Rust runtime task', error);
      } finally {
        rustRuntimeAdapter.dispose();
      }
    }

    // Stop streaming in task store
    useTaskStore.getState().stopStreaming(taskId);

    // Clear running usage to avoid stale metrics
    useTaskStore.getState().clearRunningTaskUsage(taskId);

    const projectId = await this.getTaskProjectId(taskId);
    if (projectId) {
      await taskQueueService.handleExecutionTerminalState({
        taskId,
        projectId,
        status: 'stopped',
      });
    }

    logger.info('[ExecutionService] Execution stopped', { taskId });
  }

  /**
   * Check if a task is running
   */
  isRunning(taskId: string): boolean {
    return useExecutionStore.getState().isRunning(taskId);
  }

  /**
   * Get running task IDs
   */
  getRunningTaskIds(): string[] {
    return useExecutionStore.getState().getRunningTaskIds();
  }

  /**
   * Check if a new execution can be started
   */
  canStartNew(): boolean {
    return useExecutionStore.getState().canStartNew();
  }

  /**
   * Check if the Rust runtime should be used instead of the TS agent loop.
   * Reads the `use_rust_runtime` setting from the database.
   * Returns false by default — the Rust runtime is opt-in.
   */
  private async shouldUseRustRuntime(): Promise<boolean> {
    try {
      const value = settingsManager.get('use_rust_runtime');
      return typeof value === 'string' && value.toLowerCase() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Start execution via the Rust CoreRuntime.
   *
   * This is the alternative to `llmService.runAgentLoop()`. The Rust runtime
   * handles the full agent loop internally — this method only bridges events
   * to the TS-side callbacks for UI rendering.
   */
  private async startExecutionViaRust(
    taskId: string,
    agentId: string | undefined,
    rootPath: string,
    worktreePath: string | null,
    abortController: AbortController,
    userMessage: string | undefined,
    messages: UIMessage[],
    callbacks: {
      onAssistantMessageStart?: () => void;
      onChunk: (chunk: string) => void;
      onComplete?: (fullText: string) => void;
      onError?: (error: Error) => void;
      onStatus?: (status: string) => void;
      onUsage?: (payload: {
        inputTokens: number;
        outputTokens: number;
        totalTokens?: number;
        contextUsage?: number;
        contextPercentLeft?: number;
        isAboveWarningThreshold?: boolean;
        isAboveErrorThreshold?: boolean;
        isAboveAutoCompactThreshold?: boolean;
        isAtBlockingLimit?: boolean;
      }) => void;
      onToolMessage?: (message: UIMessage) => void;
      onReasoningUpdate?: (payload: { reasoningContent: string; isStreaming: boolean }) => void;
    }
  ): Promise<void> {
    // Load task settings to pass to the Rust runtime
    let taskSettings: Record<string, unknown> | undefined;
    try {
      const settingsJson = await taskService.getTaskSettings(taskId);
      if (settingsJson) {
        taskSettings = JSON.parse(settingsJson);
      }
    } catch {
      // Settings are optional
    }

    // Determine the model from task settings or default
    const model =
      (taskSettings?.model as string) ?? settingsManager.get('model') ?? 'gpt-4o@openai';

    const latestUserMessageFromHistory = [...messages]
      .reverse()
      .find((message): message is UIMessage & { content: string } => {
        return message.role === 'user' && typeof message.content === 'string';
      })?.content;
    const latestUserMessage = userMessage ?? latestUserMessageFromHistory ?? '';

    // Build the workspace info
    const workspace = {
      rootPath,
      worktreePath: worktreePath ?? undefined,
    };

    // Build the TaskInput for the Rust runtime
    const input = {
      sessionId: taskId,
      agentId: agentId ?? undefined,
      projectId: undefined,
      initialMessage: latestUserMessage,
      settings: taskSettings
        ? {
            autoApproveEdits: taskSettings.autoApproveEdits,
            autoApprovePlan: taskSettings.autoApprovePlan,
            autoCodeReview: taskSettings.autoCodeReview,
            extra: {
              ...taskSettings,
              model,
            },
          }
        : {
            extra: { model },
          },
      workspace,
    };

    const adapter = new RustRuntimeAdapter();
    this.rustRuntimeAdapters.set(taskId, adapter);

    await adapter.start(input, callbacks, abortController.signal).catch(() => {});
  }
}

export const executionService = new ExecutionService();
