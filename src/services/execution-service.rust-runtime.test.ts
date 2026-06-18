import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  adapterStartMock,
  adapterCancelMock,
  adapterDisposeMock,
  createAssistantMessageMock,
  finalizeMessageMock,
  updateStreamingContentMock,
  updateStreamingReasoningMock,
  addToolMessageMock,
  getEffectiveWorkspaceRootMock,
  notifyHookedMock,
  handleExecutionTerminalStateMock,
  getTaskDetailsMock,
  getTaskSettingsMock,
  updateTaskUsageMock,
  clearRunningTaskUsageMock,
  acquireForTaskMock,
  releaseForTaskMock,
  completeExecutionMock,
  setServerStatusMock,
  setErrorMock,
  settingsGetMock,
} = vi.hoisted(() => ({
  adapterStartMock: vi.fn(),
  adapterCancelMock: vi.fn(),
  adapterDisposeMock: vi.fn(),
  createAssistantMessageMock: vi.fn(),
  finalizeMessageMock: vi.fn(),
  updateStreamingContentMock: vi.fn(),
  updateStreamingReasoningMock: vi.fn(),
  addToolMessageMock: vi.fn(),
  getEffectiveWorkspaceRootMock: vi.fn(),
  notifyHookedMock: vi.fn(),
  handleExecutionTerminalStateMock: vi.fn(),
  getTaskDetailsMock: vi.fn(),
  getTaskSettingsMock: vi.fn(),
  updateTaskUsageMock: vi.fn(),
  clearRunningTaskUsageMock: vi.fn(),
  acquireForTaskMock: vi.fn(),
  releaseForTaskMock: vi.fn(),
  completeExecutionMock: vi.fn(),
  setServerStatusMock: vi.fn(),
  setErrorMock: vi.fn(),
  settingsGetMock: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/services/agents/auto-code-review-hook-service', () => ({
  autoCodeReviewHookService: {},
}));
vi.mock('@/services/agents/auto-git-commit-hook-service', () => ({
  autoGitCommitHookService: {},
}));
vi.mock('@/services/agents/check-finish-hook-service', () => ({
  checkFinishHookService: {},
}));
vi.mock('@/services/agents/ralph-loop-service', () => ({
  ralphLoopService: {},
}));
vi.mock('@/services/agents/stop-hook-service', () => ({
  stopHookService: {},
}));
vi.mock('@/services/agents/llm-completion-hooks', () => ({
  completionHookPipeline: {
    register: vi.fn(),
    getRegisteredHooks: vi.fn(() => []),
  },
}));

vi.mock('@/services/agents/llm-service', () => ({
  createLLMService: vi.fn(() => ({
    runAgentLoop: vi.fn(),
  })),
}));

vi.mock('@/services/message-service', () => ({
  messageService: {
    createAssistantMessage: createAssistantMessageMock,
    finalizeMessage: finalizeMessageMock,
    updateStreamingContent: updateStreamingContentMock,
    updateStreamingReasoning: updateStreamingReasoningMock,
    addToolMessage: addToolMessageMock,
    addAttachment: vi.fn(),
  },
}));

vi.mock('@/services/notification-service', () => ({
  notificationService: {
    notifyHooked: notifyHookedMock,
  },
}));

vi.mock('@/services/task-queue-service', () => ({
  taskQueueService: {
    handleExecutionTerminalState: handleExecutionTerminalStateMock,
  },
}));

vi.mock('@/services/task-service', () => ({
  taskService: {
    getTaskDetails: getTaskDetailsMock,
    getTaskSettings: getTaskSettingsMock,
    updateTaskUsage: updateTaskUsageMock,
  },
}));

vi.mock('@/services/workspace-root-service', () => ({
  getEffectiveWorkspaceRoot: getEffectiveWorkspaceRootMock,
}));

vi.mock('@/stores/settings-store', () => ({
  settingsManager: {
    get: settingsGetMock,
  },
}));

let executionStatus: 'running' | 'completed' | 'error' | 'stopped' = 'running';
let abortController = new AbortController();

vi.mock('@/stores/execution-store', () => ({
  useExecutionStore: {
    getState: () => ({
      startExecution: () => {
        executionStatus = 'running';
        return {
          success: true,
          abortController,
          error: undefined,
        };
      },
      stopExecution: () => {
        executionStatus = 'stopped';
        abortController.abort();
      },
      setError: setErrorMock.mockImplementation(() => {
        executionStatus = 'error';
      }),
      setServerStatus: setServerStatusMock,
      completeExecution: completeExecutionMock.mockImplementation(() => {
        executionStatus = 'completed';
      }),
      isRunning: () => executionStatus === 'running',
      getRunningTaskIds: () => [],
      clearStreamingContent: vi.fn(),
    }),
  },
}));

vi.mock('@/stores/task-store', () => ({
  useTaskStore: {
    getState: () => ({
      runningTaskUsage: new Map(),
      clearRunningTaskUsage: clearRunningTaskUsageMock,
      flushRunningTaskUsage: vi.fn(),
      stopStreaming: vi.fn(),
      getMessages: vi.fn(() => []),
    }),
  },
}));

