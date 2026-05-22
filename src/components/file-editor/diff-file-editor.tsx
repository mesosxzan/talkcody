import { DiffEditor, type Monaco } from '@monaco-editor/react';
import { ArrowDown, ArrowUp, ChevronRight, FileText, Loader2, Minus, Plus, X } from 'lucide-react';
import type { editor } from 'monaco-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/use-theme';
import { repositoryService } from '@/services/repository-service';
import type { OpenFile } from '@/types/file-system';
import { GitFileStatus } from '@/types/git';

interface DiffFileEditorProps {
  file: OpenFile;
  onSave?: () => void;
  onClose?: () => void;
}

export function DiffFileEditor({ file, onClose }: DiffFileEditorProps) {
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const [currentChangeIndex, setCurrentChangeIndex] = useState(0);
  const [totalChanges, setTotalChanges] = useState(0);
  const lineChangesRef = useRef<editor.ILineChange[] | null>(null);

  // Calculate total changes from diff info as fallback
  useEffect(() => {
    if (file.diffInfo) {
      const additions = file.diffInfo.additions ?? 0;
      const deletions = file.diffInfo.deletions ?? 0;
      // Use lineChanges count if available, otherwise use additions + deletions
      if (!lineChangesRef.current) {
        setTotalChanges(additions + deletions);
      }
    }
  }, [file.diffInfo]);

  const handleEditorDidMount = useCallback(
    (diffEditor: editor.IStandaloneDiffEditor, monaco: Monaco) => {
      editorRef.current = diffEditor;
      monacoRef.current = monaco;

      // Set theme
      const theme = resolvedTheme === 'light' ? 'vs' : 'vs-dark';
      monaco.editor.setTheme(theme);

      // Wait for diff computation to complete, then get line changes
      const updateLineChanges = () => {
        const lineChanges = diffEditor.getLineChanges();
        if (lineChanges && lineChanges.length > 0) {
          lineChangesRef.current = lineChanges;
          setTotalChanges(lineChanges.length);
          // Navigate to first diff
          diffEditor.revealFirstDiff?.();
        }
      };

      // Try to get line changes immediately
      updateLineChanges();

      // Also listen for diff updates (diff is computed asynchronously)
      const disposable = diffEditor.onDidUpdateDiff(() => {
        updateLineChanges();
      });

      // Cleanup on unmount
      return () => {
        disposable.dispose();
      };
    },
    [resolvedTheme]
  );

  // Navigate to next/previous diff using Monaco's built-in goToDiff method
  const navigateToNextChange = useCallback(() => {
    if (!editorRef.current) return;

    const diffEditor = editorRef.current;
    const lineChanges = lineChangesRef.current;

    // Use Monaco's built-in goToDiff method
    diffEditor.goToDiff('next');

    // Update change index based on current position
    if (lineChanges && lineChanges.length > 0) {
      setCurrentChangeIndex((prev) => (prev < lineChanges.length - 1 ? prev + 1 : 0));
    }
  }, []);

  const navigateToPreviousChange = useCallback(() => {
    if (!editorRef.current) return;

    const diffEditor = editorRef.current;
    const lineChanges = lineChangesRef.current;

    // Use Monaco's built-in goToDiff method
    diffEditor.goToDiff('previous');

    // Update change index based on current position
    if (lineChanges && lineChanges.length > 0) {
      setCurrentChangeIndex((prev) => (prev > 0 ? prev - 1 : lineChanges.length - 1));
    }
  }, []);

  // Keyboard shortcuts for navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault();
          navigateToNextChange();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault();
          navigateToPreviousChange();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigateToNextChange, navigateToPreviousChange]);

  // Get status icon and color
  const getStatusInfo = (status: string) => {
    switch (status) {
      case 'added':
        return {
          icon: <Plus className="h-3.5 w-3.5" />,
          color: 'text-green-600 dark:text-green-400',
          label: 'Added',
        };
      case 'deleted':
        return {
          icon: <Minus className="h-3.5 w-3.5" />,
          color: 'text-red-600 dark:text-red-400',
          label: 'Deleted',
        };
      case 'modified':
        return {
          icon: <FileText className="h-3.5 w-3.5" />,
          color: 'text-yellow-600 dark:text-yellow-400',
          label: 'Modified',
        };
      case 'renamed':
        return {
          icon: <ChevronRight className="h-3.5 w-3.5" />,
          color: 'text-blue-600 dark:text-blue-400',
          label: 'Renamed',
        };
      default:
        return {
          icon: <FileText className="h-3.5 w-3.5" />,
          color: 'text-gray-500 dark:text-gray-400',
          label: 'Unknown',
        };
    }
  };

  const statusInfo = file.diffInfo ? getStatusInfo(file.diffInfo.status) : null;
  const fileName = repositoryService.getFileNameFromPath(file.path);
  const language = repositoryService.getLanguageFromExtension(fileName);

  if (file.isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{file.path}</span>
          </div>
          {onClose && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (file.error) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{file.path}</span>
          </div>
          {onClose && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-sm text-destructive">{file.error}</p>
        </div>
      </div>
    );
  }

  // Ensure we have valid content strings (never null)
  const originalContent = file.originalContent ?? '';
  const modifiedContent = file.content ?? '';

  const isAdded =
    file.diffInfo?.status === 'added' || file.diffInfo?.status === GitFileStatus.Added;
  const isDeleted =
    file.diffInfo?.status === 'deleted' || file.diffInfo?.status === GitFileStatus.Deleted;

  return (
    <div className="flex h-full flex-col">
      {/* Header with navigation */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          {statusInfo && (
            <span className={statusInfo.color} title={statusInfo.label}>
              {statusInfo.icon}
            </span>
          )}
          <span className="text-sm font-medium">{file.path}</span>
          {file.diffInfo && (
            <span className="text-xs text-muted-foreground">
              <span className="text-green-600 dark:text-green-400">+{file.diffInfo.additions}</span>
              <span className="mx-1">/</span>
              <span className="text-red-600 dark:text-red-400">-{file.diffInfo.deletions}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Change navigation */}
          {totalChanges > 0 && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => navigateToPreviousChange()}
                title="Previous change (Alt+Up)"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs text-muted-foreground px-1">
                {currentChangeIndex + 1}/{totalChanges}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => navigateToNextChange()}
                title="Next change (Alt+Down)"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}

          {onClose && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Diff Editor */}
      <div className="flex-1 min-h-0">
        {isAdded ? (
          <DiffEditor
            original=""
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
          <DiffEditor
            original={originalContent}
            modified=""
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
