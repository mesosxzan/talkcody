import { ChevronDown, ChevronRight, Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLocale } from '@/hooks/use-locale';
import type { FileStatus } from '@/types/git';
import { GitFileItem } from './git-file-item';

interface GitFileListProps {
  files: FileStatus[];
  isStaged: boolean;
  onToggleStage: (filePath: string, stage: boolean) => void;
  onFileClick: (filePath: string) => void;
  onDiscard?: (filePath: string) => void;
  onDelete?: (filePath: string) => void;
  defaultExpanded?: boolean;
  title: string;
  maxVisibleHeight?: number;
  onStageAll?: () => void;
  onUnstageAll?: () => void;
}

export function GitFileList({
  files,
  isStaged,
  onToggleStage,
  onFileClick,
  onDiscard,
  onDelete,
  defaultExpanded = true,
  title,
  maxVisibleHeight = 200,
  onStageAll,
  onUnstageAll,
}: GitFileListProps) {
  const { t } = useLocale();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  if (files.length === 0) {
    return null;
  }

  // Calculate if scrolling is needed (more than 5 files)
  const needsScroll = files.length > 5;

  // Determine which batch action to show
  const showStageAll = !isStaged && onStageAll;
  const showUnstageAll = isStaged && onUnstageAll;

  return (
    <div className="flex flex-col border-b last:border-b-0">
      {/* Collapsible header with batch actions */}
      <div className="flex items-center gap-1 px-2 py-1.5 hover:bg-muted/30 transition-colors">
        {/* Expand/collapse arrow - never shrinks */}
        <button
          type="button"
          className="flex-none p-0.5 rounded hover:bg-muted transition-colors"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200" />
          )}
        </button>

        {/* Title - shrinks first when space is limited */}
        <span className="text-xs font-medium text-muted-foreground flex-1 min-w-0 truncate shrink">
          {title} ({files.length})
        </span>

        {/* Batch action buttons - never shrinks, always visible */}
        {(showStageAll || showUnstageAll) && (
          <div className="flex-none flex items-center ml-1 gap-0.5">
            {showStageAll && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 opacity-70 hover:opacity-100 hover:bg-muted"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStageAll?.();
                    }}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">{t.Git.tooltips.stageAll}</TooltipContent>
              </Tooltip>
            )}
            {showUnstageAll && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 opacity-70 hover:opacity-100 hover:bg-muted"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUnstageAll?.();
                    }}
                  >
                    <Minus className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">{t.Git.tooltips.unstageAllFiles}</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {/* File list with optional scroll */}
      {isExpanded && (
        <div
          className="flex flex-col overflow-y-auto scrollbar-thin scrollbar-thumb-muted-foreground/20 hover:scrollbar-thumb-muted-foreground/40 scrollbar-track-transparent"
          style={needsScroll ? { maxHeight: `${maxVisibleHeight}px` } : undefined}
        >
          {files.map((file) => (
            <GitFileItem
              key={file.path}
              file={file}
              isStaged={isStaged}
              onToggleStage={onToggleStage}
              onFileClick={onFileClick}
              onDiscard={onDiscard}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
