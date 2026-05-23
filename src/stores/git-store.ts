import { create } from 'zustand';
import { logger } from '@/lib/logger';
import { aiGitMessagesService } from '@/services/ai/ai-git-messages-service';
import { gitService } from '@/services/git-service';
import type { BranchInfo, FileStatusMap, GitStatus, LineChange, TagInfo } from '@/types/git';
import { GitFileStatus } from '@/types/git';

interface GitStore {
  // State
  repositoryPath: string | null;
  isGitRepository: boolean;
  gitStatus: GitStatus | null;
  fileStatuses: FileStatusMap;
  lineChangesCache: Map<string, LineChange[]>;
  isLoading: boolean;
  error: string | null;
  lastRefresh: number | null;
  branches: BranchInfo[];
  tags: TagInfo[];
  isLoadingBranches: boolean;
  isLoadingTags: boolean;

  // Operation states
  isPushing: boolean;
  pushOperationId: string | null;
  isGenerating: boolean;
  isCommitting: boolean;

  // Actions
  initialize: (repoPath: string) => Promise<void>;
  refreshStatus: () => Promise<void>;
  getFileStatus: (filePath: string) => GitFileStatus | null;
  isFileModified: (filePath: string) => boolean;
  isFileStaged: (filePath: string) => boolean;
  getLineChanges: (filePath: string) => Promise<LineChange[]>;
  setLineChanges: (filePath: string, changes: LineChange[]) => void;
  clearLineChangesCache: () => void;
  clearState: () => void;

  // Branch and Tag Actions
  loadBranches: () => Promise<void>;
  loadTags: () => Promise<void>;
  checkoutBranch: (branchName: string) => Promise<void>;
  checkoutTag: (tagName: string) => Promise<void>;

  // Git Operations
  stageFiles: (filePaths: string[]) => Promise<void>;
  unstageFiles: (filePaths: string[]) => Promise<void>;
  commit: (message: string) => Promise<string>;
  stageAll: () => Promise<void>;
  discardChanges: (filePath: string) => Promise<void>;
  push: (remote?: string, branch?: string) => Promise<string>;
  pull: (remote?: string, branch?: string) => Promise<string>;
  cancelPush: () => Promise<void>;
  generateCommitMessage: (language: string) => Promise<string>;
}

// Track in-flight requests to prevent duplicate fetches
const fetchingPromises = new Map<string, Promise<LineChange[]>>();

