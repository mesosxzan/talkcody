import type {
  BranchInfo,
  FileDiff,
  FileStatusMap,
  GitStatus,
  LineChange,
  RemoteBranchInfo,
  TagInfo,
} from '../types/git';
import { platformClient } from './platform-client';

/**
 * Service layer for Git operations using platformClient
 */
export class GitService {
  async getStatus(repoPath: string): Promise<GitStatus> {
    return platformClient.git<GitStatus>('git_get_status', { repoPath });
  }

  async isRepository(repoPath: string): Promise<boolean> {
    return platformClient.git<boolean>('git_is_repository', { repoPath });
  }

  async getAllFileStatuses(repoPath: string): Promise<FileStatusMap> {
    return platformClient.git<FileStatusMap>('git_get_all_file_statuses', { repoPath });
  }

  async getLineChanges(repoPath: string, filePath: string): Promise<LineChange[]> {
    return platformClient.git<LineChange[]>('git_get_line_changes', { repoPath, filePath });
  }

  async getAllFileDiffs(repoPath: string): Promise<FileDiff[]> {
    return platformClient.git<FileDiff[]>('git_get_all_file_diffs', { repoPath });
  }

  async getRawDiffText(repoPath: string): Promise<string> {
    return platformClient.git<string>('git_get_raw_diff_text', { repoPath });
  }

  async getStagedDiffText(repoPath: string): Promise<string> {
    return platformClient.git<string>('git_get_staged_diff_text', { repoPath });
  }

  async stageFiles(repoPath: string, filePaths: string[]): Promise<void> {
    return platformClient.git<void>('git_stage_files', { repoPath, filePaths });
  }

  async unstageFiles(repoPath: string, filePaths: string[]): Promise<void> {
    return platformClient.git<void>('git_unstage_files', { repoPath, filePaths });
  }

  async commit(repoPath: string, message: string): Promise<string> {
    return platformClient.git<string>('git_commit', { repoPath, message });
  }

  async stageAll(repoPath: string): Promise<void> {
    return platformClient.git<void>('git_stage_all', { repoPath });
  }

  async discardChanges(repoPath: string, filePath: string): Promise<void> {
    return platformClient.git<void>('git_discard_changes', { repoPath, filePath });
  }

  async deleteUntrackedFile(repoPath: string, filePath: string): Promise<void> {
    return platformClient.git<void>('git_delete_untracked_file', { repoPath, filePath });
  }

  async getFileDiff(repoPath: string, filePath: string): Promise<FileDiff> {
    return platformClient.git<FileDiff>('git_get_file_diff', { repoPath, filePath });
  }

  async push(repoPath: string, remote?: string, branch?: string): Promise<string> {
    return platformClient.git<string>('git_push', { repoPath, remote, branch });
  }

  async pushAsync(
    repoPath: string,
    remote?: string,
    branch?: string,
    operationId?: string
  ): Promise<string> {
    return platformClient.git<string>('git_push_async', { repoPath, remote, branch, operationId });
  }

  async cancelPush(operationId: string): Promise<void> {
    return platformClient.git<void>('git_cancel_push', { operationId });
  }

  async pull(repoPath: string, remote?: string, branch?: string): Promise<string> {
    return platformClient.git<string>('git_pull', { repoPath, remote, branch });
  }

  async getBranches(repoPath: string): Promise<BranchInfo[]> {
    return platformClient.git<BranchInfo[]>('git_get_branches', { repoPath });
  }

  async getTags(repoPath: string): Promise<TagInfo[]> {
    return platformClient.git<TagInfo[]>('git_get_tags', { repoPath });
  }

  async checkoutBranch(repoPath: string, branchName: string): Promise<void> {
    return platformClient.git<void>('git_checkout_branch', { repoPath, branchName });
  }

  async checkoutTag(repoPath: string, tagName: string): Promise<void> {
    return platformClient.git<void>('git_checkout_tag', { repoPath, tagName });
  }

  async getFileContentAtHead(repoPath: string, filePath: string): Promise<string> {
    return platformClient.git<string>('git_get_file_content_at_head', { repoPath, filePath });
  }

  async createBranch(repoPath: string, branchName: string, startPoint?: string): Promise<void> {
    return platformClient.git<void>('git_create_branch', { repoPath, branchName, startPoint });
  }

  async getRemoteBranches(repoPath: string): Promise<RemoteBranchInfo[]> {
    return platformClient.git<RemoteBranchInfo[]>('git_get_remote_branches', { repoPath });
  }

  async fetch(repoPath: string, remote?: string): Promise<string> {
    return platformClient.git<string>('git_fetch', { repoPath, remote });
  }

  async checkoutRemoteBranch(
    repoPath: string,
    remoteBranch: string,
    localBranch?: string
  ): Promise<void> {
    return platformClient.git<void>('git_checkout_remote_branch', {
      repoPath,
      remoteBranch,
      localBranch,
    });
  }

  async deleteBranch(repoPath: string, branchName: string): Promise<void> {
    return platformClient.git<void>('git_delete_branch', { repoPath, branchName });
  }

  async pushBranch(
    repoPath: string,
    branchName: string,
    remote?: string,
    setUpstream?: boolean
  ): Promise<string> {
    return platformClient.git<string>('git_push_branch', {
      repoPath,
      branchName,
      remote,
      setUpstream,
    });
  }

  async createTag(
    repoPath: string,
    tagName: string,
    message?: string,
    target?: string
  ): Promise<void> {
    return platformClient.git<void>('git_create_tag', { repoPath, tagName, message, target });
  }

  async pushTag(repoPath: string, tagName?: string, remote?: string): Promise<string> {
    return platformClient.git<string>('git_push_tag', { repoPath, tagName, remote });
  }

  async deleteTag(repoPath: string, tagName: string, remote?: string): Promise<void> {
    return platformClient.git<void>('git_delete_tag', { repoPath, tagName, remote });
  }

  async mergeBranch(
    repoPath: string,
    branchName: string,
    noFF?: boolean,
    message?: string
  ): Promise<string> {
    return platformClient.git<string>('git_merge_branch', { repoPath, branchName, noFF, message });
  }

  async abortMerge(repoPath: string): Promise<void> {
    return platformClient.git<void>('git_abort_regular_merge', { repoPath });
  }

  async isMerging(repoPath: string): Promise<boolean> {
    return platformClient.git<boolean>('git_is_merging', { repoPath });
  }
}

// Export a singleton instance
export const gitService = new GitService();
