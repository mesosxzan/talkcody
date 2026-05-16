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

vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: {
    getState: vi.fn(() => settingsState),
  },
}));

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

describe('scheduled-task-store', () => {
  beforeEach(async () => {
    settingsState = {
      language: 'en',
      model: '',
      isInitialized: true,
      initialize: vi.fn(async () => {}),
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
});
