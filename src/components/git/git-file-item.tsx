import { FileText, Minus, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLocale } from '@/hooks/use-locale';
import { cn } from '@/lib/utils';
import type { FileStatus } from '@/types/git';
import { GitFileStatus } from '@/types/git';

interface GitFileItemProps {
  file: FileStatus | { path: string; status: GitFileStatus; staged: boolean };
  isStaged: boolean;
  onToggleStage: (filePath: string, stage: boolean) => void;
  onFileClick: (filePath: string) => void;
  onDiscard?: (filePath: string) => void;
  onDelete?: (filePath: string) => void;
}

export function GitFileItem({
  file,
  isStaged,
  onToggleStage,
  onFileClick,
  onDiscard,
  onDelete,
}: GitFileItemProps) {
  const { t } = useLocale();
  const statusIcon = getStatusIcon(file.status);
  const statusColor = getStatusColor(file.status);

  // Determine which action button to show (discard or delete)
  const showDiscard = !isStaged && file.status !== GitFileStatus.Untracked && onDiscard;
  const showDelete = !isStaged && file.status === GitFileStatus.Untracked && onDelete;

  return (
    <div className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/50">
      {/* Stage/Unstage button */}
      <Button
        variant="ghost"
        size="sm"
        className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onToggleStage(file.path, !isStaged);
        }}
      >
        {isStaged ? (
          <Minus className="h-3 w-3 text-muted-foreground" />
        ) : (
          <Plus className="h-3 w-3 text-muted-foreground" />
        )}
      </Button>

      {/* Status icon */}
      <div className={cn('flex-shrink-0', statusColor)}>{statusIcon}</div>

      {/* File path */}
      <button
        type="button"
        className="flex-1 truncate text-left text-sm hover:underline"
        onClick={() => onFileClick(file.path)}
      >
        {file.path}
      </button>

      {/* Discard button (only for unstaged modified files) */}
      {showDiscard && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onDiscard(file.path);
              }}
            >
              <X className="h-3 w-3 text-muted-foreground hover:text-destructive" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t.Git.discard}</TooltipContent>
        </Tooltip>
      )}

      {/* Delete button (only for unstaged untracked files) */}
      {showDelete && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(file.path);
              }}
            >
              <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t.Git.deleteFile}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function getStatusIcon(status: GitFileStatus) {
  switch (status) {
    case GitFileStatus.Added:
      return <Plus className="h-3.5 w-3.5" />;
    case GitFileStatus.Deleted:
      return <Minus className="h-3.5 w-3.5" />;
    case GitFileStatus.Modified:
      return <FileText className="h-3.5 w-3.5" />;
    case GitFileStatus.Renamed:
      return <FileText className="h-3.5 w-3.5" />;
    case GitFileStatus.Untracked:
      return <FileText className="h-3.5 w-3.5" />;
    case GitFileStatus.Conflicted:
      return <X className="h-3.5 w-3.5" />;
    default:
      return <FileText className="h-3.5 w-3.5" />;
  }
}

function getStatusColor(status: GitFileStatus) {
  switch (status) {
    case GitFileStatus.Added:
      return 'text-green-600 dark:text-green-400';
    case GitFileStatus.Deleted:
      return 'text-red-600 dark:text-red-400';
    case GitFileStatus.Modified:
      return 'text-yellow-600 dark:text-yellow-400';
    case GitFileStatus.Renamed:
      return 'text-blue-600 dark:text-blue-400';
    case GitFileStatus.Untracked:
      return 'text-gray-500 dark:text-gray-400';
    case GitFileStatus.Conflicted:
      return 'text-orange-600 dark:text-orange-400';
    default:
      return 'text-gray-500 dark:text-gray-400';
  }
}
