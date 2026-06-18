/**
 * RustRuntimeAdapter
 *
 * Bridges the Rust CoreRuntime (via Tauri commands + events) to the
 * existing AgentLoopCallbacks interface used by ExecutionService.
 *
 * When enabled, this replaces the TS-side `LLMService.runAgentLoop()` path.
 * The Rust runtime handles: agent loop, tool execution, hooks, permissions,
 * message persistence, and streaming — the TS side only renders events.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getToolMetadata } from '@/lib/tools';
import type { MessageAttachment, UIMessage } from '@/types/agent';

/** RuntimeEvent payload emitted by the Rust runtime. */
interface RuntimeEventPayload {
  type: string;
  taskId?: string;
  sessionId?: string;
  state?: string;
  previousState?: string;
  message?: RuntimeStorageMessage | string;
  token?: string;
  id?: string;
  text?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextUsage?: number;
  contextPercentLeft?: number;
  isAboveWarningThreshold?: boolean;
  isAboveErrorThreshold?: boolean;
  isAboveAutoCompactThreshold?: boolean;
  isAtBlockingLimit?: boolean;
  request?: { toolCallId: string; name: string; input: unknown };
  result?: { toolCallId: string; name?: string; success: boolean; output: unknown; error?: string };
  errorMessage?: string;
}

interface RuntimeStorageMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content:
    | { type: 'text'; text: string }
    | { type: 'toolCalls' | 'tool_calls'; calls: RuntimeToolCall[] }
    | { type: 'toolResult' | 'tool_result'; result: RuntimeStoredToolResult };
  createdAt: number;
  toolCallId?: string;
  parentId?: string;
}

interface RuntimeToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface RuntimeStoredToolResult {
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  status?: 'success' | 'error';
  errorMessage?: string;
}

export interface RustRuntimeStartInput {
  sessionId: string;
  agentId?: string;
  projectId?: string;
  initialMessage: string;
  settings?: Record<string, unknown>;
  workspace?: { rootPath: string; worktreePath?: string; repositoryUrl?: string; branch?: string };
}

export interface AgentLoopCallbacks {
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

export class RustRuntimeAdapter {
  private unlisten?: UnlistenFn;
  private taskId: string | null = null;
  private sessionId: string | null = null;
  private fullText = '';
  private reasoningText = '';
  private settled = false;
  private abortHandler?: () => void;
  private abortSignal?: AbortSignal;
  private emittedToolMessages = new Set<string>();

  /**
   * Start a runtime task and route events through callbacks.
   */
  async start(
    input: RustRuntimeStartInput,
    callbacks: AgentLoopCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    this.cleanup();
    this.fullText = '';
    this.reasoningText = '';
    this.settled = false;
    this.sessionId = input.sessionId;
    this.emittedToolMessages.clear();

    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    // Subscribe to runtime events BEFORE starting the task to avoid races.
    this.unlisten = await listen<RuntimeEventPayload>(
      `runtime-event:${input.sessionId}`,
      (event) => {
        this.handleEvent(event.payload, callbacks, resolveCompletion, rejectCompletion);
      }
    );

    try {
      this.taskId = await invoke<string>('runtime_start_task', {
        input: {
          sessionId: input.sessionId,
          agentId: input.agentId ?? null,
          projectId: input.projectId ?? null,
          initialMessage: input.initialMessage,
          settings: input.settings ?? null,
          workspace: input.workspace ?? null,
        },
      });

      if (signal) {
        this.abortHandler = () => {
          this.cancel().catch(() => undefined);
        };
        if (signal.aborted) {
          this.abortHandler();
        } else {
          this.abortSignal = signal;
          signal.addEventListener('abort', this.abortHandler, { once: true });
        }
      }
    } catch (error) {
      const runtimeError = error instanceof Error ? error : new Error(String(error));
      this.fail(runtimeError, callbacks, rejectCompletion);
    }

    return completion;
  }

