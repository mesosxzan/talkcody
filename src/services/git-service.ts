import { invoke } from '@tauri-apps/api/core';
import type {
  BranchInfo,
  FileDiff,
  FileStatusMap,
  GitStatus,
  LineChange,
  RemoteBranchInfo,
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

  /**
   * Create a new branch
   */
  async createBranch(repoPath: string, branchName: string, startPoint?: string): Promise<void> {
    return invoke<void>('git_create_branch', {
      repoPath,
      branchName,
      startPoint,
    });
  }

  /**
   * Get all remote branches
   */
  async getRemoteBranches(repoPath: string): Promise<RemoteBranchInfo[]> {
    return invoke<RemoteBranchInfo[]>('git_get_remote_branches', { repoPath });
  }

  /**
   * Fetch from remote repository
   */
  async fetch(repoPath: string, remote?: string): Promise<string> {
    return invoke<string>('git_fetch', { repoPath, remote });
  }

  /**
   * Checkout a remote branch (creates local tracking branch)
   */
  async checkoutRemoteBranch(
    repoPath: string,
    remoteBranch: string,
    localBranch?: string
  ): Promise<void> {
    return invoke<void>('git_checkout_remote_branch', {
      repoPath,
      remoteBranch,
      localBranch,
    });
  }

  /**
   * Delete a local branch
   */
  async deleteBranch(repoPath: string, branchName: string): Promise<void> {
    return invoke<void>('git_delete_branch', { repoPath, branchName });
  }

  /**
   * Push a local branch to remote
   */
  async pushBranch(
    repoPath: string,
    branchName: string,
    remote?: string,
    setUpstream?: boolean
  ): Promise<string> {
    return invoke<string>('git_push_branch', {
      repoPath,
      branchName,
      remote,
      setUpstream,
    });
  }

  /**
   * Create a tag
   */
  async createTag(
    repoPath: string,
    tagName: string,
    message?: string,
    target?: string
  ): Promise<void> {
    return invoke<void>('git_create_tag', {
      repoPath,
      tagName,
      message,
      target,
    });
  }

  /**
   * Push tags to remote
   */
  async pushTag(repoPath: string, tagName?: string, remote?: string): Promise<string> {
    return invoke<string>('git_push_tag', { repoPath, tagName, remote });
  }

  /**
   * Delete a tag
   */
  async deleteTag(repoPath: string, tagName: string, remote?: string): Promise<void> {
    return invoke<void>('git_delete_tag', { repoPath, tagName, remote });
  }

  /**
   * Merge a branch into current branch
   */
  async mergeBranch(
    repoPath: string,
    branchName: string,
    noFF?: boolean,
    message?: string
  ): Promise<string> {
    return invoke<string>('git_merge_branch', {
      repoPath,
      branchName,
      noFF,
      message,
    });
  }

  /**
   * Abort an in-progress merge
   */
  async abortMerge(repoPath: string): Promise<void> {
    return invoke<void>('git_abort_regular_merge', { repoPath });
  }

  /**
   * Check if there is an ongoing merge
   */
  async isMerging(repoPath: string): Promise<boolean> {
    return invoke<boolean>('git_is_merging', { repoPath });
  }
}

// Export a singleton instance
export const gitService = new GitService();