vi.mock('@/stores/worktree-store', () => ({
  useWorktreeStore: {
    getState: () => ({
      acquireForTask: acquireForTaskMock,
      isTaskUsingWorktree: vi.fn(() => false),
      releaseForTask: releaseForTaskMock,
    }),
  },
}));

vi.mock('@/services/rust-runtime-adapter', () => ({
  RustRuntimeAdapter: class {
    start = adapterStartMock;
    cancel = adapterCancelMock;
    dispose = adapterDisposeMock;
  },
}));

import { executionService } from './execution-service';

describe('ExecutionService Rust runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executionStatus = 'running';
    abortController = new AbortController();
    getEffectiveWorkspaceRootMock.mockResolvedValue('/repo');
    acquireForTaskMock.mockResolvedValue(null);
    releaseForTaskMock.mockResolvedValue(undefined);
    notifyHookedMock.mockResolvedValue(undefined);
    handleExecutionTerminalStateMock.mockResolvedValue(undefined);
    getTaskDetailsMock.mockResolvedValue(null);
    getTaskSettingsMock.mockResolvedValue(null);
    updateTaskUsageMock.mockResolvedValue(undefined);
    addToolMessageMock.mockResolvedValue(undefined);
    clearRunningTaskUsageMock.mockImplementation(() => {});
    createAssistantMessageMock.mockReturnValue('msg-1');
    finalizeMessageMock.mockResolvedValue(undefined);
    settingsGetMock.mockImplementation((key: string) => {
      if (key === 'use_rust_runtime') return 'true';
      if (key === 'model') return 'model@test';
      return null;
    });
  });

  it('waits for Rust runtime completion and forwards the user prompt into TaskInput', async () => {
    let completeRuntime!: () => void;
    let capturedInput:
      | {
          sessionId: string;
          initialMessage: string;
        }
      | undefined;

    adapterStartMock.mockImplementation(async (input, callbacks) => {
      capturedInput = input;
      callbacks.onStatus?.('Running');
      callbacks.onAssistantMessageStart?.();
      callbacks.onReasoningUpdate?.({
        reasoningContent: 'thinking',
        isStreaming: true,
      });
      callbacks.onReasoningUpdate?.({
        reasoningContent: 'thinking',
        isStreaming: false,
      });
      callbacks.onChunk('hello');
      await new Promise<void>((resolve) => {
        completeRuntime = () => {
          callbacks.onComplete?.('hello');
          resolve();
        };
      });
    });

    const executionPromise = executionService.startExecution({
      taskId: 'task-1',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'history prompt',
          timestamp: new Date(),
        },
      ],
      model: 'ignored@test',
      userMessage: 'latest prompt',
    });

    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capturedInput).toMatchObject({
      sessionId: 'task-1',
      initialMessage: 'latest prompt',
    });
    expect(setServerStatusMock).toHaveBeenCalledWith('task-1', 'Running');
    expect(completeExecutionMock).not.toHaveBeenCalled();

    completeRuntime();
    await executionPromise;

    expect(createAssistantMessageMock).toHaveBeenCalledWith('task-1', undefined);
    expect(updateStreamingContentMock).toHaveBeenCalledWith('task-1', 'msg-1', 'hello');
    expect(updateStreamingReasoningMock).toHaveBeenNthCalledWith(
      1,
      'task-1',
      'msg-1',
      'thinking',
      true,
    );
    expect(updateStreamingReasoningMock).toHaveBeenNthCalledWith(
      2,
      'task-1',
      'msg-1',
      'thinking',
      false,
    );
    expect(finalizeMessageMock).toHaveBeenCalledWith('task-1', 'msg-1', 'hello', 'thinking');
    expect(completeExecutionMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the Rust runtime adapter when execution is stopped', async () => {
    let releaseRuntime!: () => void;

    adapterStartMock.mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          releaseRuntime = resolve;
        }),
    );

    const executionPromise = executionService.startExecution({
      taskId: 'task-1',
      messages: [],
      model: 'ignored@test',
      userMessage: 'stop me',
    });

    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await executionService.stopExecution('task-1');

    expect(adapterCancelMock).toHaveBeenCalledTimes(1);
    expect(adapterDisposeMock).toHaveBeenCalledTimes(1);

    releaseRuntime();
    await executionPromise;

    expect(completeExecutionMock).not.toHaveBeenCalled();
  });

  it('adds assistantId to Rust tool messages before persisting them', async () => {
    let completeRuntime!: () => void;

    adapterStartMock.mockImplementation(async (_input, callbacks) => {
      callbacks.onToolMessage?.({
        id: 'tool-1',
        role: 'tool',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'bash',
            input: { command: 'pwd' },
          },
        ],
        timestamp: new Date(),
        toolCallId: 'tool-1',
        toolName: 'bash',
      });

      await new Promise<void>((resolve) => {
        completeRuntime = () => {
          callbacks.onComplete?.('');
          resolve();
        };
      });
    });

    const executionPromise = executionService.startExecution({
      taskId: 'task-1',
      messages: [],
      model: 'ignored@test',
      userMessage: 'run bash',
      agentId: 'planner',
    });

    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(addToolMessageMock).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        assistantId: 'planner',
        toolCallId: 'tool-1',
      }),
    );

    completeRuntime();
    await executionPromise;
  });
});
