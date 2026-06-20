// src/lib/proxy-detector.ts
import { logger } from '@/lib/logger';
import { isTauriRuntime } from '@/lib/runtime-env';

/**
 * Proxy configuration interface
 */
export interface ProxyConfig {
  /** Enable proxy globally */
  enabled: boolean;
  /** Proxy URL for all traffic (supports http, socks5, socks5h) */
  url?: string;
  /** Proxy type */
  type?: 'http' | 'socks5' | 'socks5h' | string;
  /** Auto-detect local proxy */
  autoDetect: boolean;
  /** Bypass list (comma-separated domains/IPs) */
  noProxy?: string;
}

/**
 * WebSearch-specific proxy configuration
 * Allows web search to use a different proxy than global
 */
export interface WebSearchProxyConfig {
  /** Enable proxy for web search specifically */
  enabled: boolean;
  /** Use global proxy settings (inherit from global) */
  useGlobalProxy: boolean;
  /** Web search specific proxy URL (if not using global) */
  url?: string;
  /** Proxy type */
  type?: 'http' | 'socks5' | 'socks5h' | string;
}

/**
 * Git-specific proxy configuration
 * Only applied to git operations (fetch, push, pull, etc.)
 * Other operations are NOT affected by this proxy
 */
export interface GitProxyConfig {
  /** Enable proxy for git operations specifically */
  enabled: boolean;
  /** Use global proxy settings (inherit from global) */
  useGlobalProxy: boolean;
  /** Git-specific proxy URL (if not using global) */
  url?: string;
  /** Proxy type */
  type?: 'http' | 'socks5' | 'socks5h' | string;
}

/**
 * Parsed proxy URL components
 */
