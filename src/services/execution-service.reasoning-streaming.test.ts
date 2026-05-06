import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createAssistantMessageMock,
  finalizeMessageMock,
  updateStreamingContentMock,
  updateStreamingReasoningMock,
  runAgentLoopMock,
  getEffectiveWorkspaceRootMock,
  notifyHookedMock,
  handleExecutionTerminalStateMock,
  getTaskDetailsMock,
  updateTaskUsageMock,
  clearRunningTaskUsageMock,
  acquireForTaskMock,
  releaseForTaskMock,
  startExecutionMock,
  completeExecutionMock,
  setServerStatusMock,
  setErrorMock,
  clearStreamingContentMock,
} = vi.hoisted(() => ({
  createAssistantMessageMock: vi.fn(),
  finalizeMessageMock: vi.fn(),
  updateStreamingContentMock: vi.fn(),
  updateStreamingReasoningMock: vi.fn(),
  runAgentLoopMock: vi.fn(),
  getEffectiveWorkspaceRootMock: vi.fn(),
  notifyHookedMock: vi.fn(),
  handleExecutionTerminalStateMock: vi.fn(),
  getTaskDetailsMock: vi.fn(),
  updateTaskUsageMock: vi.fn(),
  clearRunningTaskUsageMock: vi.fn(),
  acquireForTaskMock: vi.fn(),
  releaseForTaskMock: vi.fn(),
  startExecutionMock: vi.fn(),
  completeExecutionMock: vi.fn(),
  setServerStatusMock: vi.fn(),
  setErrorMock: vi.fn(),
  clearStreamingContentMock: vi.fn(),
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
    runAgentLoop: runAgentLoopMock,
  })),
}));

vi.mock('@/services/message-service', () => ({
  messageService: {
    createAssistantMessage: createAssistantMessageMock,
    finalizeMessage: finalizeMessageMock,
    updateStreamingContent: updateStreamingContentMock,
    updateStreamingReasoning: updateStreamingReasoningMock,
    addToolMessage: vi.fn(),
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
    updateTaskUsage: updateTaskUsageMock,
  },
}));

vi.mock('@/services/workspace-root-service', () => ({
  getEffectiveWorkspaceRoot: getEffectiveWorkspaceRootMock,
}));

let isRunning = true;
const abortController = new AbortController();

vi.mock('@/stores/execution-store', () => ({
  useExecutionStore: {
    getState: () => ({
      startExecution: startExecutionMock,
      setError: setErrorMock,
      setServerStatus: setServerStatusMock,
      completeExecution: completeExecutionMock,
      isRunning: () => isRunning,
      getRunningTaskIds: () => ['task-1'],
      clearStreamingContent: clearStreamingContentMock,
    }),
  },
}));

vi.mock('@/stores/task-store', () => ({
  useTaskStore: {
    getState: () => ({
      runningTaskUsage: new Map(),
      updateTask: vi.fn(),
      updateTaskUsage: vi.fn(),
      flushRunningTaskUsage: vi.fn(),
      clearRunningTaskUsage: clearRunningTaskUsageMock,
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

import { executionService } from './execution-service';

describe('ExecutionService reasoning streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isRunning = true;
    getEffectiveWorkspaceRootMock.mockResolvedValue('/repo');
    acquireForTaskMock.mockResolvedValue(null);
    notifyHookedMock.mockResolvedValue(undefined);
    handleExecutionTerminalStateMock.mockResolvedValue(undefined);
    getTaskDetailsMock.mockResolvedValue(null);
    updateTaskUsageMock.mockResolvedValue(undefined);
    releaseForTaskMock.mockResolvedValue(undefined);
    startExecutionMock.mockReturnValue({
      success: true,
      abortController,
      error: undefined,
    });
    completeExecutionMock.mockImplementation(() => {
      isRunning = false;
    });
    finalizeMessageMock.mockResolvedValue(undefined);
    createAssistantMessageMock.mockReturnValueOnce('msg-1').mockReturnValueOnce('msg-2');

    runAgentLoopMock.mockImplementation(async (_options, callbacks) => {
      callbacks.onAssistantMessageStart?.();
      callbacks.onReasoningUpdate?.({
        reasoningContent: 'thinking',
        isStreaming: true,
      });
      callbacks.onReasoningUpdate?.({
        reasoningContent: 'thinking',
        isStreaming: false,
      });
      callbacks.onAssistantReasoning?.('thinking');

      callbacks.onAssistantMessageStart?.();
      callbacks.onChunk('final answer');
      callbacks.onComplete?.('final answer');
    });
  });

  it('finalizes a reasoning-only assistant turn before the next assistant turn starts', async () => {
    await executionService.startExecution({
      taskId: 'task-1',
      messages: [],
      model: 'test-model',
    });

    expect(createAssistantMessageMock).toHaveBeenCalledTimes(2);
    expect(updateStreamingReasoningMock).toHaveBeenNthCalledWith(
      1,
      'task-1',
      'msg-1',
      'thinking',
      true
    );
    expect(updateStreamingReasoningMock).toHaveBeenNthCalledWith(
      2,
      'task-1',
      'msg-1',
      'thinking',
      false
    );
    expect(finalizeMessageMock).toHaveBeenNthCalledWith(1, 'task-1', 'msg-1', '', 'thinking');
    expect(updateStreamingContentMock).toHaveBeenCalledWith('task-1', 'msg-2', 'final answer');
    expect(finalizeMessageMock).toHaveBeenNthCalledWith(
      2,
      'task-1',
      'msg-2',
      'final answer',
      undefined
    );
  });
});
