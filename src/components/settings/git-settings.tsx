import { invoke } from '@tauri-apps/api/core';
import { CheckCircle, GitBranch, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useLocale } from '@/hooks/use-locale';
import { logger } from '@/lib/logger';
import { useSettingsStore } from '@/stores/settings-store';

export function GitSettings() {
  const { t } = useLocale();

  // Git settings from store
  const gitExecutablePath = useSettingsStore((state) => state.git_executable_path);
  const setGitExecutablePath = useSettingsStore((state) => state.setGitExecutablePath);
  const gitAutoFetchEnabled = useSettingsStore((state) => state.git_auto_fetch_enabled);
  const setGitAutoFetchEnabled = useSettingsStore((state) => state.setGitAutoFetchEnabled);
  const gitAutoRefreshInterval = useSettingsStore((state) => state.git_auto_refresh_interval);
  const setGitAutoRefreshInterval = useSettingsStore((state) => state.setGitAutoRefreshInterval);

  // Local state for input to avoid frequent store updates
  const [localGitPath, setLocalGitPath] = useState(gitExecutablePath);
  const [localRefreshInterval, setLocalRefreshInterval] = useState(gitAutoRefreshInterval);

  // Test state
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    version?: string;
  } | null>(null);

  // Check if path has changed
  const hasPathChanged = localGitPath !== gitExecutablePath;

  // Handle test git executable
  const handleTestGit = async (pathToTest: string): Promise<boolean> => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const version = await invoke<string>('test_git_executable', {
        gitPath: pathToTest || '',
      });
      setTestResult({
        success: true,
        message: (t.Settings.git?.testSuccess || 'Git is working: {version}').replace(
          '{version}',
          version
        ),
        version,
      });
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setTestResult({
        success: false,
        message: (t.Settings.git?.testFailed || 'Test failed: {error}').replace(
          '{error}',
          errorMsg
        ),
      });
      return false;
    } finally {
      setIsTesting(false);
    }
  };

  // Handle test button click
  const handleTestClick = () => {
    handleTestGit(localGitPath);
  };

  // Handle save git path - must validate first
  const handleSaveGitPath = async () => {
    if (!hasPathChanged) return;

    setIsSaving(true);
    try {
      // Must validate git before saving
      const isValid = await handleTestGit(localGitPath);
      if (!isValid) {
        logger.warn('[GitSettings] Git path validation failed, not saving');
        return;
      }

      await setGitExecutablePath(localGitPath);
      logger.info('[GitSettings] Git path saved:', localGitPath);
    } finally {
      setIsSaving(false);
    }
  };

  // Handle reset to default
  const handleResetGitPath = async () => {
    setLocalGitPath('');
    await setGitExecutablePath('');
    setTestResult(null);
    logger.info('[GitSettings] Git path reset to default');
  };

  // Handle refresh interval blur to commit changes
  const handleRefreshIntervalBlur = () => {
    if (localRefreshInterval !== gitAutoRefreshInterval) {
      setGitAutoRefreshInterval(localRefreshInterval);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            <CardTitle className="text-lg">{t.Settings.git?.title || 'Git Settings'}</CardTitle>
          </div>
          <CardDescription>
            {t.Settings.git?.description || 'Configure Git integration settings'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Git Executable Path */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">
              {t.Settings.git?.executablePath || 'Git Executable Path'}
            </Label>
            <div className="flex gap-2">
              <Input
                value={localGitPath}
                onChange={(e) => {
                  setLocalGitPath(e.target.value);
                  setTestResult(null);
                }}
                placeholder={
                  t.Settings.git?.executablePathPlaceholder ||
                  'Leave empty to use default git command'
                }
                className="font-mono text-sm flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestClick}
                disabled={isTesting || isSaving}
                className="shrink-0"
              >
                {isTesting || isSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    {t.Settings.git?.testing || 'Testing...'}
                  </>
                ) : (
                  t.Settings.git?.testGit || 'Test'
                )}
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={handleSaveGitPath}
                disabled={!hasPathChanged || isTesting || isSaving}
                className="shrink-0"
              >
                {t.Settings.git?.saveGitPath || 'Save'}
              </Button>
              {localGitPath && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleResetGitPath}
                  disabled={isTesting || isSaving}
                  className="shrink-0"
                >
                  {t.Common.reset || 'Reset'}
                </Button>
              )}
            </div>

            {/* Test result */}
            {testResult && (
              <div
                className={`flex items-center gap-2 text-sm p-2 rounded-md ${
                  testResult.success
                    ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                    : 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                }`}
              >
                {testResult.success ? (
                  <CheckCircle className="h-4 w-4" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                <span>{testResult.message}</span>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {t.Settings.git?.executablePathHint ||
                'Specify a custom Git executable path if your Git installation uses a non-standard name or location.'}
            </p>
          </div>

          {/* Auto Fetch */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium">
                {t.Settings.git?.autoFetch || 'Auto Fetch'}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t.Settings.git?.autoFetchHint ||
                  'Automatically fetch from remote when opening a repository'}
              </p>
            </div>
            <Switch
              checked={gitAutoFetchEnabled}
              onCheckedChange={(checked) => setGitAutoFetchEnabled(checked)}
            />
          </div>

          {/* Auto Refresh Interval */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              {t.Settings.git?.autoRefreshInterval || 'Auto Refresh Interval (seconds)'}
            </Label>
            <Input
              type="number"
              min="0"
              max="3600"
              value={localRefreshInterval}
              onChange={(e) => setLocalRefreshInterval(Number(e.target.value))}
              onBlur={handleRefreshIntervalBlur}
              className="w-32"
            />
            <p className="text-xs text-muted-foreground">
              {t.Settings.git?.autoRefreshIntervalHint ||
                'Set to 0 to disable auto-refresh. Recommended: 30-300 seconds.'}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
