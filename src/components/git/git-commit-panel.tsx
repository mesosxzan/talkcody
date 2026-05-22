import { Check, GitBranch, Loader2, Minus, Plus, RefreshCw, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { aiGitMessagesService } from '@/services/ai/ai-git-messages-service';
import { gitService } from '@/services/git-service';
import { useGitStore } from '@/stores/git-store';
import { GitFileStatus } from '@/types/git';
import { GitCommitMessageInput } from './git-commit-message-input';
import { GitFileList } from './git-file-list';

interface GitCommitPanelProps {
  onFileClick?: (filePath: string) => void;
}

export function GitCommitPanel({ onFileClick }: GitCommitPanelProps) {
  const gitStatus = useGitStore((state) => state.gitStatus);
  const repositoryPath = useGitStore((state) => state.repositoryPath);
  const isLoading = useGitStore((state) => state.isLoading);
  const refreshStatus = useGitStore((state) => state.refreshStatus);
  const stageFiles = useGitStore((state) => state.stageFiles);
  const unstageFiles = useGitStore((state) => state.unstageFiles);
  const commit = useGitStore((state) => state.commit);
  const discardChanges = useGitStore((state) => state.discardChanges);
  const push = useGitStore((state) => state.push);

  const [commitMessage, setCommitMessage] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isPushing, setIsPushing] = useState(false);

  // Auto-refresh Git status when component mounts
  useEffect(() => {
    if (repositoryPath && gitStatus === null) {
      refreshStatus();
    }
  }, [repositoryPath, gitStatus, refreshStatus]);

  // Get staged and unstaged files
  const stagedFiles = gitStatus?.staged || [];
  const modifiedFiles = gitStatus?.modified || [];
  const untrackedFiles = (gitStatus?.untracked || []).map((path) => ({
    path,
    status: GitFileStatus.Untracked,
    staged: false,
  }));

  const hasStagedChanges = stagedFiles.length > 0;
  const hasChanges = gitStatus && gitStatus.changesCount > 0;

  // Handle stage/unstage single file
  const handleToggleStage = async (filePath: string, stage: boolean) => {
    try {
      if (stage) {
        await stageFiles([filePath]);
        toast.success(`Staged ${filePath}`);
      } else {
        await unstageFiles([filePath]);
        toast.success(`Unstaged ${filePath}`);
      }
    } catch (error) {
      logger.error('Failed to toggle stage:', error);
      toast.error(stage ? 'Failed to stage file' : 'Failed to unstage file');
    }
  };

  // Handle batch stage all modified files
  const handleStageAllModified = async () => {
    try {
      const filePaths = modifiedFiles.map((f) => f.path);
      if (filePaths.length === 0) return;

      await stageFiles(filePaths);
      toast.success(`Staged ${filePaths.length} modified files`);
    } catch (error) {
      logger.error('Failed to stage all modified files:', error);
      toast.error('Failed to stage all modified files');
    }
  };

  // Handle batch stage all untracked files
  const handleStageAllUntracked = async () => {
    try {
      const filePaths = untrackedFiles.map((f) => f.path);
      if (filePaths.length === 0) return;

      await stageFiles(filePaths);
      toast.success(`Staged ${filePaths.length} untracked files`);
    } catch (error) {
      logger.error('Failed to stage all untracked files:', error);
      toast.error('Failed to stage all untracked files');
    }
  };

  // Handle batch unstage all staged files
  const handleUnstageAll = async () => {
    try {
      const filePaths = stagedFiles.map((f) => f.path);
      if (filePaths.length === 0) return;

      await unstageFiles(filePaths);
      toast.success(`Unstaged ${filePaths.length} files`);
    } catch (error) {
      logger.error('Failed to unstage all files:', error);
      toast.error('Failed to unstage all files');
    }
  };

  // Handle discard
  const handleDiscard = async (filePath: string) => {
    try {
      await discardChanges(filePath);
      toast.success(`Discarded changes in ${filePath}`);
    } catch (error) {
      logger.error('Failed to discard changes:', error);
      toast.error('Failed to discard changes');
    }
  };

  // Handle file click
  const handleFileClick = (filePath: string) => {
    onFileClick?.(filePath);
  };

  // Handle AI generate
  const handleGenerateAI = async () => {
    if (!repositoryPath) return;

    if (!hasStagedChanges) {
      toast.error('No staged changes to generate commit message from');
      return;
    }

    setIsGenerating(true);
    try {
      // Get diff text for staged files only (the actual content that will be committed)
      const diffText = await gitService.getStagedDiffText(repositoryPath);

      if (!diffText || diffText.trim().length === 0) {
        toast.error('No staged changes to generate commit message from');
        return;
      }

      const result = await aiGitMessagesService.generateCommitMessage({
        diffText,
      });

      if (result?.message) {
        setCommitMessage(result.message);
        toast.success('Generated commit message');
      } else {
        toast.error('Failed to generate commit message');
      }
    } catch (error) {
      logger.error('Failed to generate commit message:', error);
      toast.error('Failed to generate commit message');
    } finally {
      setIsGenerating(false);
    }
  };

  // Handle commit
  const handleCommit = async () => {
    if (!commitMessage.trim()) {
      toast.error('Please enter a commit message');
      return;
    }

    if (!hasStagedChanges) {
      toast.error('No staged changes to commit');
      return;
    }

    setIsCommitting(true);
    try {
      const commitHash = await commit(commitMessage);
      toast.success(`Committed: ${commitHash.substring(0, 7)}`);
      setCommitMessage('');
    } catch (error) {
      logger.error('Failed to commit:', error);
      toast.error('Failed to commit');
    } finally {
      setIsCommitting(false);
    }
  };

  // Handle refresh
  const handleRefresh = async () => {
    try {
      await refreshStatus();
      toast.success('Refreshed Git status');
    } catch (error) {
      logger.error('Failed to refresh:', error);
      toast.error('Failed to refresh');
    }
  };

  // Handle push
  const handlePush = async () => {
    setIsPushing(true);
    try {
      const result = await push();
      toast.success(result);
    } catch (error) {
      logger.error('Failed to push:', error);
      toast.error('Failed to push to remote');
    } finally {
      setIsPushing(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{gitStatus?.branch?.name || 'No branch'}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={handleRefresh}
          disabled={isLoading}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
        </Button>
      </div>

      {/* Commit message input and button */}
      <div className="border-b p-3 space-y-3">
        <GitCommitMessageInput
          value={commitMessage}
          onChange={setCommitMessage}
          onGenerateAI={handleGenerateAI}
          isGenerating={isGenerating}
          disabled={!hasStagedChanges}
          placeholder={hasStagedChanges ? 'Enter commit message...' : 'Stage changes first...'}
        />

        {/* Commit button - moved to under message input */}
        <div className="flex gap-2">
          <Button
            className="flex-1"
            onClick={handleCommit}
            disabled={!hasStagedChanges || !commitMessage.trim() || isCommitting}
          >
            {isCommitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Committing...
              </>
            ) : (
              <>
                <Check className="mr-2 h-4 w-4" />
                Commit
              </>
            )}
          </Button>

          {/* Push button */}
          <Button
            variant="outline"
            onClick={handlePush}
            disabled={isPushing}
            title="Push commits to remote"
          >
            {isPushing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {/* File lists */}
      <ScrollArea className="flex-1">
        <div className="flex flex-col py-2">
          {/* Staged files with batch unstage */}
          {stagedFiles.length > 0 && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b">
              <span className="text-xs font-medium text-muted-foreground truncate min-w-0">
                Staged Changes ({stagedFiles.length})
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 flex-shrink-0"
                    onClick={handleUnstageAll}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">Unstage all staged files</TooltipContent>
              </Tooltip>
            </div>
          )}
          <GitFileList
            files={stagedFiles}
            isStaged={true}
            onToggleStage={handleToggleStage}
            onFileClick={handleFileClick}
            defaultExpanded={true}
          />

          {/* Modified files with batch stage */}
          {modifiedFiles.length > 0 && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b">
              <span className="text-xs font-medium text-muted-foreground truncate min-w-0">
                Changes ({modifiedFiles.length})
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 flex-shrink-0"
                    onClick={handleStageAllModified}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">Stage all modified files</TooltipContent>
              </Tooltip>
            </div>
          )}
          <GitFileList
            files={modifiedFiles}
            isStaged={false}
            onToggleStage={handleToggleStage}
            onFileClick={handleFileClick}
            onDiscard={handleDiscard}
            defaultExpanded={true}
          />

          {/* Untracked files with batch stage */}
          {untrackedFiles.length > 0 && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b">
              <span className="text-xs font-medium text-muted-foreground truncate min-w-0">
                Untracked ({untrackedFiles.length})
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 flex-shrink-0"
                    onClick={handleStageAllUntracked}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">Stage all untracked files</TooltipContent>
              </Tooltip>
            </div>
          )}
          <GitFileList
            files={untrackedFiles}
            isStaged={false}
            onToggleStage={handleToggleStage}
            onFileClick={handleFileClick}
            defaultExpanded={false}
          />

          {/* Empty state */}
          {!hasChanges && !isLoading && (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              No changes
            </div>
          )}

          {/* Loading state */}
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
