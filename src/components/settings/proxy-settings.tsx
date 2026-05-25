import { Check, Globe, RefreshCw, Save, Search, Server, TestTube } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
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
import {
  detectLocalProxy,
  detectProxyFromEnv,
  getSystemProxyEnv,
  testProxyConnection,
  validateProxyUrl,
} from '@/lib/proxy-detector';
import {
  type ProxySettings as ProxySettingsType,
  settingsManager,
  type WebSearchProxySettings as WebSearchProxySettingsType,
} from '@/stores/settings-store';

export function ProxySettings() {
  const { t } = useLocale();

  // Global proxy settings
  const [globalEnabled, setGlobalEnabled] = useState(false);
  const [globalUrl, setGlobalUrl] = useState('');
  const [globalType, setGlobalType] = useState('http');
  const [globalAutoDetect, setGlobalAutoDetect] = useState(true);
  const [globalNoProxy, setGlobalNoProxy] = useState('');

  // Web search proxy settings
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [webSearchUseGlobal, setWebSearchUseGlobal] = useState(true);
  const [webSearchUrl, setWebSearchUrl] = useState('');
  const [webSearchType, setWebSearchType] = useState('http');

  // Detection status
  const [detectedProxy, setDetectedProxy] = useState<string | null>(null);
  const [envProxy, setEnvProxy] = useState<string | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; latency?: number } | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [isSavingGlobal, setIsSavingGlobal] = useState(false);
  const [isSavingWebSearch, setIsSavingWebSearch] = useState(false);

  const loadSettings = useCallback(() => {
    const proxySettings = settingsManager.getProxySettings();
    setGlobalEnabled(proxySettings.enabled);
    setGlobalUrl(proxySettings.url);
    setGlobalType(proxySettings.type || 'http');
    setGlobalAutoDetect(proxySettings.autoDetect);
    setGlobalNoProxy(proxySettings.noProxy);

    const webSearchSettings = settingsManager.getWebSearchProxySettings();
    setWebSearchEnabled(webSearchSettings.enabled);
    setWebSearchUseGlobal(webSearchSettings.useGlobalProxy);
    setWebSearchUrl(webSearchSettings.url);
    setWebSearchType(webSearchSettings.type || 'http');
  }, []);

  const detectProxies = useCallback(async () => {
    setIsDetecting(true);
    try {
      // Check environment proxy
      const env = await getSystemProxyEnv();
      const envConfig = detectProxyFromEnv(env);
      if (envConfig?.url) {
        setEnvProxy(envConfig.url);
      }

      // Check local proxy
      const localConfig = await detectLocalProxy();
      if (localConfig?.url) {
        setDetectedProxy(localConfig.url);
      }
    } catch (error) {
      logger.error('[ProxySettings] Failed to detect proxies:', error);
    } finally {
      setIsDetecting(false);
    }
  }, []);

  // Load settings on mount
  useEffect(() => {
    void loadSettings();
    void detectProxies();
  }, [loadSettings, detectProxies]);

  async function handleSaveGlobal() {
    if (globalEnabled && globalUrl) {
      const validation = validateProxyUrl(globalUrl);
      if (!validation.valid) {
        setUrlError(validation.error || 'Invalid proxy URL');
        toast.error(validation.error || 'Invalid proxy URL');
        return;
      }
    }

    setUrlError(null);
    setIsSavingGlobal(true);
    try {
      const settings: ProxySettingsType = {
        enabled: globalEnabled,
        url: globalUrl,
        type: globalType,
        autoDetect: globalAutoDetect,
        noProxy: globalNoProxy,
      };
      await settingsManager.setProxySettings(settings);
      toast.success(t.Common.saved || 'Settings saved');
    } catch (error) {
      logger.error('[ProxySettings] Failed to save global settings:', error);
      toast.error('Failed to save settings');
    } finally {
      setIsSavingGlobal(false);
    }
  }

  async function handleSaveWebSearch() {
    if (webSearchEnabled && !webSearchUseGlobal && webSearchUrl) {
      const validation = validateProxyUrl(webSearchUrl);
      if (!validation.valid) {
        setUrlError(validation.error || 'Invalid proxy URL');
        toast.error(validation.error || 'Invalid proxy URL');
        return;
      }
    }

    setUrlError(null);
    setIsSavingWebSearch(true);
    try {
      const settings: WebSearchProxySettingsType = {
        enabled: webSearchEnabled,
        useGlobalProxy: webSearchUseGlobal,
        url: webSearchUrl,
        type: webSearchType,
      };
      await settingsManager.setWebSearchProxySettings(settings);
      toast.success(t.Common.saved || 'Settings saved');
    } catch (error) {
      logger.error('[ProxySettings] Failed to save web search settings:', error);
      toast.error('Failed to save settings');
    } finally {
      setIsSavingWebSearch(false);
    }
  }

  async function handleTestConnection() {
    // Determine which proxy URL to test
    let urlToTest: string | null = null;

    if (webSearchEnabled && !webSearchUseGlobal && webSearchUrl) {
      // Use web search specific proxy
      urlToTest = webSearchUrl;
    } else if (globalUrl) {
      // Use global manual proxy
      urlToTest = globalUrl;
    } else if (envProxy) {
      // Use environment proxy
      urlToTest = envProxy;
    } else if (detectedProxy) {
      // Use auto-detected proxy
      urlToTest = detectedProxy;
    }

    if (!urlToTest) {
      toast.warning('No proxy configured to test');
      return;
    }

    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await testProxyConnection(urlToTest);
      setTestResult(result);
      if (result.success) {
        toast.success(`${t.Proxy.global.testSuccess} (${result.latency}ms)`);
      } else {
        toast.error(t.Proxy.global.testFailed);
      }
    } catch (error) {
      logger.error('[ProxySettings] Test connection error:', error);
      setTestResult({ success: false });
      toast.error(t.Proxy.global.testFailed);
    } finally {
      setIsTesting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Proxy Status */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            <CardTitle className="text-lg">{t.Proxy.global.status}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            {envProxy && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Check className="h-4 w-4 text-green-500" />
                <span>
                  {t.Proxy.global.fromEnv}: {envProxy}
                </span>
              </div>
            )}
            {detectedProxy && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Check className="h-4 w-4 text-green-500" />
                <span>
                  {t.Proxy.global.detected}: {detectedProxy}
                </span>
              </div>
            )}
            {!envProxy && !detectedProxy && (
              <div className="text-muted-foreground">{t.Proxy.global.none}</div>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={detectProxies}
            disabled={isDetecting}
          >
            {isDetecting ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {t.Common.retry}
          </Button>
        </CardContent>
      </Card>

      {/* Global Proxy Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            <CardTitle className="text-lg">{t.Proxy.global.title}</CardTitle>
          </div>
          <CardDescription>{t.Proxy.global.enableDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Enable Global Proxy */}
          <div className="flex items-center justify-between">
            <Label htmlFor="global-enabled">{t.Proxy.global.enable}</Label>
            <Switch
              id="global-enabled"
              checked={globalEnabled}
              onCheckedChange={setGlobalEnabled}
            />
          </div>

          {/* Auto-detect */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="auto-detect">{t.Proxy.global.autoDetect}</Label>
              <p className="text-sm text-muted-foreground">{t.Proxy.global.autoDetectDesc}</p>
            </div>
            <Switch
              id="auto-detect"
              checked={globalAutoDetect}
              onCheckedChange={setGlobalAutoDetect}
            />
          </div>

          {/* Manual URL - show when enabled, regardless of auto-detect */}
          {globalEnabled && (
            <>
              <div className="space-y-2">
                <Label htmlFor="global-url">{t.Proxy.global.url}</Label>
                <Input
                  id="global-url"
                  value={globalUrl}
                  onChange={(e) => setGlobalUrl(e.target.value)}
                  placeholder={t.Proxy.global.urlPlaceholder}
                />
                {urlError && <p className="text-sm text-destructive">{urlError}</p>}
              </div>

              <div className="space-y-2">
                <Label htmlFor="global-type">{t.Proxy.global.type}</Label>
                <Select value={globalType} onValueChange={setGlobalType}>
                  <SelectTrigger id="global-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">{t.Proxy.types.http}</SelectItem>
                    <SelectItem value="socks5">{t.Proxy.types.socks5}</SelectItem>
                    <SelectItem value="socks5h">{t.Proxy.types.socks5h}</SelectItem>
                  </SelectContent>
                </Select>
                {globalType === 'socks5h' && (
                  <p className="text-sm text-muted-foreground">{t.Proxy.hints.socks5h}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="no-proxy">{t.Proxy.global.noProxy}</Label>
                <Input
                  id="no-proxy"
                  value={globalNoProxy}
                  onChange={(e) => setGlobalNoProxy(e.target.value)}
                  placeholder={t.Proxy.global.noProxyPlaceholder}
                />
              </div>

              {globalAutoDetect && (
                <p className="text-sm text-muted-foreground">
                  💡 手动设置的代理地址优先级高于自动检测和环境变量代理
                </p>
              )}
            </>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={handleSaveGlobal} disabled={isSavingGlobal}>
              {isSavingGlobal ? (
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {t.Common.save}
            </Button>
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={isTesting || (!globalUrl && !envProxy && !detectedProxy)}
            >
              {isTesting ? (
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <TestTube className="mr-2 h-4 w-4" />
              )}
              {t.Proxy.global.testConnection}
            </Button>
          </div>

          {/* Test result display */}
          {testResult && (
            <div
              className={`flex items-center gap-2 text-sm ${testResult.success ? 'text-green-600' : 'text-destructive'}`}
            >
              {testResult.success ? <Check className="h-4 w-4" /> : null}
              {testResult.success
                ? `${t.Proxy.global.testSuccess} (${testResult.latency}ms)`
                : t.Proxy.global.testFailed}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Web Search Proxy Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Search className="h-5 w-5" />
            <CardTitle className="text-lg">{t.Proxy.webSearch.title}</CardTitle>
          </div>
          <CardDescription>{t.Proxy.webSearch.description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Enable Web Search Proxy */}
          <div className="flex items-center justify-between">
            <Label htmlFor="websearch-enabled">{t.Proxy.webSearch.enable}</Label>
            <Switch
              id="websearch-enabled"
              checked={webSearchEnabled}
              onCheckedChange={setWebSearchEnabled}
            />
          </div>

          {/* Use Global */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="websearch-use-global">{t.Proxy.webSearch.useGlobal}</Label>
              <p className="text-sm text-muted-foreground">{t.Proxy.webSearch.useGlobalDesc}</p>
            </div>
            <Switch
              id="websearch-use-global"
              checked={webSearchUseGlobal}
              onCheckedChange={setWebSearchUseGlobal}
            />
          </div>

          {/* Custom URL - show when enabled, regardless of useGlobal */}
          {webSearchEnabled && (
            <>
              <div className="space-y-2">
                <Label htmlFor="websearch-url">{t.Proxy.webSearch.customUrl}</Label>
                <Input
                  id="websearch-url"
                  value={webSearchUrl}
                  onChange={(e) => setWebSearchUrl(e.target.value)}
                  placeholder={t.Proxy.global.urlPlaceholder}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="websearch-type">{t.Proxy.global.type}</Label>
                <Select value={webSearchType} onValueChange={setWebSearchType}>
                  <SelectTrigger id="websearch-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">{t.Proxy.types.http}</SelectItem>
                    <SelectItem value="socks5">{t.Proxy.types.socks5}</SelectItem>
                    <SelectItem value="socks5h">{t.Proxy.types.socks5h}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {webSearchUseGlobal && (
                <p className="text-sm text-muted-foreground">
                  💡 留空则使用全局代理设置，填写后将覆盖全局设置
                </p>
              )}
            </>
          )}

          <Button onClick={handleSaveWebSearch} disabled={isSavingWebSearch}>
            {isSavingWebSearch ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {t.Common.save}
          </Button>
        </CardContent>
      </Card>

      {/* Hints */}
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">{t.Proxy.hints.portCommon}</p>
        </CardContent>
      </Card>
    </div>
  );
}
