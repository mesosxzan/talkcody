import { CheckCircle, GitBranch, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useLocale } from '@/hooks/use-locale';
import { logger } from '@/lib/logger';
import { parseProxyUrl } from '@/lib/proxy-detector';
import { tauriInvoke } from '@/lib/runtime-env';
import { type GitProxySettings, settingsManager, useSettingsStore } from '@/stores/settings-store';

/**
 * Parsed proxy fields for separate input
 */
interface ProxyFields {
  protocol: 'http' | 'socks5' | 'socks5h';
  host: string;
  port: string;
  username: string;
  password: string;
}

/**
 * Convert proxy URL string to fields
 */
function urlToFields(url: string): ProxyFields {
  const parsed = parseProxyUrl(url);
  if (parsed) {
    return {
      protocol: parsed.protocol,
      host: parsed.host,
      port: parsed.port.toString(),
      username: parsed.username || '',
      password: parsed.password || '',
    };
  }
  return { protocol: 'http', host: '', port: '', username: '', password: '' };
}

/**
 * Convert fields to proxy URL string
 */
function fieldsToUrl(fields: ProxyFields): string {
  if (!fields.host || !fields.port) {
    return '';
  }

  const port = parseInt(fields.port, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    return '';
  }

  if (fields.username && fields.password) {
    return `${fields.protocol}://${encodeURIComponent(fields.username)}:${encodeURIComponent(fields.password)}@${fields.host}:${port}`;
  }

  return `${fields.protocol}://${fields.host}:${port}`;
}

