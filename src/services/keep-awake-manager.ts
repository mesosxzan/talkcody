// keep-awake-manager.ts - Orchestrates keep-awake state from execution store
//
// This manager reacts to task activity in the current window only.
// Each window owns at most one keep-awake reference while it has running tasks,
// which avoids releasing references held by other windows or subsystems.

import { logger } from '@/lib/logger';
import { keepAwakeService } from '@/services/keep-awake-service';
import { useExecutionStore } from '@/stores/execution-store';

export type KeepAwakeSnapshot = {
  isPreventing: boolean;
  refCount: number;
  runningCount: number;
};

class KeepAwakeManager {
  private isStarted = false;
  private runningCount = 0;
  private refCount = 0;
  private isPreventing = false;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private operationQueue: Promise<void> = Promise.resolve();

  public start = (): void => {
    if (this.isStarted) {
      return;
    }

    this.isStarted = true;
    this.runningCount = useExecutionStore.getState().getRunningCount();
    this.emit();

    this.unsubscribe = useExecutionStore.subscribe((state) => {
      const nextRunningCount = state.getRunningCount();
      if (nextRunningCount === this.runningCount) {
        return;
      }

      const previousRunningCount = this.runningCount;
      this.runningCount = nextRunningCount;
      this.emit();

      if (previousRunningCount === 0 && nextRunningCount > 0) {
        this.enqueue(() => this.acquireForRunningTasks());
        return;
      }

      if (previousRunningCount > 0 && nextRunningCount === 0) {
        this.enqueue(() => this.releaseForRunningTasks());
      }
    });

    if (this.runningCount > 0) {
      this.enqueue(() => this.acquireForRunningTasks());
    }
  };

  public stop = (): void => {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.isStarted = false;
    this.runningCount = 0;
    this.refCount = 0;
    this.isPreventing = false;
    this.operationQueue = Promise.resolve();
    this.emit();
  };

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public getSnapshot = (): KeepAwakeSnapshot => ({
    isPreventing: this.isPreventing,
    refCount: this.refCount,
    runningCount: this.runningCount,
  });

  public waitForIdle = (): Promise<void> => this.operationQueue;

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private setHeldReference(held: boolean): void {
    const nextRefCount = held ? 1 : 0;
    const nextPreventing = held;
    const changed = nextRefCount !== this.refCount || nextPreventing !== this.isPreventing;

    this.refCount = nextRefCount;
    this.isPreventing = nextPreventing;

    if (changed) {
      this.emit();
    }
  }

  private enqueue(operation: () => Promise<void>): void {
    this.operationQueue = this.operationQueue.then(operation).catch((error) => {
      logger.error('[KeepAwakeManager] Operation failed:', error);
    });
  }

  private async acquireForRunningTasks(): Promise<void> {
    if (this.refCount > 0 || this.runningCount === 0) {
      return;
    }

    const result = await keepAwakeService.acquireWithResult();
    if (!result.success) {
      return;
    }

    this.setHeldReference(true);
  }

  private async releaseForRunningTasks(): Promise<void> {
    if (this.refCount === 0) {
      return;
    }

    const result = await keepAwakeService.releaseWithResult();
    if (!result.success) {
      return;
    }

    this.setHeldReference(false);
  }
}

export const keepAwakeManager = new KeepAwakeManager();

export function startKeepAwakeManager(): void {
  keepAwakeManager.start();
}
