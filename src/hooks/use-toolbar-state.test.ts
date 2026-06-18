import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../types/task';
import { useToolbarState } from './use-toolbar-state';

const {
  mockTaskStoreState,
  mockUseTaskStore,
  mockSettingsStoreState,
  mockUseSettingsStore,
  mockProviderStoreState,
  mockUseProviderStore,
  setTask,
} = vi.hoisted(() => {
  const mockTaskStoreState = {
    currentTaskId: 'task-1',
    getTask: vi.fn(),
    runningTaskUsage: new Map<string, Record<string, unknown>>(),
  };
  const mockUseTaskStore = (selector: (state: typeof mockTaskStoreState) => unknown) =>
    selector(mockTaskStoreState);

  const mockSettingsStoreState = {
    model_type_main: 'main',
    model_type_small: 'small',
    model_type_image_generator: 'image',
    model_type_transcription: 'transcription',
    assistantId: 'assistant',
  };
  const mockUseSettingsStore = (
    selector: (state: typeof mockSettingsStoreState) => unknown
  ) => selector(mockSettingsStoreState);

  const mockProviderStoreState = {
    availableModels: [
      {
        key: 'gpt',
        name: 'GPT',
        provider: 'openai',
        providerName: 'OpenAI',
        imageInput: false,
        imageOutput: false,
        audioInput: false,
      },
    ],
  };
  const mockUseProviderStore = (
    selector: (state: typeof mockProviderStoreState) => unknown
  ) => selector(mockProviderStoreState);

  const setTask = (task: Task | undefined) => {
    mockTaskStoreState.getTask.mockReturnValue(task);
  };

  return {
    mockTaskStoreState,
    mockUseTaskStore,
    mockSettingsStoreState,
    mockUseSettingsStore,
    mockProviderStoreState,
    mockUseProviderStore,
    setTask,
  };
});

vi.mock('@/stores/task-store', () => ({
  useTaskStore: mockUseTaskStore,
}));

vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: mockUseSettingsStore,
}));

vi.mock('@/providers/stores/provider-store', () => ({
  useProviderStore: mockUseProviderStore,
  modelService: {
    getCurrentModel: vi.fn().mockResolvedValue('gpt@openai'),
  },
}));

const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Task 1',
  project_id: 'project-1',
  created_at: 1,
  updated_at: 1,
  message_count: 0,
  request_count: 0,
  cost: 0,
  input_token: 0,
  output_token: 0,
  model: 'gpt@openai',
  ...overrides,
});

describe('useToolbarState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskStoreState.currentTaskId = 'task-1';
    mockTaskStoreState.runningTaskUsage = new Map();
    mockSettingsStoreState.assistantId = 'assistant';
    mockProviderStoreState.availableModels = mockProviderStoreState.availableModels.slice(0, 1);
  });

  it('uses last_request_input_token when present', () => {
    setTask(
      createTask({
        input_token: 300,
        last_request_input_token: 42,
      })
    );

    const { result } = renderHook(() => useToolbarState());

    expect(result.current.inputTokens).toBe(42);
  });

  it('falls back to input_token when last_request_input_token is missing', () => {
    setTask(
      createTask({
        input_token: 300,
      })
    );

    const { result } = renderHook(() => useToolbarState());

    expect(result.current.inputTokens).toBe(300);
  });

  it('exposes runtime threshold indicators from running task usage', () => {
    setTask(
      createTask({
        context_usage: 25,
      })
    );
    mockTaskStoreState.runningTaskUsage.set('task-1', {
      costDelta: 0,
      inputTokensDelta: 0,
      outputTokensDelta: 0,
      requestCountDelta: 0,
      contextUsage: 25,
      contextPercentLeft: 63,
      isAboveWarningThreshold: true,
      isAboveErrorThreshold: false,
      isAboveAutoCompactThreshold: false,
      isAtBlockingLimit: false,
    });

    const { result } = renderHook(() => useToolbarState());

    expect(result.current.contextUsage).toBe(25);
    expect(result.current.contextPercentLeft).toBe(63);
    expect(result.current.isAboveWarningThreshold).toBe(true);
    expect(result.current.isAboveErrorThreshold).toBe(false);
    expect(result.current.isAtBlockingLimit).toBe(false);
  });
});
