/**
 * Import Agents Dialog
 */

import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { AlertCircle, CheckCircle2, Download, FileText, FolderOpen, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/hooks/use-locale';
import { logger } from '@/lib/logger';
import {
  importAgentFromGitHub,
  importAgentFromLocalFile,
  importAgentsFromLocalDirectory,
  registerImportedAgents,
} from '@/services/agents/github-import-agent-service';

interface ImportDialogCopy {
  title: string;
  description: string;
  urlLabel: string;
  urlPlaceholder: string;
  urlHint: string;
  urlRequired: string;
  scanning: string;
  invalidUrl: string;
  networkError: string;
  imported: string;
  failed: string;
  import: string;
  close: string;
  chooseFolder?: string;
  chooseFile?: string;
  selectFile?: string;
  selectFolder?: string;
  noSelection?: string;
  selectedPath?: string;
}

interface ImportGitHubAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportComplete?: () => void;
  mode?: 'github' | 'local';
}

type DialogStep = 'input' | 'importing' | 'result';

export function ImportGitHubAgentDialog({
  open,
  onOpenChange,
  onImportComplete,
  mode = 'github',
}: ImportGitHubAgentDialogProps) {
  const t = useTranslation();
  const isLocalMode = mode === 'local';
  const importCopy: ImportDialogCopy = isLocalMode ? t.Agents.localImport : t.Agents.githubImport;

  const [step, setStep] = useState<DialogStep>('input');
  const [githubUrl, setGithubUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [isFileMode, setIsFileMode] = useState<boolean | null>(null);
  const [importResult, setImportResult] = useState<{
    succeeded: string[];
    failed: Array<{ name: string; error: string }>;
  } | null>(null);

  useEffect(() => {
    if (open) {
      setStep('input');
      setGithubUrl('');
      setError(null);
      setImportResult(null);
      setSelectedPath(null);
      setIsFileMode(null);
    }
  }, [open]);

  const parseGitHubUrl = useCallback(
    (url: string): { repository: string; path: string; branch?: string } | null => {
      try {
        const parsed = new URL(url);
        if (parsed.hostname !== 'github.com') {
          return null;
        }

        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length < 2) {
          return null;
        }

        const owner = parts[0];
        const repo = parts[1];
        const repository = `${owner}/${repo}`;

        if (parts[2] === 'tree' && parts.length > 3) {
          const branch = parts[3];
          const path = parts.slice(4).join('/');
          return { repository, path, branch };
        }

        if (parts[2] === 'blob' && parts.length > 3) {
          const branch = parts[3];
          const path = parts.slice(4).join('/');
          return { repository, path, branch };
        }

        return { repository, path: '' };
      } catch (parseError) {
        logger.warn('Failed to parse GitHub URL:', parseError);
        return null;
      }
    },
    []
  );

  const finishImport = useCallback(
    async (
      agentConfigs: Awaited<ReturnType<typeof importAgentFromGitHub>>,
      fallbackId?: string
    ) => {
      const result = await registerImportedAgents(agentConfigs, fallbackId);

      if (result.succeeded.length === 0 && result.failed.length === 0) {
        throw new Error('No valid agents found');
      }

      setImportResult(result);
      setStep('result');

      const { useAgentStore } = await import('@/stores/agent-store');
      await useAgentStore.getState().refreshAgents();
      onImportComplete?.();
    },
    [onImportComplete]
  );

  const handleSelectFile = useCallback(async () => {
    const selected = await openDialog({
      directory: false,
      multiple: false,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      title: importCopy.chooseFile,
    });

    if (selected && typeof selected === 'string') {
      setSelectedPath(selected);
      setIsFileMode(true);
      setError(null);
    }
  }, [importCopy.chooseFile]);

  const handleSelectFolder = useCallback(async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: importCopy.chooseFolder,
    });

    if (selected && typeof selected === 'string') {
      setSelectedPath(selected);
      setIsFileMode(false);
      setError(null);
    }
  }, [importCopy.chooseFolder]);

  const handleImport = useCallback(async () => {
    if (isLocalMode) {
      if (!selectedPath) {
        setError(importCopy.noSelection || 'Please select a file or folder');
        return;
      }

      setError(null);
      setStep('importing');

      try {
        if (isFileMode) {
          const agentConfig = await importAgentFromLocalFile(selectedPath);
          await finishImport([agentConfig], 'local-agent');
        } else {
          const agentConfigs = await importAgentsFromLocalDirectory(selectedPath);
          await finishImport(agentConfigs, 'local-agent');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : importCopy.networkError;
        logger.error('Import local agent failed:', err);
        setImportResult({
          succeeded: [],
          failed: [{ name: selectedPath, error: message }],
        });
        setStep('result');
      }
    } else {
      // GitHub mode
      if (!githubUrl.trim()) {
        setError(importCopy.urlRequired);
        return;
      }

      setError(null);
      setStep('importing');

      try {
        const parsed = parseGitHubUrl(githubUrl);
        if (!parsed) {
          setError(importCopy.invalidUrl);
          setStep('input');
          return;
        }

        const agentId = parsed.path.split('/').filter(Boolean).pop() || 'remote-agent';
        const agentConfigs = await importAgentFromGitHub({
          repository: parsed.repository,
          path: parsed.path,
          agentId,
          branch: parsed.branch,
        });

        await finishImport(agentConfigs, agentId);
      } catch (err) {
        const message = err instanceof Error ? err.message : importCopy.networkError;
        logger.error('Import agent failed:', err);
        setImportResult({
          succeeded: [],
          failed: [{ name: githubUrl, error: message }],
        });
        setStep('result');
      }
    }
  }, [isLocalMode, selectedPath, isFileMode, githubUrl, importCopy, parseGitHubUrl, finishImport]);

  const handleClose = () => {
    onOpenChange(false);
  };

  const handleTryAgain = () => {
    setStep('input');
    setGithubUrl('');
    setError(null);
    setImportResult(null);
    setSelectedPath(null);
    setIsFileMode(null);
  };

  const renderLocalModeContent = () => {
    switch (step) {
      case 'input':
        return (
          <div className="space-y-4">
            <div className="space-y-3">
              <Button
                type="button"
                variant={isFileMode === true ? 'default' : 'outline'}
                className="w-full justify-start"
                onClick={() => void handleSelectFile()}
              >
                <FileText className="h-4 w-4 mr-3" />
                {importCopy.selectFile || '选择文件'}
              </Button>

              <Button
                type="button"
                variant={isFileMode === false ? 'default' : 'outline'}
                className="w-full justify-start"
                onClick={() => void handleSelectFolder()}
              >
                <FolderOpen className="h-4 w-4 mr-3" />
                {importCopy.selectFolder || '选择文件夹'}
              </Button>
            </div>

            {selectedPath && (
              <div className="p-3 bg-muted/50 rounded-md">
                <p className="text-xs text-muted-foreground mb-1">
                  {importCopy.selectedPath || '已选择'}
                </p>
                <p className="text-sm font-medium truncate" title={selectedPath}>
                  {selectedPath}
                </p>
              </div>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        );

      case 'importing':
        return (
          <div className="flex flex-col items-center justify-center py-12 space-y-4">
            <Loader2 className="h-12 w-12 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{importCopy.scanning}</p>
          </div>
        );

      case 'result':
        return (
          <div className="space-y-4">
            {importResult?.succeeded.length ? (
              <Alert>
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <AlertDescription>
                  {importResult.succeeded.length} {importCopy.imported}
                </AlertDescription>
              </Alert>
            ) : null}

            {importResult?.failed.length ? (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {importResult.failed.length} {importCopy.failed}
                </AlertDescription>
              </Alert>
            ) : null}

            {importResult?.failed.length ? (
              <div className="space-y-2">
                {importResult.failed.map((item) => (
                  <div key={item.name} className="text-xs text-muted-foreground">
                    {item.name}: {item.error}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );

      default:
        return null;
    }
  };

  const renderGitHubModeContent = () => {
    switch (step) {
      case 'input':
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="github-url">{importCopy.urlLabel}</Label>
              <Input
                id="github-url"
                placeholder={importCopy.urlPlaceholder}
                value={githubUrl}
                onChange={(e) => setGithubUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void handleImport();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">{importCopy.urlHint}</p>
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        );

      case 'importing':
        return (
          <div className="flex flex-col items-center justify-center py-12 space-y-4">
            <Loader2 className="h-12 w-12 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{importCopy.scanning}</p>
          </div>
        );

      case 'result':
        return (
          <div className="space-y-4">
            {importResult?.succeeded.length ? (
              <Alert>
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <AlertDescription>
                  {importResult.succeeded.length} {importCopy.imported}
                </AlertDescription>
              </Alert>
            ) : null}

            {importResult?.failed.length ? (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {importResult.failed.length} {importCopy.failed}
                </AlertDescription>
              </Alert>
            ) : null}

            {importResult?.failed.length ? (
              <div className="space-y-2">
                {importResult.failed.map((item) => (
                  <div key={item.name} className="text-xs text-muted-foreground">
                    {item.name}: {item.error}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );

      default:
        return null;
    }
  };

  const canImport = isLocalMode ? selectedPath !== null : githubUrl.trim() !== '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{importCopy.title}</DialogTitle>
        </DialogHeader>

        {isLocalMode ? renderLocalModeContent() : renderGitHubModeContent()}

        <div className="flex justify-center gap-3 mt-4">
          {step === 'result' && (
            <Button variant="outline" onClick={handleTryAgain} className="min-w-[100px]">
              {t.Common.retry}
            </Button>
          )}

          {step === 'input' && (
            <Button
              onClick={() => void handleImport()}
              disabled={!canImport}
              className="min-w-[100px]"
            >
              <Download className="h-4 w-4 mr-2" />
              {importCopy.import}
            </Button>
          )}

          <Button variant="outline" onClick={handleClose} className="min-w-[100px]">
            {importCopy.close}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