export interface ParsedProxyUrl {
  protocol: 'http' | 'socks5' | 'socks5h';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/**
 * Common local proxy ports to check
 */
const COMMON_PROXY_PORTS = {
  http: [7890, 8080, 1080, 3128, 10809],
  socks5: [9050, 1080, 7891, 9150, 10808],
};

/**
 * Parse proxy URL string
 * Supports formats:
 * - http://host:port
 * - http://user:pass@host:port
 * - socks5://host:port
 * - socks5h://host:port
 */
export function parseProxyUrl(url: string): ParsedProxyUrl | null {
  try {
    // Handle socks5h protocol which is not standard URL format
    let normalizedUrl = url;
    if (url.startsWith('socks5h://')) {
      normalizedUrl = url.replace('socks5h://', 'socks5://');
    }

    const parsed = new URL(normalizedUrl);
    let protocol = parsed.protocol.replace(':', '') as string;

    // Normalize protocol
    if (protocol === 'https') {
      protocol = 'http';
    }
    if (url.startsWith('socks5h://')) {
      protocol = 'socks5h';
    }

    // Validate protocol
    const validProtocols = ['http', 'socks5', 'socks5h'];
    if (!validProtocols.includes(protocol)) {
      logger.warn(`[ProxyDetector] Unsupported proxy protocol: ${protocol}`);
      return null;
    }

    const finalProtocol = protocol as ParsedProxyUrl['protocol'];
    const port = parseInt(parsed.port, 10) || getDefaultPort(protocol);

    return {
      protocol: finalProtocol,
      host: parsed.hostname,
      port,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
    };
  } catch (error) {
    logger.warn(`[ProxyDetector] Failed to parse proxy URL: ${url}`, error);
    return null;
  }
}

/**
 * Get default port for proxy type
 */
function getDefaultPort(protocol: string): number {
  switch (protocol) {
    case 'http':
      return 80;
    case 'socks5':
    case 'socks5h':
      return 1080;
    default:
      return 80;
  }
}

/**
 * Check if a local port is open (potential proxy server)
 */
export async function checkLocalPort(port: number): Promise<boolean> {
  if (!isTauriRuntime()) {
    return false;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const isOpen = await invoke<boolean>('check_local_port', { port });
    return isOpen;
  } catch (error) {
    logger.warn(`[ProxyDetector] Failed to check port ${port}:`, error);
    return false;
  }
}

/**
 * Get system proxy environment variables
 */
export async function getSystemProxyEnv(): Promise<Record<string, string>> {
  if (!isTauriRuntime()) {
    return {};
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const env = await invoke<Record<string, string>>('get_system_proxy_env');
    return env;
  } catch (error) {
    logger.warn('[ProxyDetector] Failed to get system proxy env:', error);
    return {};
  }
}

/**
 * Detect proxy from system environment variables
 * Priority: HTTPS_PROXY > HTTP_PROXY > ALL_PROXY
 */
export function detectProxyFromEnv(env: Record<string, string>): ProxyConfig | null {
  // Check ALL_PROXY first (universal proxy)
  const allProxy = env.all_proxy || env.ALL_PROXY;
  if (allProxy) {
    const parsed = parseProxyUrl(allProxy);
    if (parsed) {
      return {
        enabled: true,
        url: allProxy,
        type: parsed.protocol,
        autoDetect: false,
        noProxy: env.no_proxy || env.NO_PROXY,
      };
    }
  }

  // Check HTTPS_PROXY
  const httpsProxy = env.https_proxy || env.HTTPS_PROXY;
  if (httpsProxy) {
    const parsed = parseProxyUrl(httpsProxy);
    if (parsed) {
      return {
        enabled: true,
        url: httpsProxy,
        type: parsed.protocol,
        autoDetect: false,
        noProxy: env.no_proxy || env.NO_PROXY,
      };
    }
  }

  // Check HTTP_PROXY
  const httpProxy = env.http_proxy || env.HTTP_PROXY;
  if (httpProxy) {
    const parsed = parseProxyUrl(httpProxy);
    if (parsed) {
      return {
        enabled: true,
        url: httpProxy,
        type: parsed.protocol,
        autoDetect: false,
        noProxy: env.no_proxy || env.NO_PROXY,
      };
    }
  }

  return null;
}

/**
 * Auto-detect local proxy by scanning common ports
 */
export async function detectLocalProxy(): Promise<ProxyConfig | null> {
  logger.info('[ProxyDetector] Scanning for local proxy servers...');

  // Check SOCKS5 proxy ports first (preferred for DNS resolution through proxy)
  for (const port of COMMON_PROXY_PORTS.socks5) {
    if (await checkLocalPort(port)) {
      // Use socks5h for DNS resolution through proxy
      const proxyUrl = `socks5h://127.0.0.1:${port}`;
      logger.info(`[ProxyDetector] Detected SOCKS5 proxy at port ${port}`);
      return {
        enabled: true,
        url: proxyUrl,
        type: 'socks5h',
        autoDetect: true,
      };
    }
  }

  // Check HTTP proxy ports
  for (const port of COMMON_PROXY_PORTS.http) {
    if (await checkLocalPort(port)) {
      const proxyUrl = `http://127.0.0.1:${port}`;
      logger.info(`[ProxyDetector] Detected HTTP proxy at port ${port}`);
      return {
        enabled: true,
        url: proxyUrl,
        type: 'http',
        autoDetect: true,
      };
    }
  }

  logger.info('[ProxyDetector] No local proxy detected');
  return null;
}

/**
 * Get effective proxy configuration
 * Priority: User settings > Environment variables > Auto-detection
 *
 * @param userSettings - User configured proxy settings
 * @param autoDetectEnabled - Whether auto-detection is enabled
 */
export async function getEffectiveProxyConfig(
  userSettings?: ProxyConfig,
  autoDetectEnabled = true
): Promise<ProxyConfig> {
  // 1. Check user manual settings (highest priority)
  if (userSettings?.enabled && userSettings?.url) {
    const parsed = parseProxyUrl(userSettings.url);
    if (parsed) {
      logger.info('[ProxyDetector] Using user-configured proxy:', userSettings.url);
      return {
        enabled: true,
        url: userSettings.url,
        type: parsed.protocol,
        autoDetect: false,
        noProxy: userSettings.noProxy,
      };
    }
  }

  // 2. Check system environment variables
  const env = await getSystemProxyEnv();
  const envConfig = detectProxyFromEnv(env);
  if (envConfig) {
    logger.info('[ProxyDetector] Using proxy from environment variables:', envConfig.url);
    return envConfig;
  }

  // 3. Auto-detect local proxy (if enabled)
  if (autoDetectEnabled) {
    const localConfig = await detectLocalProxy();
    if (localConfig) {
      logger.info('[ProxyDetector] Using auto-detected local proxy:', localConfig.url);
      return localConfig;
    }
  }

  // 4. No proxy
  logger.info('[ProxyDetector] No proxy detected, using direct connection');
  return {
    enabled: false,
    autoDetect: autoDetectEnabled,
  };
}

/**
 * Get effective web search proxy configuration
 * Allows web search to use its own proxy or inherit global settings
 *
 * @param webSearchSettings - Web search specific proxy settings
 * @param globalSettings - Global proxy settings
 */
export async function getEffectiveWebSearchProxy(
  webSearchSettings?: WebSearchProxyConfig,
  globalSettings?: ProxyConfig
): Promise<ProxyConfig> {
  // If web search has its own proxy enabled with a URL
  if (webSearchSettings?.enabled && !webSearchSettings.useGlobalProxy && webSearchSettings.url) {
    const parsed = parseProxyUrl(webSearchSettings.url);
    if (parsed) {
      logger.info('[ProxyDetector] Using web search specific proxy:', webSearchSettings.url);
      return {
        enabled: true,
        url: webSearchSettings.url,
        type: parsed.protocol,
        autoDetect: false,
      };
    }
  }

  // If web search is set to use global proxy (or web search settings not provided)
  if (webSearchSettings?.useGlobalProxy || !webSearchSettings?.enabled) {
    // Use global settings with auto-detection
    return getEffectiveProxyConfig(globalSettings, globalSettings?.autoDetect ?? true);
  }

  // Web search proxy enabled but no URL - auto detect
  if (webSearchSettings?.enabled && !webSearchSettings.url) {
    return getEffectiveProxyConfig(undefined, true);
  }

  // Fallback: no proxy
  return {
    enabled: false,
    autoDetect: true,
  };
}

/**
 * Convert ProxyConfig to Tauri HTTP plugin proxy format
 * @see https://v2.tauri.app/reference/javascript/http/
 */
export function toTauriProxyFormat(
  config: ProxyConfig
): { all?: string; http?: string; https?: string } | undefined {
  if (!config.enabled || !config.url) {
    return undefined;
  }

  // For socks5/socks5h proxies, use 'all' field
  if (config.type === 'socks5' || config.type === 'socks5h') {
    return { all: config.url };
  }

  // For HTTP proxy, apply to both http and https
  return {
    http: config.url,
    https: config.url,
  };
}

/**
 * Test proxy connection by making a simple request
 */
export async function testProxyConnection(proxyUrl: string): Promise<{
  success: boolean;
  latency?: number;
  error?: string;
}> {
  const startTime = Date.now();

  try {
    const parsed = parseProxyUrl(proxyUrl);
    if (!parsed) {
      return { success: false, error: 'Invalid proxy URL format' };
    }

    // Use Tauri backend to test proxy connection
    if (!isTauriRuntime()) {
      return { success: false, error: 'Proxy testing not available in web mode' };
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ success: boolean; latency: number }>('test_proxy_connection', {
      proxyUrl,
    });

    return {
      success: result.success,
      latency: result.latency,
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    return {
      success: false,
      latency,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Format proxy URL for display
 */
export function formatProxyUrlForDisplay(url: string): string {
  const parsed = parseProxyUrl(url);
  if (!parsed) {
    return url;
  }

  // Hide credentials if present
  if (parsed.username) {
    return `${parsed.protocol}://${parsed.username}:***@${parsed.host}:${parsed.port}`;
  }

  return `${parsed.protocol}://${parsed.host}:${parsed.port}`;
}

/**
 * Validate proxy URL
 */
export function validateProxyUrl(url: string): {
  valid: boolean;
  error?: string;
  parsed?: ParsedProxyUrl;
} {
  const parsed = parseProxyUrl(url);

  if (!parsed) {
    return {
      valid: false,
      error: 'Invalid proxy URL format. Expected: http://host:port or socks5://host:port',
    };
  }

  // Validate port range
  if (parsed.port < 1 || parsed.port > 65535) {
    return {
      valid: false,
      error: 'Port must be between 1 and 65535',
    };
  }

  // Validate host is not empty
  if (!parsed.host) {
    return {
      valid: false,
      error: 'Host is required',
    };
  }

  return {
    valid: true,
    parsed,
  };
}

/**
 * Get effective git proxy configuration.
 * Priority: Git-specific proxy > Global proxy > No proxy.
 *
 * Key behavior:
 * - If git proxy is enabled with its own URL, only that URL is used for git.
 * - If git proxy is enabled and set to use global, global proxy is used for git.
 * - If git proxy is disabled, no proxy is used for git (even if global proxy is enabled).
 *
 * @param gitProxySettings - Git-specific proxy settings
 * @param globalSettings - Global proxy settings
 */
export async function getEffectiveGitProxy(
  gitProxySettings?: GitProxyConfig,
  globalSettings?: ProxyConfig
): Promise<ProxyConfig> {
  // Git proxy disabled → no proxy for git
  if (!gitProxySettings?.enabled) {
    return { enabled: false, autoDetect: false };
  }

  // Git proxy enabled with its own URL (not using global)
  if (!gitProxySettings.useGlobalProxy && gitProxySettings.url) {
    const parsed = parseProxyUrl(gitProxySettings.url);
    if (parsed) {
      logger.info('[ProxyDetector] Using git-specific proxy:', gitProxySettings.url);
      return {
        enabled: true,
        url: gitProxySettings.url,
        type: parsed.protocol,
        autoDetect: false,
      };
    }
  }

  // Git proxy enabled, set to use global proxy
  if (gitProxySettings.useGlobalProxy) {
    return getEffectiveProxyConfig(globalSettings, globalSettings?.autoDetect ?? true);
  }

  // Git proxy enabled but no URL configured - auto detect
  return getEffectiveProxyConfig(undefined, true);
}
