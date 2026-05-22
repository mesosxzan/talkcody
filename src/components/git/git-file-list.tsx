import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { FileStatus } from '@/types/git';
import { GitFileItem } from './git-file-item';

interface GitFileListProps {
  files: FileStatus[];
  isStaged: boolean;
  onToggleStage: (filePath: string, stage: boolean) => void;
  onFileClick: (filePath: string) => void;
  onDiscard?: (filePath: string) => void;
  defaultExpanded?: boolean;
  showHeader?: boolean;
  title?: string;
}

export function GitFileList({
  files,
  isStaged,
  onToggleStage,
  onFileClick,
  onDiscard,
  defaultExpanded = true,
  showHeader = false,
  title = '',
}: GitFileListProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  if (files.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col">
      {/* Header - only show if showHeader is true */}
      {showHeader && (
        <button
          type="button"
          className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <span>
            {title} ({files.length})
          </span>
        </button>
      )}

      {/* File list */}
      {(isExpanded || !showHeader) && (
        <div className="flex flex-col">
          {files.map((file) => (
            <GitFileItem
              key={file.path}
              file={file}
              isStaged={isStaged}
              onToggleStage={onToggleStage}
              onFileClick={onFileClick}
              onDiscard={onDiscard}
            />
          ))}
        </div>
      )}
    </div>
  );
}
