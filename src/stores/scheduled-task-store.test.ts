import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let settingsState: {
  language: string;
  model: string;
  isInitialized: boolean;
  initialize: () => Promise<void>;
};

let providerState: {
  isInitialized: boolean;
  isLoading: boolean;
  availableModels: Array<{ key: string; name: string; provider: string; inputPricing?: string }>;
  initialize: () => Promise<void>;
  isModelAvailable: (model: string) => boolean;
  getAvailableModel: () => { key: string; name: string; provider: string; inputPricing?: string } | null;
};

const startExecutionMock = vi.fn(async () => {});
const createTaskMock = vi.fn(async () => 'test-task-id');
const notifyScheduledTaskResultMock = vi.fn(async () => {});
const deliverMock = vi.fn(async () => ({ status: 'none', deliveredAt: null as number | null }));
const addUserMessageMock = vi.fn(async () => 'test-message-id');
const getWithResolvedToolsMock = vi.fn(async () => undefined);



vi.mock('@/providers/stores/provider-store', () => ({
  useProviderStore: {
    getState: vi.fn(() => providerState),
  },
}));

vi.mock('@/services/task-service', () => ({
  taskService: {
    createTask: createTaskMock,
  },
}));

vi.mock('@/services/execution-service', () => ({
  executionService: {
    startExecution: startExecutionMock,
  },
}));

vi.mock('@/services/notification-service', () => ({
  notificationService: {
    notifyScheduledTaskResult: notifyScheduledTaskResultMock,
  },
}));

vi.mock('@/services/scheduled-tasks/scheduled-task-delivery-service', () => ({
  scheduledTaskDeliveryService: {
    deliver: deliverMock,
  },
}));

vi.mock('@/services/message-service', () => ({
  messageService: {
    addUserMessage: addUserMessageMock,
  },
}));

vi.mock('@/services/agents/agent-registry', () => ({
  agentRegistry: {
    getWithResolvedTools: getWithResolvedToolsMock,
  },
}));

vi.mock('@/services/workspace-root-service', () => ({
  getEffectiveWorkspaceRoot: vi.fn(async () => '/test/workspace'),
}));

vi.mock('@/services/prompt/preview', () => ({
  previewSystemPrompt: vi.fn(async () => ({ finalSystemPrompt: 'test prompt' })),
}));

vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: {
    getState: vi.fn(() => settingsState),
  },
  settingsManager: {
    getProject: vi.fn(async () => 'default'),
    getAutoApproveEditsGlobal: vi.fn(async () => false),
    getAutoApprovePlanGlobal: vi.fn(async () => false),
    getAutoCodeReviewGlobal: vi.fn(async () => false),
    getAutoGitCommitGlobal: vi.fn(async () => false),
  },
}));