  /**
   * Send an approval/rejection/tool-result to a waiting task.
   */
  async sendAction(action: {
    type: 'approve' | 'reject' | 'toolResult' | 'cancel';
    toolCallId?: string;
    reason?: string;
    result?: unknown;
  }): Promise<void> {
    if (!this.taskId) return;

    let payload: Record<string, unknown> | string;
    switch (action.type) {
      case 'approve':
        payload = { approve: { toolCallId: action.toolCallId } };
        break;
      case 'reject':
        payload = {
          reject: {
            toolCallId: action.toolCallId,
            reason: action.reason ?? null,
          },
        };
        break;
      case 'toolResult':
        payload = {
          toolResult: {
            toolCallId: action.toolCallId,
            result: action.result ?? null,
          },
        };
        break;
      case 'cancel':
        payload = 'cancel';
        break;
    }

    await invoke('runtime_send_action', { taskId: this.taskId, action: payload });
  }

  /**
   * Get the current task state.
   */
  async getTaskState(): Promise<string | null> {
    if (!this.taskId) return null;
    return invoke<string | null>('runtime_get_task_state', { taskId: this.taskId });
  }

  async cancel(): Promise<void> {
    if (!this.taskId) return;
    await invoke('runtime_cancel_task', { taskId: this.taskId });
  }

  private belongsToCurrentExecution(payload: RuntimeEventPayload): boolean {
    if (this.taskId && payload.taskId && payload.taskId !== this.taskId) {
      return false;
    }
    if (this.sessionId && payload.sessionId && payload.sessionId !== this.sessionId) {
      return false;
    }
    if (payload.taskId || payload.sessionId) {
      return true;
    }
    return false;
  }

  private extractAttachments(result: unknown): MessageAttachment[] | undefined {
    if (!result || typeof result !== 'object') {
      return undefined;
    }

    const record = result as Record<string, unknown>;
    const attachmentsValue = record.attachments ?? record._attachments;
    if (!Array.isArray(attachmentsValue)) {
      return undefined;
    }

    const attachments: MessageAttachment[] = [];
    for (const item of attachmentsValue) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const attachment = item as Record<string, unknown>;
      const type = attachment.type;
      if (type !== 'image' && type !== 'video' && type !== 'file' && type !== 'code') {
        continue;
      }

      const filename = attachment.filename;
      const filePath = attachment.filePath;
      const mimeType = attachment.mimeType;
      const size = attachment.size;

      if (
        typeof filename !== 'string' ||
        typeof filePath !== 'string' ||
        typeof mimeType !== 'string' ||
        typeof size !== 'number'
      ) {
        continue;
      }

      attachments.push({
        id: typeof attachment.id === 'string' ? attachment.id : `${filePath}:${filename}`,
        type,
        filename,
        content: typeof attachment.content === 'string' ? attachment.content : undefined,
        filePath,
        mimeType,
        size,
      });
    }

    return attachments.length > 0 ? attachments : undefined;
  }

  private createToolCallMessage(call: RuntimeToolCall, parentToolCallId?: string): UIMessage {
    return {
      id: call.id,
      role: 'tool',
      content: [
        {
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
        },
      ],
      timestamp: new Date(),
      toolCallId: call.id,
      toolName: call.name,
      parentToolCallId,
      nestedTools: [],
      renderDoingUI: getToolMetadata(call.name).renderDoingUI,
      taskId: this.sessionId ?? undefined,
    };
  }

