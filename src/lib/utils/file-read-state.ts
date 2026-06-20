/**
 * File read state tracking for staleness detection.
 * Tracks when files were last read by the AI, so edits can detect
 * if the file was modified externally between read and edit.
 */

import { logger } from '@/lib/logger';
import { isTauriRuntime } from '@/lib/runtime-env';

interface FileReadState {
  /** Timestamp when the file was last read by the AI */
  readTimestamp: number;
  /** File modification time at the time of read */
  modifiedTime: number;
  /** Whether this was a full read (vs partial) */
  fullRead: boolean;
}

/**
 * Tracks file read timestamps per task to enable staleness detection.
 * When the AI reads a file and then tries to edit it, we check if the
 * file was modified externally between the read and edit operations.
 */
class FileReadStateTracker {
  private states = new Map<string, Map<string, FileReadState>>();

  private getTaskMap(taskId: string): Map<string, FileReadState> {
    let taskMap = this.states.get(taskId);
    if (!taskMap) {
      taskMap = new Map();
      this.states.set(taskId, taskMap);
    }
    return taskMap;
  }

  /**
   * Record that a file was read by the AI
   */
  recordRead(taskId: string, filePath: string, modifiedTime: number, fullRead = true): void {
    const taskMap = this.getTaskMap(taskId);
    taskMap.set(filePath, {
      readTimestamp: Date.now(),
      modifiedTime,
      fullRead,
    });
  }

  /**
   * Check if a file has been modified since the AI last read it.
   * Returns null if the file was never read (no staleness check possible).
   */
  async checkStaleness(
    taskId: string,
    filePath: string
  ): Promise<{ stale: boolean; reason?: string } | null> {
    const taskMap = this.getTaskMap(taskId);
    const state = taskMap.get(filePath);

    if (!state) {
      // File was never read - we can't check staleness
      return null;
    }

    try {
      const { stat } = await import('@tauri-apps/plugin-fs');
      const fileStats = await stat(filePath);
      const currentModifiedTime = fileStats.mtime?.getTime() || 0;

      if (currentModifiedTime !== state.modifiedTime) {
        return {
          stale: true,
          reason: `File was modified externally since last read (read at ${new Date(state.readTimestamp).toISOString()}, modified at ${new Date(currentModifiedTime).toISOString()})`,
        };
      }

      return { stale: false };
    } catch (error) {
      logger.error(`Failed to check file staleness: ${filePath}`, error);
      // If we can't check, assume not stale to avoid blocking edits unnecessarily
      return { stale: false };
    }
  }

  /**
   * Get the read state for a file
   */
  getState(taskId: string, filePath: string): FileReadState | undefined {
    return this.getTaskMap(taskId).get(filePath);
  }

  /**
   * Clear all state for a task
   */
  clearTask(taskId: string): void {
    this.states.delete(taskId);
  }

  /**
   * Clear state for a specific file in a task
   */
  clearFile(taskId: string, filePath: string): void {
    this.getTaskMap(taskId).delete(filePath);
  }
}

export const fileReadStateTracker = new FileReadStateTracker();
