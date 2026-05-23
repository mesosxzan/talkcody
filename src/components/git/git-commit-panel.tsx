import { Check, GitBranch, Loader2, Minus, Plus, RefreshCw, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLocale } from '@/hooks/use-locale';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { useGitStore } from '@/stores/git-store';
import { GitFileStatus } from '@/types/git';
import { GitCommitMessageInput } from './git-commit-message-input';
import { GitFileList } from './git-file-list';

interface GitCommitPanelProps {
  onFileClick?: (filePath: string) => void;
}

export function GitCommitPanel({ onFileClick }: GitCommitPanelProps) {
  const { locale, t } = useLocale();
  const gitStatus = useGitStore((state) => state.gitStatus);
  const repositoryPath = useGitStore((state) => state.repositoryPath);
  const isLoading = useGitStore((state) => state.isLoading);
  const refreshStatus = useGitStore((state) => state.refreshStatus);
  const stageFiles = useGitStore((state) => state.stageFiles);
  const unstageFiles = useGitStore((state) => state.unstageFiles);
  const commit = useGitStore((state) => state.commit);
  const discardChanges = useGitStore((state) => state.discardChanges);
  const push = useGitStore((state) => state.push);
  const cancelPush = useGitStore((state) => state.cancelPush);
  const isPushing = useGitStore((state) => state.isPushing);
  const isGenerating = useGitStore((state) => state.isGenerating);
  const isCommitting = useGitStore((state) => state.isCommitting);
  const generateCommitMessage = useGitStore((state) => state.generateCommitMessage);

  const [commitMessage, setCommitMessage] = useState('');

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
        toast.success(t.Git.messages.stageSuccess);
      } else {
        await unstageFiles([filePath]);
        toast.success(t.Git.messages.unstageSuccess);
      }
    } catch (error) {
      logger.error('Failed to toggle stage:', error);
      toast.error(stage ? t.Git.messages.stageSuccess : t.Git.messages.unstageSuccess);
    }
  };

  // Handle batch stage all modified files
  const handleStageAllModified = async () => {
    try {
      const filePaths = modifiedFiles.map((f) => f.path);
      if (filePaths.length === 0) return;

      await stageFiles(filePaths);
      toast.success(t.Git.messages.stageSuccess);
    } catch (error) {
      logger.error('Failed to stage all modified files:', error);
      toast.error(t.Git.messages.stageSuccess);
    }
  };

  // Handle batch stage all untracked files
  const handleStageAllUntracked = async () => {
    try {
      const filePaths = untrackedFiles.map((f) => f.path);
      if (filePaths.length === 0) return;

      await stageFiles(filePaths);
      toast.success(t.Git.messages.stageSuccess);
    } catch (error) {
      logger.error('Failed to stage all untracked files:', error);
      toast.error(t.Git.messages.stageSuccess);
    }
  };

  // Handle batch unstage all staged files
  const handleUnstageAll = async () => {
    try {
      const filePaths = stagedFiles.map((f) => f.path);
      if (filePaths.length === 0) return;

      await unstageFiles(filePaths);
      toast.success(t.Git.messages.unstageSuccess);
    } catch (error) {
      logger.error('Failed to unstage all files:', error);
      toast.error(t.Git.messages.unstageSuccess);
    }
  };

  // Handle discard
  const handleDiscard = async (filePath: string) => {
    try {
      await discardChanges(filePath);
      toast.success(t.Git.messages.discardSuccess);
    } catch (error) {
      logger.error('Failed to discard changes:', error);
      toast.error(t.Git.messages.discardSuccess);
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
      toast.error(t.Git.messages.noStagedChanges);
      return;
    }

    try {
      const message = await generateCommitMessage(locale);
      setCommitMessage(message);
      toast.success(t.Git.messages.generateSuccess);
    } catch (error) {
      logger.error('Failed to generate commit message:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (errorMessage === 'No staged changes') {
        toast.error(t.Git.messages.noStagedChanges);
      } else {
        toast.error(t.Git.messages.generateSuccess);
      }
    }
  };

  // Handle commit
  const handleCommit = async () => {
    if (!commitMessage.trim()) {
      toast.error(t.Git.messages.emptyMessage);
      return;
    }

    if (!hasStagedChanges) {
      toast.error(t.Git.messages.noStagedChanges);
      return;
    }

    try {
      const commitHash = await commit(commitMessage);
      toast.success(`${t.Git.messages.commitSuccess}: ${commitHash.substring(0, 7)}`);
      setCommitMessage('');
    } catch (error) {
      logger.error('Failed to commit:', error);
      toast.error(t.Git.messages.commitSuccess);
    }
  };

  // Handle refresh
  const handleRefresh = async () => {
    try {
      await refreshStatus();
      toast.success(t.Git.refresh);
    } catch (error) {
      logger.error('Failed to refresh:', error);
      toast.error(t.Git.refresh);
    }
  };

  // Handle push
  const handlePush = async () => {
    try {
      const result = await push();
      toast.success(result);
    } catch (error) {
      logger.error('Failed to push:', error);
      toast.error(t.Git.messages.pushFailed);
    }
  };

  // Handle cancel push
  const handleCancelPush = async () => {
    try {
      await cancelPush();
      toast.success(t.Git.messages.pushCancelled);
    } catch (error) {
      logger.error('Failed to cancel push:', error);
      toast.error(t.Git.messages.pushCancelFailed);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{gitStatus?.branch?.name || t.Git.noBranch}</span>
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
          placeholder={hasStagedChanges ? t.Git.commitPlaceholder : t.Git.messages.noStagedChanges}
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
                {t.Git.generating}
              </>
            ) : (
              <>
                <Check className="mr-2 h-4 w-4" />
                {t.Git.commitButton}
              </>
            )}
          </Button>

          {/* Push/Cancel Push button */}
          <Button
            variant="outline"
            onClick={isPushing ? handleCancelPush : handlePush}
            title={isPushing ? t.Git.messages.cancelPush : t.Git.push}
            className={isPushing ? 'cursor-pointer' : ''}
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
                {t.Git.staged} ({stagedFiles.length})
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
                <TooltipContent side="left">{t.Git.unstage}</TooltipContent>
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
                {t.Git.changes} ({modifiedFiles.length})
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
                <TooltipContent side="left">{t.Git.stage}</TooltipContent>
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
                {t.Git.untracked} ({untrackedFiles.length})
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
                <TooltipContent side="left">{t.Git.stage}</TooltipContent>
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
              {t.Git.noChanges}
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
