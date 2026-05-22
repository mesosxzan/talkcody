import { DiffEditor, type Monaco } from '@monaco-editor/react';
import { Loader2 } from 'lucide-react';
import type { editor } from 'monaco-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from '@/hooks/use-theme';
import { logger } from '@/lib/logger';
import { gitService } from '@/services/git-service';
import { repositoryService } from '@/services/repository-service';
import type { FileDiff } from '@/types/git';

interface GitDiffViewProps {
  repoPath: string;
  filePath: string;
  onClose?: () => void;
}

export function GitDiffView({ repoPath, filePath, onClose }: GitDiffViewProps) {
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
      // Use git show to get the file content from HEAD
      // For now, return empty string for original content
      // This will be improved later to actually fetch HEAD content
      return '';
    } catch {
      return '';
    }
  }, []);

  const loadModifiedContent = useCallback(async (): Promise<string> => {
    try {
      // Read the current file content
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

  const handleEditorDidMount = (editor: editor.IStandaloneDiffEditor, monaco: Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Set theme
    const theme = resolvedTheme === 'light' ? 'vs' : 'vs-dark';
    monaco.editor.setTheme(theme);
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  const fileName = repositoryService.getFileNameFromPath(filePath);
  const language = repositoryService.getLanguageFromExtension(fileName);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{filePath}</span>
          {fileDiff && (
            <span className="text-xs text-muted-foreground">
              +{fileDiff.additions} -{fileDiff.deletions}
            </span>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            Close
          </button>
        )}
      </div>

      {/* Diff Editor */}
      <div className="flex-1">
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
          }}
          theme={resolvedTheme === 'light' ? 'vs' : 'vs-dark'}
        />
      </div>
    </div>
  );
}
