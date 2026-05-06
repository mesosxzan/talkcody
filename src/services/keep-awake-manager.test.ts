// keep-awake-manager.test.ts - Unit tests for keep-awake manager

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keepAwakeManager } from './keep-awake-manager';
import { keepAwakeService } from './keep-awake-service';

vi.mock('./keep-awake-service', () => ({
  keepAwakeService: {
    acquireWithResult: vi.fn(),
    releaseWithResult: vi.fn(),
  },
}));

const { executionState, listeners, mockExecutionStore } = vi.hoisted(() => {
  const executionState = {
    runningCount: 0,
  };

  const listeners = new Set<(state: { getRunningCount: () => number }) => void>();

  const mockExecutionStore = {
    getState: () => ({
      getRunningCount: () => executionState.runningCount,
    }),
    subscribe: (listener: (state: { getRunningCount: () => number }) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return { executionState, listeners, mockExecutionStore };
});

vi.mock('@/stores/execution-store', () => ({
  useExecutionStore: mockExecutionStore,
}));

describe('keepAwakeManager', () => {
  beforeEach(() => {
    executionState.runningCount = 0;
    listeners.clear();
    vi.mocked(keepAwakeService.acquireWithResult).mockResolvedValue({
      success: true,
      wasFirst: true,
    });
    vi.mocked(keepAwakeService.releaseWithResult).mockResolvedValue({
      success: true,
      wasLast: true,
    });
    keepAwakeManager.stop();
    vi.clearAllMocks();
  });

  const emit = () => {
    const state = mockExecutionStore.getState();
    listeners.forEach((listener) => listener(state));
  };

  it('should acquire once on start when tasks are already running', async () => {
    executionState.runningCount = 2;

    keepAwakeManager.start();
    await keepAwakeManager.waitForIdle();

    expect(keepAwakeService.acquireWithResult).toHaveBeenCalledTimes(1);
    expect(keepAwakeService.releaseWithResult).not.toHaveBeenCalled();
    expect(keepAwakeManager.getSnapshot()).toMatchObject({
      runningCount: 2,
      refCount: 1,
      isPreventing: true,
    });
  });

  it('should only toggle keep-awake on zero-to-nonzero transitions', async () => {
    keepAwakeManager.start();
    await keepAwakeManager.waitForIdle();

    executionState.runningCount = 1;
    emit();
    await keepAwakeManager.waitForIdle();

    expect(keepAwakeService.acquireWithResult).toHaveBeenCalledTimes(1);
    expect(keepAwakeService.releaseWithResult).not.toHaveBeenCalled();

    executionState.runningCount = 3;
    emit();
    await keepAwakeManager.waitForIdle();

    executionState.runningCount = 1;
    emit();
    await keepAwakeManager.waitForIdle();

    expect(keepAwakeService.acquireWithResult).toHaveBeenCalledTimes(1);
    expect(keepAwakeService.releaseWithResult).not.toHaveBeenCalled();

    executionState.runningCount = 0;
    emit();
    await keepAwakeManager.waitForIdle();

    expect(keepAwakeService.releaseWithResult).toHaveBeenCalledTimes(1);
    expect(keepAwakeManager.getSnapshot()).toMatchObject({
      runningCount: 0,
      refCount: 0,
      isPreventing: false,
    });
  });

  it('should not release shared keep-awake state when this window starts idle', async () => {
    keepAwakeManager.start();
    await keepAwakeManager.waitForIdle();

    expect(keepAwakeService.acquireWithResult).not.toHaveBeenCalled();
    expect(keepAwakeService.releaseWithResult).not.toHaveBeenCalled();
  });

  it('should be idempotent on start', async () => {
    executionState.runningCount = 1;
    keepAwakeManager.start();
    keepAwakeManager.start();
    await keepAwakeManager.waitForIdle();

    expect(listeners.size).toBe(1);
    expect(keepAwakeService.acquireWithResult).toHaveBeenCalledTimes(1);
  });

  it('should stop and reset state', () => {
    executionState.runningCount = 1;
    keepAwakeManager.start();

    keepAwakeManager.stop();

    expect(listeners.size).toBe(0);
    expect(keepAwakeManager.getSnapshot()).toMatchObject({
      runningCount: 0,
      refCount: 0,
      isPreventing: false,
    });
  });

  it('should release after an in-flight startup acquire when tasks stop', async () => {
    executionState.runningCount = 1;

    let resolveAcquire: (() => void) | null = null;
    const acquirePromise = new Promise<void>((resolve) => {
      resolveAcquire = resolve;
    });

    let notifyAcquireStarted: (() => void) | null = null;
    const acquireStarted = new Promise<void>((resolve) => {
      notifyAcquireStarted = resolve;
    });

    vi.mocked(keepAwakeService.acquireWithResult).mockImplementation(async () => {
      notifyAcquireStarted?.();
      await acquirePromise;
      return { success: true, wasFirst: true };
    });

    keepAwakeManager.start();

    await acquireStarted;
    executionState.runningCount = 0;
    emit();

    resolveAcquire?.();
    await keepAwakeManager.waitForIdle();

    expect(keepAwakeService.acquireWithResult).toHaveBeenCalledTimes(1);
    expect(keepAwakeService.releaseWithResult).toHaveBeenCalledTimes(1);
    expect(keepAwakeManager.getSnapshot()).toMatchObject({
      runningCount: 0,
      refCount: 0,
      isPreventing: false,
    });
  });

  it('should keep state cleared when acquire fails', async () => {
    executionState.runningCount = 1;
    vi.mocked(keepAwakeService.acquireWithResult).mockResolvedValue({
      success: false,
      wasFirst: false,
    });

    keepAwakeManager.start();
    await keepAwakeManager.waitForIdle();

    expect(keepAwakeManager.getSnapshot()).toMatchObject({
      runningCount: 1,
      refCount: 0,
      isPreventing: false,
    });
    expect(keepAwakeService.releaseWithResult).not.toHaveBeenCalled();
  });
});