describe('scheduled-task-store', () => {
  beforeEach(async () => {
    settingsState = {
      language: 'en',
      model: '',
      isInitialized: true,
      initialize: vi.fn(async () => {}),
      getAgentId: vi.fn(() => 'planner'),
    };

    providerState = {
      isInitialized: true,
      isLoading: false,
      availableModels: [],
      initialize: vi.fn(async () => {}),
      isModelAvailable: vi.fn(() => false),
      getAvailableModel: vi.fn(() => null),
    };

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'report_scheduled_task_run_complete') return undefined as never;
      if (cmd === 'list_scheduled_tasks') return [] as never;
      if (cmd === 'get_scheduled_task_stats') {
        return {
          totalRuns: 0,
          completedRuns: 0,
          failedRuns: 0,
          queuedRuns: 0,
          retriedRuns: 0,
          successRate: 0,
          avgDurationMs: 0,
          deliveryFailures: 0,
        } as never;
      }
      return undefined as never;
    });

    startExecutionMock.mockClear();
    createTaskMock.mockClear();
    notifyScheduledTaskResultMock.mockClear();
    deliverMock.mockClear();
    addUserMessageMock.mockClear();
    getWithResolvedToolsMock.mockClear();
    // Default: agent not found, so agentId will be undefined
    getWithResolvedToolsMock.mockResolvedValue(undefined);
  });

  it('uses a fallback model when neither payload.model nor settings.model is set', async () => {
    providerState.availableModels.push({
      key: 'gpt-5-mini',
      name: 'GPT-5 mini',
      provider: 'openai',
      inputPricing: '1',
    });
    providerState.getAvailableModel = vi.fn(() => providerState.availableModels[0] ?? null);
    providerState.isModelAvailable = vi.fn((model) => model === 'gpt-5-mini');

    const { useScheduledTaskStore } = await import('./scheduled-task-store');
    useScheduledTaskStore.setState({
      tasks: [
        {
          id: 'job-1',
          name: 'Job',
          description: '',
          projectId: null,
          schedule: { kind: 'every', everyMs: 60_000 },
          payload: { message: 'hello' },
          executionPolicy: { maxConcurrentRuns: 1, catchUp: false, staggerMs: -1 },
          retryPolicy: { maxAttempts: 1, backoffMs: [1000] },
          notificationPolicy: { notifyOnSuccess: false, notifyOnFailure: true },
          deliveryPolicy: { enabled: false },
          offlinePolicy: { enabled: false, minuteGranularity: 1 },
          status: 'enabled',
          nextRunAt: null,
          lastRunAt: null,
          pausedAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    await useScheduledTaskStore.getState()._onTrigger({
      jobId: 'job-1',
      runId: 'run-1',
      payload: { message: 'hello' },
      projectId: null,
    });

    expect(startExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: 'user',
            content: 'hello',
          }),
        ],
        model: 'gpt-5-mini',
        userMessage: 'hello',
      })
    );
  });

  it('fails fast without creating a task when no models are available', async () => {
    const { useScheduledTaskStore } = await import('./scheduled-task-store');

    useScheduledTaskStore.setState({
      tasks: [
        {
          id: 'job-1',
          name: 'Job',
          description: '',
          projectId: null,
          schedule: { kind: 'every', everyMs: 60_000 },
          payload: { message: 'hello' },
          executionPolicy: { maxConcurrentRuns: 1, catchUp: false, staggerMs: -1 },
          retryPolicy: { maxAttempts: 1, backoffMs: [1000] },
          notificationPolicy: { notifyOnSuccess: false, notifyOnFailure: true },
          deliveryPolicy: { enabled: false },
          offlinePolicy: { enabled: false, minuteGranularity: 1 },
          status: 'enabled',
          nextRunAt: null,
          lastRunAt: null,
          pausedAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    await useScheduledTaskStore.getState()._onTrigger({
      jobId: 'job-1',
      runId: 'run-1',
      payload: { message: 'hello' },
      projectId: null,
    });

    expect(createTaskMock).not.toHaveBeenCalled();
    expect(startExecutionMock).not.toHaveBeenCalled();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      'report_scheduled_task_run_complete',
      expect.objectContaining({
        payload: expect.objectContaining({
          success: false,
          taskId: null,
        }),
      })
    );
  });

  it('passes agentId to execution service when specified in payload', async () => {
    providerState.availableModels.push({
      key: 'gpt-5-mini',
      name: 'GPT-5 mini',
      provider: 'openai',
      inputPricing: '1',
    });
    providerState.getAvailableModel = vi.fn(() => providerState.availableModels[0] ?? null);
    providerState.isModelAvailable = vi.fn((model) => model === 'gpt-5-mini');

    // Mock agent exists with tools and system prompt
    getWithResolvedToolsMock.mockResolvedValue({
      id: 'custom-agent-123',
      name: 'Custom Agent',
      description: 'A custom agent',
      systemPrompt: 'You are a custom agent.',
      tools: { bash: {} },
      model: 'gpt-5-mini',
      fallbackModels: [],
    });

    const { useScheduledTaskStore } = await import('./scheduled-task-store');
    useScheduledTaskStore.setState({
      tasks: [
        {
          id: 'job-1',
          name: 'Job',
          description: '',
          projectId: null,
          schedule: { kind: 'every', everyMs: 60_000 },
          payload: { message: 'hello', agentId: 'custom-agent-123' },
          executionPolicy: { maxConcurrentRuns: 1, catchUp: false, staggerMs: -1 },
          retryPolicy: { maxAttempts: 1, backoffMs: [1000] },
          notificationPolicy: { notifyOnSuccess: false, notifyOnFailure: true },
          deliveryPolicy: { enabled: false },
          offlinePolicy: { enabled: false, minuteGranularity: 1 },
          status: 'enabled',
          nextRunAt: null,
          lastRunAt: null,
          pausedAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    await useScheduledTaskStore.getState()._onTrigger({
      jobId: 'job-1',
      runId: 'run-1',
      payload: { message: 'hello', agentId: 'custom-agent-123' },
      projectId: null,
    });

    // Verify agent was resolved
    expect(getWithResolvedToolsMock).toHaveBeenCalledWith('custom-agent-123');

    // Verify execution was called with agent configuration
    expect(startExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: 'user',
            content: 'hello',
            assistantId: 'custom-agent-123',
          }),
        ],
        model: 'gpt-5-mini',
        agentId: 'custom-agent-123',
        systemPrompt: 'You are a custom agent.',
        tools: { bash: {} },
        userMessage: 'hello',
      })
    );
  });

  it('uses projectId from event when specified', async () => {
    providerState.availableModels.push({
      key: 'gpt-5-mini',
      name: 'GPT-5 mini',
      provider: 'openai',
      inputPricing: '1',
    });
    providerState.getAvailableModel = vi.fn(() => providerState.availableModels[0] ?? null);
    providerState.isModelAvailable = vi.fn((model) => model === 'gpt-5-mini');

    const { useScheduledTaskStore } = await import('./scheduled-task-store');
    useScheduledTaskStore.setState({
      tasks: [
        {
          id: 'job-1',
          name: 'Job',
          description: '',
          projectId: 'project-456',
          schedule: { kind: 'every', everyMs: 60_000 },
          payload: { message: 'hello' },
          executionPolicy: { maxConcurrentRuns: 1, catchUp: false, staggerMs: -1 },
          retryPolicy: { maxAttempts: 1, backoffMs: [1000] },
          notificationPolicy: { notifyOnSuccess: false, notifyOnFailure: true },
          deliveryPolicy: { enabled: false },
          offlinePolicy: { enabled: false, minuteGranularity: 1 },
          status: 'enabled',
          nextRunAt: null,
          lastRunAt: null,
          pausedAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    await useScheduledTaskStore.getState()._onTrigger({
      jobId: 'job-1',
      runId: 'run-1',
      payload: { message: 'hello' },
      projectId: 'project-456',
    });

    expect(createTaskMock).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({
        projectId: 'project-456',
      })
    );
  });
});
