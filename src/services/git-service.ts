import { invoke } from '@tauri-apps/api/core';
import type { FileDiff, FileStatusMap, GitStatus, LineChange } from '../types/git';

/**
 * Service layer for Git operations using Tauri commands
 */
export class GitService {
  /**
   * Gets the full Git status for a repository
   */
  async getStatus(repoPath: string): Promise<GitStatus> {
    return invoke<GitStatus>('git_get_status', { repoPath });
  }

  /**
   * Checks if a path is a Git repository
   */
  async isRepository(repoPath: string): Promise<boolean> {
    return invoke<boolean>('git_is_repository', { repoPath });
  }

  /**
   * Gets all file statuses as a map
   */
  async getAllFileStatuses(repoPath: string): Promise<FileStatusMap> {
    return invoke<FileStatusMap>('git_get_all_file_statuses', { repoPath });
  }

  /**
   * Gets line-level changes for a file (for editor gutter indicators)
   */
  async getLineChanges(repoPath: string, filePath: string): Promise<LineChange[]> {
    return invoke<LineChange[]>('git_get_line_changes', {
      repoPath,
      filePath,
    });
  }

  /**
   * Gets full diff for all changed files in the repository
   */
  async getAllFileDiffs(repoPath: string): Promise<FileDiff[]> {
    return invoke<FileDiff[]>('git_get_all_file_diffs', { repoPath });
  }

  /**
   * Gets raw diff text for all changed files (for AI commit message generation)
   * Returns text similar to `git diff` output
   */
  async getRawDiffText(repoPath: string): Promise<string> {
    return invoke<string>('git_get_raw_diff_text', { repoPath });
  }

  /**
   * Stages files for commit
   */
  async stageFiles(repoPath: string, filePaths: string[]): Promise<void> {
    return invoke<void>('git_stage_files', { repoPath, filePaths });
  }

  /**
   * Unstages files (reset to HEAD)
   */
  async unstageFiles(repoPath: string, filePaths: string[]): Promise<void> {
    return invoke<void>('git_unstage_files', { repoPath, filePaths });
  }

  /**
   * Commits staged changes with a message
   */
  async commit(repoPath: string, message: string): Promise<string> {
    return invoke<string>('git_commit', { repoPath, message });
  }

  /**
   * Stages all changes (git add -A)
   */
  async stageAll(repoPath: string): Promise<void> {
    return invoke<void>('git_stage_all', { repoPath });
  }

  /**
   * Discards changes in a file (checkout -- file)
   */
  async discardChanges(repoPath: string, filePath: string): Promise<void> {
    return invoke<void>('git_discard_changes', { repoPath, filePath });
  }

  /**
   * Gets diff for a specific file
   */
  async getFileDiff(repoPath: string, filePath: string): Promise<FileDiff> {
    return invoke<FileDiff>('git_get_file_diff', { repoPath, filePath });
  }

  /**
   * Push commits to remote repository
   */
  async push(repoPath: string, remote?: string, branch?: string): Promise<string> {
    return invoke<string>('git_push', { repoPath, remote, branch });
  }

  /**
   * Pull changes from remote repository
   */
  async pull(repoPath: string, remote?: string, branch?: string): Promise<string> {
    return invoke<string>('git_pull', { repoPath, remote, branch });
  }
}

// Export a singleton instance
export const gitService = new GitService();