export const useGitStore = create<GitStore>((set, get) => ({
  // Initial state
  repositoryPath: null,
  isGitRepository: false,
  gitStatus: null,
  fileStatuses: {},
  lineChangesCache: new Map(),
  isLoading: false,
  error: null,
  lastRefresh: null,
  branches: [],
  tags: [],
  isLoadingBranches: false,
  isLoadingTags: false,
  isPushing: false,
  pushOperationId: null,
  isGenerating: false,
  isCommitting: false,

  // Initialize Git for a repository
  initialize: async (repoPath: string) => {
    logger.info(`Initializing Git for repository: ${repoPath}`);
    set({ isLoading: true, error: null, repositoryPath: repoPath });

    try {
      // Check if it's a Git repository
      const isRepo = await gitService.isRepository(repoPath);

      if (!isRepo) {
        logger.info(`${repoPath} is not a Git repository`);
        set({
          isGitRepository: false,
          gitStatus: null,
          fileStatuses: {},
          isLoading: false,
        });
        return;
      }

      logger.info(`${repoPath} is a valid Git repository`);
      set({ isGitRepository: true });

      // Get initial Git status
      await get().refreshStatus();
      logger.info('Git initialization completed successfully');
    } catch (error) {
      logger.error('Failed to initialize Git:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to initialize Git',
        isLoading: false,
      });
    }
  },

  // Refresh Git status
  refreshStatus: async () => {
    const { repositoryPath, isGitRepository } = get();

    if (!repositoryPath || !isGitRepository) {
      return;
    }

    set({ isLoading: true, error: null });

    try {
      // Get full Git status
      const [gitStatus, fileStatuses] = await Promise.all([
        gitService.getStatus(repositoryPath),
        gitService.getAllFileStatuses(repositoryPath),
      ]);

      if (Object.keys(fileStatuses).length > 0) {
        logger.debug('Sample file paths in status map:', Object.keys(fileStatuses).slice(0, 5));
      }

      // Clear line changes cache since Git status has changed
      get().clearLineChangesCache();

      set({
        gitStatus,
        fileStatuses,
        isLoading: false,
        lastRefresh: Date.now(),
      });
    } catch (error) {
      logger.error('Failed to refresh Git status:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to refresh Git status',
        isLoading: false,
      });
    }
  },

  // Get status for a specific file
  getFileStatus: (filePath: string): GitFileStatus | null => {
    const { fileStatuses, repositoryPath, isGitRepository } = get();

    // Silently return null if Git is not initialized yet or not a Git repository
    if (!repositoryPath || !isGitRepository) {
      return null;
    }

    // Try with absolute path first
    let status = fileStatuses[filePath];

    if (status) {
      return status[0];
    }

    // If not found, try with relative path
    if (filePath.startsWith(repositoryPath)) {
      // Normalize repository path (remove trailing slash)
      const normalizedRepoPath = repositoryPath.replace(/\/$/, '');
      const relativePath = filePath.slice(normalizedRepoPath.length).replace(/^\//, '');

      status = fileStatuses[relativePath];

      if (status) {
        return status[0];
      }
    } else {
      // FilePath doesn't start with repositoryPath, try as relative path directly
      status = fileStatuses[filePath];
      if (status) {
        return status[0];
      }
    }

    return null;
  },

  // Check if a file is modified
  isFileModified: (filePath: string): boolean => {
    const status = get().getFileStatus(filePath);
    return (
      status === GitFileStatus.Modified ||
      status === GitFileStatus.Deleted ||
      status === GitFileStatus.Added
    );
  },

  // Check if a file is staged
  isFileStaged: (filePath: string): boolean => {
    const { fileStatuses, repositoryPath } = get();

    if (!repositoryPath) {
      return false;
    }

    // Try with absolute path first
    let status = fileStatuses[filePath];

    if (status) {
      return status[1];
    }

    // If not found, try with relative path
    if (filePath.startsWith(repositoryPath)) {
      // Normalize repository path (remove trailing slash)
      const normalizedRepoPath = repositoryPath.replace(/\/$/, '');
      const relativePath = filePath.slice(normalizedRepoPath.length).replace(/^\//, '');
      status = fileStatuses[relativePath];

      if (status) {
        return status[1];
      }
    } else {
      // FilePath doesn't start with repositoryPath, try as relative path directly
      status = fileStatuses[filePath];
      if (status) {
        return status[1];
      }
    }

    return false;
  },

  // Get line changes for a file (with caching and duplicate fetch prevention)
  getLineChanges: async (filePath: string): Promise<LineChange[]> => {
    const { lineChangesCache, repositoryPath, isGitRepository } = get();

    if (!repositoryPath || !isGitRepository) {
      return [];
    }

    // Check cache first
    if (lineChangesCache.has(filePath)) {
      logger.debug(`Cache hit for line changes: ${filePath}`);
      return lineChangesCache.get(filePath) || [];
    }

    // Check if already fetching this file
    if (fetchingPromises.has(filePath)) {
      logger.debug(`Fetch already in progress for ${filePath}, waiting...`);
      return fetchingPromises.get(filePath) as Promise<LineChange[]>;
    }

    // Cache miss - fetch from backend
    logger.debug(`Cache miss for line changes: ${filePath}, fetching...`);

    // Create and track the fetch promise
    const fetchPromise = (async () => {
      try {
        const lineChanges = await gitService.getLineChanges(repositoryPath, filePath);

        // Store in cache
        get().setLineChanges(filePath, lineChanges);

        return lineChanges;
      } catch (error) {
        logger.error(`Failed to get line changes for ${filePath}:`, error);
        return [];
      } finally {
        // Remove from tracking map when done
        fetchingPromises.delete(filePath);
      }
    })();

    // Track this promise
    fetchingPromises.set(filePath, fetchPromise);

    return fetchPromise;
  },

  // Set line changes in cache
  setLineChanges: (filePath: string, changes: LineChange[]): void => {
    const { lineChangesCache } = get();
    lineChangesCache.set(filePath, changes);
    logger.debug(`Cached line changes for: ${filePath} (${changes.length} changes)`);
  },

  // Clear line changes cache
  clearLineChangesCache: (): void => {
    const { lineChangesCache } = get();
    const count = lineChangesCache.size;
    lineChangesCache.clear();
    fetchingPromises.clear(); // Also clear in-flight requests
    logger.debug(`Cleared line changes cache (${count} entries)`);
  },

  // Clear all Git state
  clearState: () => {
    // Clear the cache before resetting state
    get().clearLineChangesCache();

    set({
      repositoryPath: null,
      isGitRepository: false,
      gitStatus: null,
      fileStatuses: {},
      lineChangesCache: new Map(),
      isLoading: false,
      error: null,
      lastRefresh: null,
      branches: [],
      tags: [],
    });
  },

  // Load all branches
  loadBranches: async () => {
    const { repositoryPath, isGitRepository } = get();
    if (!repositoryPath || !isGitRepository) {
      return;
    }

    set({ isLoadingBranches: true });

    try {
      const branches = await gitService.getBranches(repositoryPath);
      set({ branches, isLoadingBranches: false });
      logger.debug(`Loaded ${branches.length} branches`);
    } catch (error) {
      logger.error('Failed to load branches:', error);
      set({ isLoadingBranches: false });
    }
  },

  // Load all tags
  loadTags: async () => {
    const { repositoryPath, isGitRepository } = get();
    if (!repositoryPath || !isGitRepository) {
      return;
    }

    set({ isLoadingTags: true });

    try {
      const tags = await gitService.getTags(repositoryPath);
      set({ tags, isLoadingTags: false });
      logger.debug(`Loaded ${tags.length} tags`);
    } catch (error) {
      logger.error('Failed to load tags:', error);
      set({ isLoadingTags: false });
    }
  },

  // Checkout a branch
  checkoutBranch: async (branchName: string) => {
    const { repositoryPath } = get();
    if (!repositoryPath) {
      throw new Error('No repository path set');
    }

    try {
      await gitService.checkoutBranch(repositoryPath, branchName);
      logger.info(`Checked out branch: ${branchName}`);
      // Refresh status and branches after checkout
      await Promise.all([get().refreshStatus(), get().loadBranches()]);
    } catch (error) {
      logger.error(`Failed to checkout branch ${branchName}:`, error);
      throw error;
    }
  },

  // Checkout a tag
  checkoutTag: async (tagName: string) => {
    const { repositoryPath } = get();
    if (!repositoryPath) {
      throw new Error('No repository path set');
    }

    try {
      await gitService.checkoutTag(repositoryPath, tagName);
      logger.info(`Checked out tag: ${tagName}`);
      // Refresh status and branches after checkout
      await Promise.all([get().refreshStatus(), get().loadBranches()]);
    } catch (error) {
      logger.error(`Failed to checkout tag ${tagName}:`, error);
      throw error;
    }
  },

  // Stage files for commit
  stageFiles: async (filePaths: string[]) => {
    const { repositoryPath } = get();
    if (!repositoryPath) {
      throw new Error('No repository path set');
    }

    try {
      await gitService.stageFiles(repositoryPath, filePaths);
      logger.info(`Staged ${filePaths.length} files`);
      // Refresh status after staging
      await get().refreshStatus();
    } catch (error) {
      logger.error('Failed to stage files:', error);
      throw error;
    }
  },

  // Unstage files (reset to HEAD)
  unstageFiles: async (filePaths: string[]) => {
    const { repositoryPath } = get();
    if (!repositoryPath) {
      throw new Error('No repository path set');
    }

    try {
      await gitService.unstageFiles(repositoryPath, filePaths);
      logger.info(`Unstaged ${filePaths.length} files`);
      // Refresh status after unstaging
      await get().refreshStatus();
    } catch (error) {
      logger.error('Failed to unstage files:', error);
      throw error;
    }
  },

  // Commit staged changes
  commit: async (message: string) => {
    const { repositoryPath, isCommitting } = get();
    if (!repositoryPath) {
      throw new Error('No repository path set');
    }

    if (isCommitting) {
      throw new Error('Commit operation already in progress');
    }

    set({ isCommitting: true });

    try {
      const commitHash = await gitService.commit(repositoryPath, message);
      logger.info(`Committed changes: ${commitHash}`);
      // Refresh status after commit
      await get().refreshStatus();
      return commitHash;
    } catch (error) {
      logger.error('Failed to commit:', error);
      throw error;
    } finally {
      set({ isCommitting: false });
    }
  },

  // Stage all changes
  stageAll: async () => {
    const { repositoryPath } = get();
    if (!repositoryPath) {
      throw new Error('No repository path set');
    }

    try {
      await gitService.stageAll(repositoryPath);
      logger.info('Staged all changes');
      // Refresh status after staging
      await get().refreshStatus();
    } catch (error) {
      logger.error('Failed to stage all changes:', error);
      throw error;
    }
  },

  // Discard changes in a file
  discardChanges: async (filePath: string) => {
    const { repositoryPath } = get();
    if (!repositoryPath) {
      throw new Error('No repository path set');
    }

    try {
      await gitService.discardChanges(repositoryPath, filePath);
      logger.info(`Discarded changes in ${filePath}`);
      // Refresh status after discarding
      await get().refreshStatus();
    } catch (error) {
      logger.error('Failed to discard changes:', error);
      throw error;
    }
  },

  // Push commits to remote
  push: async (remote?: string, branch?: string) => {
    const { repositoryPath, isPushing } = get();
    if (!repositoryPath) {
      throw new Error('No repository path set');
    }

    if (isPushing) {
      throw new Error('Push operation already in progress');
    }

    // Generate operation ID for cancellation
    const operationId = `push-${Date.now()}`;
    set({ isPushing: true, pushOperationId: operationId });

    try {
      const result = await gitService.pushAsync(repositoryPath, remote, branch, operationId);
      logger.info(`Pushed to remote: ${result}`);
      // Refresh status after push
      await get().refreshStatus();
      return result;
    } catch (error) {
      logger.error('Failed to push:', error);
      throw error;
    } finally {
      set({ isPushing: false, pushOperationId: null });
    }
  },

  // Cancel ongoing push operation
  cancelPush: async () => {
    const { pushOperationId } = get();
    if (!pushOperationId) {
      return;
    }

    try {
      await gitService.cancelPush(pushOperationId);
      logger.info('Push operation cancelled');
    } catch (error) {
      logger.error('Failed to cancel push:', error);
    } finally {
      set({ isPushing: false, pushOperationId: null });
    }
  },

  // Generate commit message with AI
  generateCommitMessage: async (language: string) => {
    const { repositoryPath, isGenerating } = get();
    if (!repositoryPath) {
      throw new Error('No repository path set');
    }

    if (isGenerating) {
      throw new Error('Generation already in progress');
    }

    set({ isGenerating: true });

    try {
      // Get diff text for staged files
      const diffText = await gitService.getStagedDiffText(repositoryPath);

      if (!diffText || diffText.trim().length === 0) {
        throw new Error('No staged changes');
      }

      const result = await aiGitMessagesService.generateCommitMessage({
        diffText,
        language,
      });

      if (result?.message) {
        logger.info('Commit message generated successfully');
        return result.message;
      }
      throw new Error('Failed to generate commit message');
    } catch (error) {
      logger.error('Failed to generate commit message:', error);
      throw error;
    } finally {
      set({ isGenerating: false });
    }
  },

  // Pull changes from remote
  pull: async (remote?: string, branch?: string) => {
    const { repositoryPath } = get();
    if (!repositoryPath) {
      throw new Error('No repository path set');
    }

    try {
      const result = await gitService.pull(repositoryPath, remote, branch);
      logger.info(`Pulled from remote: ${result}`);
      // Refresh status after pull
      await get().refreshStatus();
      return result;
    } catch (error) {
      logger.error('Failed to pull:', error);
      throw error;
    }
  },
}));