  private createToolResultMessage(
    result: RuntimeStoredToolResult,
    parentToolCallId?: string
  ): UIMessage {
    return {
      id: `${result.toolCallId}-result`,
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          input: result.input,
          output: result.output,
        },
      ],
      timestamp: new Date(),
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      parentToolCallId,
      taskId: this.sessionId ?? undefined,
      attachments: this.extractAttachments(result.output),
    };
  }

  private emitToolMessage(
    message: UIMessage,
    callbacks: AgentLoopCallbacks,
    dedupeKey = message.id
  ): void {
    if (this.emittedToolMessages.has(dedupeKey)) {
      return;
    }
    this.emittedToolMessages.add(dedupeKey);
    callbacks.onToolMessage?.(message);
  }

  private complete(callbacks: AgentLoopCallbacks, resolve: () => void): void {
    if (this.settled) return;
    this.settled = true;
    callbacks.onComplete?.(this.fullText);
    this.cleanup();
    resolve();
  }

  private fail(error: Error, callbacks: AgentLoopCallbacks, reject: (error: Error) => void): void {
    if (this.settled) return;
    this.settled = true;
    callbacks.onError?.(error);
    this.cleanup();
    reject(error);
  }

  private handleEvent(
    payload: RuntimeEventPayload,
    callbacks: AgentLoopCallbacks,
    resolve: () => void,
    reject: (error: Error) => void
  ): void {
    if (!this.belongsToCurrentExecution(payload)) return;

    switch (payload.type) {
      case 'taskStateChanged':
        if (payload.state === 'running') {
          callbacks.onStatus?.('Running');
        } else if (payload.state === 'waitingForUser') {
          callbacks.onStatus?.('Waiting for user input');
        } else if (payload.state === 'cancelled') {
          this.fail(new Error('Task cancelled'), callbacks, reject);
        } else if (payload.state === 'failed') {
          this.fail(new Error('Task failed'), callbacks, reject);
        }
        break;

      case 'messageCreated':
        if (payload.message) {
          const msg = payload.message as RuntimeStorageMessage;
          if (msg.role === 'assistant' && msg.content.type === 'text') {
            callbacks.onAssistantMessageStart?.();
          } else if (
            msg.role === 'assistant' &&
            (msg.content.type === 'toolCalls' || msg.content.type === 'tool_calls')
          ) {
            for (const call of msg.content.calls) {
              this.emitToolMessage(
                this.createToolCallMessage(call, msg.parentId),
                callbacks,
                call.id
              );
            }
          } else if (
            msg.role === 'tool' &&
            (msg.content.type === 'toolResult' || msg.content.type === 'tool_result')
          ) {
            this.emitToolMessage(
              this.createToolResultMessage(msg.content.result, msg.parentId),
              callbacks,
              `${msg.content.result.toolCallId}-result`
            );
          }
        }
        break;

      case 'token':
        if (payload.token) {
          this.fullText += payload.token;
          callbacks.onChunk(payload.token);
        }
        break;

      case 'reasoningStart':
        this.reasoningText = '';
        break;

      case 'reasoningDelta':
        if (payload.text) {
          this.reasoningText += payload.text;
          callbacks.onReasoningUpdate?.({
            reasoningContent: this.reasoningText,
            isStreaming: true,
          });
        }
        break;

      case 'reasoningEnd':
        callbacks.onReasoningUpdate?.({ reasoningContent: this.reasoningText, isStreaming: false });
        break;

      case 'usage':
        callbacks.onUsage?.({
          inputTokens: payload.inputTokens ?? 0,
          outputTokens: payload.outputTokens ?? 0,
          totalTokens: payload.totalTokens,
          contextUsage: payload.contextUsage,
          contextPercentLeft: payload.contextPercentLeft,
          isAboveWarningThreshold: payload.isAboveWarningThreshold,
          isAboveErrorThreshold: payload.isAboveErrorThreshold,
          isAboveAutoCompactThreshold: payload.isAboveAutoCompactThreshold,
          isAtBlockingLimit: payload.isAtBlockingLimit,
        });
        break;

      case 'done':
        // Stream done - not necessarily task done
        break;

      case 'toolCallRequested':
        if (payload.request) {
          this.emitToolMessage(
            this.createToolCallMessage({
              id: payload.request.toolCallId,
              name: payload.request.name,
              input: payload.request.input as Record<string, unknown>,
            }),
            callbacks,
            payload.request.toolCallId
          );
        }
        break;

      case 'toolCallCompleted':
        if (payload.result) {
          this.emitToolMessage(
            this.createToolResultMessage({
              toolCallId: payload.result.toolCallId,
              toolName: payload.result.name ?? '',
              output: payload.result.output,
              status: payload.result.success ? 'success' : 'error',
              errorMessage: payload.result.error,
            }),
            callbacks,
            `${payload.result.toolCallId}-result`
          );
        }
        break;

      case 'error':
        this.fail(
          new Error(
            typeof payload.message === 'string'
              ? payload.message
              : (payload.errorMessage ?? 'Unknown runtime error')
          ),
          callbacks,
          reject
        );
        break;

      case 'taskCompleted':
        this.complete(callbacks, resolve);
        break;
    }
  }

  private cleanup(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = undefined;
    }
    if (this.abortHandler && this.abortSignal) {
      this.abortSignal.removeEventListener('abort', this.abortHandler);
    }
    if (this.abortHandler) {
      this.abortHandler = undefined;
    }
    this.abortSignal = undefined;
    this.taskId = null;
    this.sessionId = null;
  }

  dispose(): void {
    this.cleanup();
  }
}