export function GitSettings() {
  const { t } = useLocale();

  // Git settings from store
  const gitExecutablePath = useSettingsStore((state) => state.git_executable_path);
  const setGitExecutablePath = useSettingsStore((state) => state.setGitExecutablePath);
  const gitAutoFetchEnabled = useSettingsStore((state) => state.git_auto_fetch_enabled);
  const setGitAutoFetchEnabled = useSettingsStore((state) => state.setGitAutoFetchEnabled);
  const gitAutoRefreshInterval = useSettingsStore((state) => state.git_auto_refresh_interval);
  const setGitAutoRefreshInterval = useSettingsStore((state) => state.setGitAutoRefreshInterval);

  // Git proxy settings - subscribe to store values to sync local state on mount
  const gitProxyEnabled = useSettingsStore((state) => state.git_proxy_enabled);
  const gitProxyUseGlobal = useSettingsStore((state) => state.git_proxy_use_global);
  const gitProxyUrl = useSettingsStore((state) => state.git_proxy_url);

  // Local state for input to avoid frequent store updates
  const [localGitPath, setLocalGitPath] = useState(gitExecutablePath);
  const [localRefreshInterval, setLocalRefreshInterval] = useState(gitAutoRefreshInterval);

  // Git proxy local state
  const [localGitProxyEnabled, setLocalGitProxyEnabled] = useState(gitProxyEnabled);
  const [localGitProxyUseGlobal, setLocalGitProxyUseGlobal] = useState(gitProxyUseGlobal);
  const [gitProxyFields, setGitProxyFields] = useState<ProxyFields>(urlToFields(gitProxyUrl));

  // Test state
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingProxy, setIsSavingProxy] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    version?: string;
  } | null>(null);
  const [proxyValidationError, setProxyValidationError] = useState<string | null>(null);

  // Check if path has changed
  const hasPathChanged = localGitPath !== gitExecutablePath;

  // Handle test git executable
  const handleTestGit = async (pathToTest: string): Promise<boolean> => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const version = await tauriInvoke<string>('test_git_executable', {
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

  /**
   * Validate proxy fields
   */
  function validateFields(fields: ProxyFields): { valid: boolean; error?: string } {
    if (!fields.host) {
      return {
        valid: false,
        error: t.Proxy.errors.hostRequired || 'Please enter the proxy server address',
      };
    }

    if (!fields.port) {
      return {
        valid: false,
        error: t.Proxy.errors.portRequired || 'Please enter the port number',
      };
    }

    const port = parseInt(fields.port, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      return {
        valid: false,
        error: t.Proxy.errors.portInvalid || 'Port number must be between 1 and 65535',
      };
    }

    return { valid: true };
  }

  /**
   * Update a single field in git proxy settings
   */
  function updateGitProxyField<K extends keyof ProxyFields>(key: K, value: ProxyFields[K]) {
    setGitProxyFields((prev) => ({ ...prev, [key]: value }));
  }

  /**
   * Save git proxy settings
   */
  async function handleSaveGitProxy() {
    if (localGitProxyEnabled && !localGitProxyUseGlobal) {
      const validation = validateFields(gitProxyFields);
      if (!validation.valid) {
        setProxyValidationError(validation.error || 'Invalid proxy settings');
        toast.error(validation.error || 'Invalid proxy settings');
        return;
      }
    }

    setProxyValidationError(null);
    setIsSavingProxy(true);
    try {
      const url = fieldsToUrl(gitProxyFields);
      const settings: GitProxySettings = {
        enabled: localGitProxyEnabled,
        useGlobalProxy: localGitProxyUseGlobal,
        url,
        type: gitProxyFields.protocol,
      };
      await settingsManager.setGitProxySettings(settings);
      toast.success(t.Common.saved || 'Settings saved');
    } catch (error) {
      logger.error('[GitSettings] Failed to save git proxy settings:', error);
      toast.error('Failed to save settings');
    } finally {
      setIsSavingProxy(false);
    }
  }

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

      {/* Git Proxy Settings Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            <CardTitle className="text-lg">{t.Proxy?.git?.title || 'Git Proxy'}</CardTitle>
          </div>
          <CardDescription>
            {t.Proxy?.git?.description ||
              'Configure proxy specifically for Git operations (fetch, push, pull, etc.). Other operations are not affected.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Enable Git Proxy */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="git-proxy-enabled">
                {t.Proxy?.git?.enable || 'Enable Git Proxy'}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t.Proxy?.git?.enableDesc ||
                  'Use proxy only for Git operations, other network requests are not affected'}
              </p>
            </div>
            <Switch
              id="git-proxy-enabled"
              checked={localGitProxyEnabled}
              onCheckedChange={setLocalGitProxyEnabled}
            />
          </div>

          {/* Use Global Proxy */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="git-proxy-use-global">
                {t.Proxy?.git?.useGlobal || 'Use Global Proxy Settings'}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t.Proxy?.git?.useGlobalDesc || 'Inherit proxy settings from global configuration'}
              </p>
            </div>
            <Switch
              id="git-proxy-use-global"
              checked={localGitProxyUseGlobal}
              onCheckedChange={setLocalGitProxyUseGlobal}
            />
          </div>

          {/* Custom Git Proxy Configuration - show when enabled and not using global */}
          {localGitProxyEnabled && !localGitProxyUseGlobal && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                {/* Protocol */}
                <div className="space-y-2">
                  <Label htmlFor="git-proxy-protocol">
                    {t.Proxy?.global?.protocol || 'Protocol'}
                  </Label>
                  <Select
                    value={gitProxyFields.protocol}
                    onValueChange={(v) =>
                      updateGitProxyField('protocol', v as ProxyFields['protocol'])
                    }
                  >
                    <SelectTrigger id="git-proxy-protocol">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="http">{t.Proxy?.types?.http || 'HTTP'}</SelectItem>
                      <SelectItem value="socks5">{t.Proxy?.types?.socks5 || 'SOCKS5'}</SelectItem>
                      <SelectItem value="socks5h">
                        {t.Proxy?.types?.socks5h || 'SOCKS5H (DNS through proxy)'}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Host */}
                <div className="space-y-2">
                  <Label htmlFor="git-proxy-host">
                    {t.Proxy?.global?.host || 'Server Address'}
                  </Label>
                  <Input
                    id="git-proxy-host"
                    value={gitProxyFields.host}
                    onChange={(e) => updateGitProxyField('host', e.target.value)}
                    placeholder="127.0.0.1 or proxy.example.com"
                  />
                </div>

                {/* Port */}
                <div className="space-y-2">
                  <Label htmlFor="git-proxy-port">{t.Proxy?.global?.port || 'Port'}</Label>
                  <Input
                    id="git-proxy-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={gitProxyFields.port}
                    onChange={(e) => updateGitProxyField('port', e.target.value)}
                    placeholder="7890"
                  />
                </div>
              </div>

              {/* Authentication (optional) */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="git-proxy-username">
                    {t.Proxy?.global?.username || 'Username'}
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({t.Proxy?.git?.optional || 'Optional'})
                    </span>
                  </Label>
                  <Input
                    id="git-proxy-username"
                    value={gitProxyFields.username}
                    onChange={(e) => updateGitProxyField('username', e.target.value)}
                    placeholder={
                      t.Proxy?.global?.usernamePlaceholder || 'Proxy authentication username'
                    }
                    autoComplete="off"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="git-proxy-password">
                    {t.Proxy?.global?.password || 'Password'}
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({t.Proxy?.git?.optional || 'Optional'})
                    </span>
                  </Label>
                  <Input
                    id="git-proxy-password"
                    type="password"
                    value={gitProxyFields.password}
                    onChange={(e) => updateGitProxyField('password', e.target.value)}
                    placeholder={
                      t.Proxy?.global?.passwordPlaceholder || 'Proxy authentication password'
                    }
                    autoComplete="off"
                  />
                </div>
              </div>

              {/* Show constructed URL preview */}
              {gitProxyFields.host && gitProxyFields.port && (
                <div className="rounded-md bg-muted p-2 text-sm">
                  <span className="text-muted-foreground">
                    {t.Proxy?.global?.preview || 'Preview'}:{' '}
                  </span>
                  <code className="text-xs">
                    {fieldsToUrl(gitProxyFields).replace(/:(.*?)@/, ':***@')}
                  </code>
                </div>
              )}

              {gitProxyFields.protocol === 'socks5h' && (
                <p className="text-sm text-muted-foreground">
                  {t.Proxy?.hints?.socks5h ||
                    'Recommended for privacy - DNS resolution through proxy'}
                </p>
              )}

              <p className="text-sm text-muted-foreground">
                💡{' '}
                {t.Proxy?.hints?.gitProxySeparate ||
                  'This proxy is only used for Git operations, other network requests will not go through this proxy'}
              </p>
            </div>
          )}

          {localGitProxyEnabled && localGitProxyUseGlobal && (
            <p className="text-sm text-muted-foreground">
              💡{' '}
              {t.Proxy?.hints?.gitProxyUseGlobalHint ||
                'Using global proxy settings for Git operations'}
            </p>
          )}

          {!localGitProxyEnabled && (
            <p className="text-sm text-muted-foreground">
              💡{' '}
              {t.Proxy?.hints?.gitProxyDisabled ||
                'Git operations will not use any proxy. Enable to configure a proxy for Git only.'}
            </p>
          )}

          {proxyValidationError && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <XCircle className="h-4 w-4" />
              {proxyValidationError}
            </div>
          )}

          <Button onClick={handleSaveGitProxy} disabled={isSavingProxy}>
            {isSavingProxy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t.Common.save}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
