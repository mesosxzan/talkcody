import { GitBranch } from 'lucide-react';
import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useLocale } from '@/hooks/use-locale';
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

  // Handle git path blur to commit changes
  const handleGitPathBlur = () => {
    if (localGitPath !== gitExecutablePath) {
      setGitExecutablePath(localGitPath);
    }
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
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              {t.Settings.git?.executablePath || 'Git Executable Path'}
            </Label>
            <Input
              value={localGitPath}
              onChange={(e) => setLocalGitPath(e.target.value)}
              onBlur={handleGitPathBlur}
              placeholder={
                t.Settings.git?.executablePathPlaceholder ||
                'Leave empty to use default git command'
              }
              className="font-mono text-sm"
            />
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
