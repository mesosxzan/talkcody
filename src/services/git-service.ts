import { invoke } from '@tauri-apps/api/core';
import type {
  BranchInfo,
  FileDiff,
  FileStatusMap,
  GitStatus,
  LineChange,
  TagInfo,
} from '../types/git';

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
   * Gets raw diff text for staged files only (for AI commit message generation)
   * Returns text similar to `git diff --cached` output - the actual content that will be committed
   */
  async getStagedDiffText(repoPath: string): Promise<string> {
    return invoke<string>('git_get_staged_diff_text', { repoPath });
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
   * Push commits to remote repository (async with cancellation support)
   */
  async pushAsync(
    repoPath: string,
    remote?: string,
    branch?: string,
    operationId?: string
  ): Promise<string> {
    return invoke<string>('git_push_async', { repoPath, remote, branch, operationId });
  }

  /**
   * Cancel an ongoing git push operation
   */
  async cancelPush(operationId: string): Promise<void> {
    return invoke<void>('git_cancel_push', { operationId });
  }

  /**
   * Pull changes from remote repository
   */
  async pull(repoPath: string, remote?: string, branch?: string): Promise<string> {
    return invoke<string>('git_pull', { repoPath, remote, branch });
  }

  /**
   * Get all branches in the repository
   */
  async getBranches(repoPath: string): Promise<BranchInfo[]> {
    return invoke<BranchInfo[]>('git_get_branches', { repoPath });
  }

  /**
   * Get all tags in the repository
   */
  async getTags(repoPath: string): Promise<TagInfo[]> {
    return invoke<TagInfo[]>('git_get_tags', { repoPath });
  }

  /**
   * Checkout a branch
   */
  async checkoutBranch(repoPath: string, branchName: string): Promise<void> {
    return invoke<void>('git_checkout_branch', { repoPath, branchName });
  }

  /**
   * Checkout a tag (creates detached HEAD state)
   */
  async checkoutTag(repoPath: string, tagName: string): Promise<void> {
    return invoke<void>('git_checkout_tag', { repoPath, tagName });
  }

  /**
   * Get file content at HEAD (committed version)
   */
  async getFileContentAtHead(repoPath: string, filePath: string): Promise<string> {
    return invoke<string>('git_get_file_content_at_head', { repoPath, filePath });
  }
}

// Export a singleton instance
export const gitService = new GitService();
