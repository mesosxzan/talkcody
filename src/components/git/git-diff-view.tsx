import { DiffEditor, type Monaco } from '@monaco-editor/react';
import { FileText, Loader2, Minus, Plus, X } from 'lucide-react';
import type { editor } from 'monaco-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from '@/hooks/use-theme';
import { logger } from '@/lib/logger';
import { gitService } from '@/services/git-service';
import { repositoryService } from '@/services/repository-service';
import type { FileDiff } from '@/types/git';
import { GitFileStatus } from '@/types/git';

interface GitDiffViewProps {
  repoPath: string;
  filePath: string;
  fileStatus?: GitFileStatus;
  onClose?: () => void;
}

export function GitDiffView({ repoPath, filePath, fileStatus, onClose }: GitDiffViewProps) {
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [originalContent, setOriginalContent] = useState<string>('');
  const [modifiedContent, setModifiedContent] = useState<string>('');
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);

  const loadOriginalContent = useCallback(async (): Promise<string> => {
    try {
      // Get file content from HEAD
      const content = await gitService.getFileContentAtHead(repoPath, filePath);
      return content;
    } catch {
      return '';
    }
  }, [repoPath, filePath]);

  const loadModifiedContent = useCallback(async (): Promise<string> => {
    try {
      // Read the current file content from working directory
      const content = await repositoryService.readFile(repoPath, filePath);
      return content || '';
    } catch {
      return '';
    }
  }, [repoPath, filePath]);

  const loadDiff = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Get file diff
      const diff = await gitService.getFileDiff(repoPath, filePath);
      setFileDiff(diff);

      // Get original content from HEAD
      const original = await loadOriginalContent();
      setOriginalContent(original);

      // Get modified content from working directory
      const modified = await loadModifiedContent();
      setModifiedContent(modified);

      setIsLoading(false);
    } catch (err) {
      logger.error('Failed to load diff:', err);
      setError(err instanceof Error ? err.message : 'Failed to load diff');
      setIsLoading(false);
    }
  }, [repoPath, filePath, loadOriginalContent, loadModifiedContent]);

  useEffect(() => {
    loadDiff();
  }, [loadDiff]);

  const handleEditorDidMount = (diffEditor: editor.IStandaloneDiffEditor, monaco: Monaco) => {
    editorRef.current = diffEditor;
    monacoRef.current = monaco;

    // Set theme
    const theme = resolvedTheme === 'light' ? 'vs' : 'vs-dark';
    monaco.editor.setTheme(theme);
  };

  // Get status icon and color
  const getStatusInfo = (status: GitFileStatus) => {
    switch (status) {
      case GitFileStatus.Added:
        return {
          icon: <Plus className="h-3.5 w-3.5" />,
          color: 'text-green-600 dark:text-green-400',
          label: 'Added',
        };
      case GitFileStatus.Deleted:
        return {
          icon: <Minus className="h-3.5 w-3.5" />,
          color: 'text-red-600 dark:text-red-400',
          label: 'Deleted',
        };
      case GitFileStatus.Modified:
        return {
          icon: <FileText className="h-3.5 w-3.5" />,
          color: 'text-yellow-600 dark:text-yellow-400',
          label: 'Modified',
        };
      case GitFileStatus.Renamed:
        return {
          icon: <FileText className="h-3.5 w-3.5" />,
          color: 'text-blue-600 dark:text-blue-400',
          label: 'Renamed',
        };
      case GitFileStatus.Untracked:
        return {
          icon: <FileText className="h-3.5 w-3.5" />,
          color: 'text-gray-500 dark:text-gray-400',
          label: 'Untracked',
        };
      default:
        return {
          icon: <FileText className="h-3.5 w-3.5" />,
          color: 'text-gray-500 dark:text-gray-400',
          label: 'Unknown',
        };
    }
  };

  const statusInfo = fileDiff ? getStatusInfo(fileDiff.status) : null;
  const fileName = repositoryService.getFileNameFromPath(filePath);
  const language = repositoryService.getLanguageFromExtension(fileName);

  // Determine if we should show diff editor or single editor
  const isAdded = fileDiff?.status === GitFileStatus.Added || fileStatus === GitFileStatus.Added;
  const isDeleted =
    fileDiff?.status === GitFileStatus.Deleted || fileStatus === GitFileStatus.Deleted;
  const isUntracked =
    fileDiff?.status === GitFileStatus.Untracked || fileStatus === GitFileStatus.Untracked;

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{filePath}</span>
          </div>
          {onClose && (
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{filePath}</span>
          </div>
          {onClose && (
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          {statusInfo && (
            <span className={statusInfo.color} title={statusInfo.label}>
              {statusInfo.icon}
            </span>
          )}
          <span className="text-sm font-medium">{filePath}</span>
          {fileDiff && (
            <span className="text-xs text-muted-foreground">
              <span className="text-green-600 dark:text-green-400">+{fileDiff.additions}</span>
              <span className="mx-1">/</span>
              <span className="text-red-600 dark:text-red-400">-{fileDiff.deletions}</span>
            </span>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Diff Editor or Single Editor */}
      <div className="flex-1">
        {isUntracked || isAdded ? (
          // Show single editor for new/untracked files
          <DiffEditor
            original="" // Empty original
            modified={modifiedContent}
            language={language}
            onMount={handleEditorDidMount}
            options={{
              renderSideBySide: true,
              readOnly: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 13,
              lineNumbers: 'on',
              renderLineHighlight: 'all',
              diffWordWrap: 'on',
              originalEditable: false,
            }}
            theme={resolvedTheme === 'light' ? 'vs' : 'vs-dark'}
          />
        ) : isDeleted ? (
          // Show single editor for deleted files (original content)
          <DiffEditor
            original={originalContent}
            modified="" // Empty modified
            language={language}
            onMount={handleEditorDidMount}
            options={{
              renderSideBySide: true,
              readOnly: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 13,
              lineNumbers: 'on',
              renderLineHighlight: 'all',
              diffWordWrap: 'on',
              originalEditable: false,
            }}
            theme={resolvedTheme === 'light' ? 'vs' : 'vs-dark'}
          />
        ) : (
          // Show diff editor for modified files
          <DiffEditor
            original={originalContent}
            modified={modifiedContent}
            language={language}
            onMount={handleEditorDidMount}
            options={{
              renderSideBySide: true,
              readOnly: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 13,
              lineNumbers: 'on',
              renderLineHighlight: 'all',
              diffWordWrap: 'on',
              originalEditable: false,
            }}
            theme={resolvedTheme === 'light' ? 'vs' : 'vs-dark'}
          />
        )}
      </div>
    </div>
  );
}
