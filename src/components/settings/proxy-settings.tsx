import { Check, Globe, RefreshCw, Save, Search, Server, TestTube, X } from 'lucide-react';
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
  parseProxyUrl,
  testProxyConnection,
} from '@/lib/proxy-detector';
import { PROXY_URL_HEADER_NAME, simpleFetch } from '@/lib/tauri-fetch';
import {
  type ProxySettings as ProxySettingsType,
  settingsManager,
  type WebSearchProxySettings as WebSearchProxySettingsType,
} from '@/stores/settings-store';

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
  if (isNaN(port) || port < 1 || port > 65535) {
    return '';
  }

  if (fields.username && fields.password) {
    return `${fields.protocol}://${encodeURIComponent(fields.username)}:${encodeURIComponent(fields.password)}@${fields.host}:${port}`;
  }

  return `${fields.protocol}://${fields.host}:${port}`;
}

/**
 * Test URLs for proxy verification
 * These are specifically chosen to verify proxy functionality:
 * - httpbin.org/ip: Returns the requester's IP address (to verify proxy IP)
 * - api.ipify.org: Simple IP check service
 */
const TEST_URLS = [
  {
    url: 'https://httpbin.org/ip',
    name: 'HTTPBin IP',
    description: '返回请求者IP地址，用于验证代理是否生效',
  },
  {
    url: 'https://api.ipify.org?format=json',
    name: 'IPify',
    description: '简单的IP查询服务',
  },
];

export function ProxySettings() {
  const { t } = useLocale();

  // Global proxy settings - now using separate fields
  const [globalEnabled, setGlobalEnabled] = useState(false);
  const [globalFields, setGlobalFields] = useState<ProxyFields>({
    protocol: 'http',
    host: '',
    port: '',
    username: '',
    password: '',
  });
  const [globalAutoDetect, setGlobalAutoDetect] = useState(true);
  const [globalNoProxy, setGlobalNoProxy] = useState('');

  // Web search proxy settings - also using separate fields
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [webSearchUseGlobal, setWebSearchUseGlobal] = useState(true);
  const [webSearchFields, setWebSearchFields] = useState<ProxyFields>({
    protocol: 'http',
    host: '',
    port: '',
    username: '',
    password: '',
  });

  // Detection status
  const [detectedProxy, setDetectedProxy] = useState<string | null>(null);
  const [envProxy, setEnvProxy] = useState<string | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    latency?: number;
    ip?: string;
    testUrl?: string;
  } | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSavingGlobal, setIsSavingGlobal] = useState(false);
  const [isSavingWebSearch, setIsSavingWebSearch] = useState(false);

  // Selected test URL
  const [selectedTestUrl, setSelectedTestUrl] = useState(TEST_URLS[0]!.url);

  const loadSettings = useCallback(() => {
    const proxySettings = settingsManager.getProxySettings();
    setGlobalEnabled(proxySettings.enabled);
    setGlobalFields(urlToFields(proxySettings.url));
    setGlobalAutoDetect(proxySettings.autoDetect);
    setGlobalNoProxy(proxySettings.noProxy);

    const webSearchSettings = settingsManager.getWebSearchProxySettings();
    setWebSearchEnabled(webSearchSettings.enabled);
    setWebSearchUseGlobal(webSearchSettings.useGlobalProxy);
    setWebSearchFields(urlToFields(webSearchSettings.url));
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

  /**
   * Validate proxy fields
   */
  function validateFields(fields: ProxyFields): { valid: boolean; error?: string } {
    if (!fields.host) {
      return { valid: false, error: t.Proxy.errors.hostRequired || '请输入代理服务器地址' };
    }

    if (!fields.port) {
      return { valid: false, error: t.Proxy.errors.portRequired || '请输入端口号' };
    }

    const port = parseInt(fields.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return { valid: false, error: t.Proxy.errors.portInvalid || '端口号必须在 1-65535 之间' };
    }

    return { valid: true };
  }

  /**
   * Get effective proxy URL for testing
   */
  function getEffectiveProxyUrl(): string | null {
    if (webSearchEnabled && !webSearchUseGlobal) {
      return fieldsToUrl(webSearchFields) || null;
    }
    if (globalEnabled) {
      return fieldsToUrl(globalFields) || null;
    }
    if (envProxy) return envProxy;
    if (detectedProxy) return detectedProxy;
    return null;
  }

  async function handleSaveGlobal() {
    if (globalEnabled) {
      const validation = validateFields(globalFields);
      if (!validation.valid) {
        setValidationError(validation.error || 'Invalid proxy settings');
        toast.error(validation.error || 'Invalid proxy settings');
        return;
      }
    }

    setValidationError(null);
    setIsSavingGlobal(true);
    try {
      const url = fieldsToUrl(globalFields);
      const settings: ProxySettingsType = {
        enabled: globalEnabled,
        url,
        type: globalFields.protocol,
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
    if (webSearchEnabled && !webSearchUseGlobal) {
      const validation = validateFields(webSearchFields);
      if (!validation.valid) {
        setValidationError(validation.error || 'Invalid proxy settings');
        toast.error(validation.error || 'Invalid proxy settings');
        return;
      }
    }

    setValidationError(null);
    setIsSavingWebSearch(true);
    try {
      const url = fieldsToUrl(webSearchFields);
      const settings: WebSearchProxySettingsType = {
        enabled: webSearchEnabled,
        useGlobalProxy: webSearchUseGlobal,
        url,
        type: webSearchFields.protocol,
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

  /**
   * Test proxy connection by making an actual HTTP request through the proxy
   */
  async function handleTestConnection() {
    const proxyUrl = getEffectiveProxyUrl();
    if (!proxyUrl) {
      toast.warning(t.Proxy.global.noProxyConfigured || '没有配置代理');
      return;
    }

    setIsTesting(true);
    setTestResult(null);
    const startTime = Date.now();

    try {
      // First, test basic connectivity to the proxy server
      const basicTest = await testProxyConnection(proxyUrl);
      if (!basicTest.success) {
        setTestResult({
          success: false,
          latency: basicTest.latency,
        });
        toast.error(t.Proxy.global.testFailed || '代理连接测试失败');
        return;
      }

      // Then, make an actual request through the proxy to verify it works
      const headers: Record<string, string> = {
        [PROXY_URL_HEADER_NAME]: proxyUrl,
        Accept: 'application/json',
      };

      const response = await simpleFetch(selectedTestUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(15000),
      });

      const latency = Date.now() - startTime;

      if (!response.ok) {
        setTestResult({
          success: false,
          latency,
          testUrl: selectedTestUrl,
        });
        toast.error(`${t.Proxy.global.testFailed || '代理连接测试失败'} (HTTP ${response.status})`);
        return;
      }

      // Try to parse the response to get the IP
      let ip = '';
      try {
        const data = await response.json();
        // HTTPBin returns { "origin": "x.x.x.x" }
        // IPify returns { "ip": "x.x.x.x" }
        ip = data.origin || data.ip || '';
      } catch {
        // If JSON parsing fails, try text
        const text = await response.text();
        ip = text.substring(0, 50);
      }

      setTestResult({
        success: true,
        latency,
        ip,
        testUrl: selectedTestUrl,
      });
      toast.success(`${t.Proxy.global.testSuccess || '代理连接测试成功'} (${latency}ms)`);
    } catch (error) {
      const latency = Date.now() - startTime;
      logger.error('[ProxySettings] Test connection error:', error);
      setTestResult({
        success: false,
        latency,
        testUrl: selectedTestUrl,
      });
      toast.error(t.Proxy.global.testFailed || '代理连接测试失败');
    } finally {
      setIsTesting(false);
    }
  }

  /**
   * Update a single field in global proxy settings
   */
  function updateGlobalField<K extends keyof ProxyFields>(key: K, value: ProxyFields[K]) {
    setGlobalFields((prev) => ({ ...prev, [key]: value }));
  }

  /**
   * Update a single field in web search proxy settings
   */
  function updateWebSearchField<K extends keyof ProxyFields>(key: K, value: ProxyFields[K]) {
    setWebSearchFields((prev) => ({ ...prev, [key]: value }));
  }

  /**
   * Render proxy input fields
   */
  function renderProxyFields(
    fields: ProxyFields,
    updateField: <K extends keyof ProxyFields>(key: K, value: ProxyFields[K]) => void,
    fieldPrefix: string
  ) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          {/* Protocol */}
          <div className="space-y-2">
            <Label htmlFor={`${fieldPrefix}-protocol`}>{t.Proxy.global.protocol || '协议'}</Label>
            <Select
              value={fields.protocol}
              onValueChange={(v) => updateField('protocol', v as ProxyFields['protocol'])}
            >
              <SelectTrigger id={`${fieldPrefix}-protocol`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">{t.Proxy.types.http}</SelectItem>
                <SelectItem value="socks5">{t.Proxy.types.socks5}</SelectItem>
                <SelectItem value="socks5h">{t.Proxy.types.socks5h}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Host */}
          <div className="space-y-2">
            <Label htmlFor={`${fieldPrefix}-host`}>{t.Proxy.global.host || '服务器地址'}</Label>
            <Input
              id={`${fieldPrefix}-host`}
              value={fields.host}
              onChange={(e) => updateField('host', e.target.value)}
              placeholder="127.0.0.1 或 proxy.example.com"
            />
          </div>

          {/* Port */}
          <div className="space-y-2">
            <Label htmlFor={`${fieldPrefix}-port`}>{t.Proxy.global.port || '端口'}</Label>
            <Input
              id={`${fieldPrefix}-port`}
              type="number"
              min={1}
              max={65535}
              value={fields.port}
              onChange={(e) => updateField('port', e.target.value)}
              placeholder="7890"
            />
          </div>
        </div>

        {/* Authentication (optional) */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor={`${fieldPrefix}-username`}>
              {t.Proxy.global.username || '用户名'}
              <span className="ml-1 text-xs text-muted-foreground">({'可选'})</span>
            </Label>
            <Input
              id={`${fieldPrefix}-username`}
              value={fields.username}
              onChange={(e) => updateField('username', e.target.value)}
              placeholder={t.Proxy.global.usernamePlaceholder || '代理认证用户名'}
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${fieldPrefix}-password`}>
              {t.Proxy.global.password || '密码'}
              <span className="ml-1 text-xs text-muted-foreground">({'可选'})</span>
            </Label>
            <Input
              id={`${fieldPrefix}-password`}
              type="password"
              value={fields.password}
              onChange={(e) => updateField('password', e.target.value)}
              placeholder={t.Proxy.global.passwordPlaceholder || '代理认证密码'}
              autoComplete="off"
            />
          </div>
        </div>

        {/* Show constructed URL preview */}
        {fields.host && fields.port && (
          <div className="rounded-md bg-muted p-2 text-sm">
            <span className="text-muted-foreground">{t.Proxy.global.preview || '预览'}: </span>
            <code className="text-xs">{fieldsToUrl(fields).replace(/:(.*?)@/, ':***@')}</code>
          </div>
        )}

        {fields.protocol === 'socks5h' && (
          <p className="text-sm text-muted-foreground">{t.Proxy.hints.socks5h}</p>
        )}
      </div>
    );
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
                  {t.Proxy.global.fromEnv}: <code className="text-xs">{envProxy}</code>
                </span>
              </div>
            )}
            {detectedProxy && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Check className="h-4 w-4 text-green-500" />
                <span>
                  {t.Proxy.global.detected}: <code className="text-xs">{detectedProxy}</code>
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

          {/* Manual Configuration - show when enabled */}
          {globalEnabled && (
            <>
              {renderProxyFields(globalFields, updateGlobalField, 'global')}

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
                  💡{' '}
                  {t.Proxy.hints.manualPriority ||
                    '手动设置的代理地址优先级高于自动检测和环境变量代理'}
                </p>
              )}
            </>
          )}

          {validationError && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <X className="h-4 w-4" />
              {validationError}
            </div>
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
          </div>
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

          {/* Custom Configuration - show when enabled and not using global */}
          {webSearchEnabled && !webSearchUseGlobal && (
            <>
              {renderProxyFields(webSearchFields, updateWebSearchField, 'websearch')}

              <p className="text-sm text-muted-foreground">
                💡 {t.Proxy.hints.webSearchSeparate || '独立配置的代理仅用于网页搜索功能'}
              </p>
            </>
          )}

          {webSearchEnabled && webSearchUseGlobal && (
            <p className="text-sm text-muted-foreground">
              💡 {t.Proxy.hints.useGlobalHint || '使用全局代理设置进行网页搜索'}
            </p>
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

      {/* Proxy Test */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <TestTube className="h-5 w-5" />
            <CardTitle className="text-lg">{t.Proxy.test.title || '代理测试'}</CardTitle>
          </div>
          <CardDescription>
            {t.Proxy.test.description || '测试代理是否正常工作，通过访问测试URL验证代理IP'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Test URL selector */}
          <div className="space-y-2">
            <Label>{t.Proxy.test.testUrl || '测试地址'}</Label>
            <Select value={selectedTestUrl} onValueChange={setSelectedTestUrl}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEST_URLS.map((url) => (
                  <SelectItem key={url.url} value={url.url}>
                    {url.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {TEST_URLS.find((u) => u.url === selectedTestUrl)?.description}
            </p>
          </div>

          {/* Current proxy info */}
          <div className="rounded-md bg-muted p-3 text-sm">
            <div className="text-muted-foreground">
              {t.Proxy.test.currentProxy || '当前使用的代理'}:
            </div>
            <code className="text-xs">
              {getEffectiveProxyUrl() ? (
                getEffectiveProxyUrl()?.replace(/:(.*?)@/, ':***@')
              ) : (
                <span className="text-muted-foreground">{t.Proxy.global.none || '无代理'}</span>
              )}
            </code>
          </div>

          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={isTesting || !getEffectiveProxyUrl()}
          >
            {isTesting ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <TestTube className="mr-2 h-4 w-4" />
            )}
            {t.Proxy.global.testConnection}
          </Button>

          {/* Test result display */}
          {testResult && (
            <div
              className={`rounded-md p-3 ${
                testResult.success
                  ? 'bg-green-50 dark:bg-green-950/30'
                  : 'bg-red-50 dark:bg-red-950/30'
              }`}
            >
              <div
                className={`flex items-center gap-2 text-sm font-medium ${
                  testResult.success
                    ? 'text-green-700 dark:text-green-400'
                    : 'text-red-700 dark:text-red-400'
                }`}
              >
                {testResult.success ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
                {testResult.success
                  ? `${t.Proxy.global.testSuccess} (${testResult.latency}ms)`
                  : t.Proxy.global.testFailed}
              </div>
              {testResult.ip && (
                <div className="mt-2 text-sm">
                  <span className="text-muted-foreground">
                    {t.Proxy.test.detectedIp || '检测到的IP'}:{' '}
                  </span>
                  <code className="text-xs">{testResult.ip}</code>
                </div>
              )}
              {testResult.testUrl && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {t.Proxy.test.testUrl || '测试地址'}: {testResult.testUrl}
                </div>
              )}
            </div>
          )}
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
