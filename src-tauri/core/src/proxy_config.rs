//! Global proxy configuration for the application.
//!
//! This module provides a global proxy configuration that can be set from the frontend
//! and used by all shell commands (including git operations) to route traffic through
//! a proxy server.

use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Global proxy configuration storage
pub static PROXY_CONFIG: Lazy<Arc<RwLock<ProxyConfig>>> =
    Lazy::new(|| Arc::new(RwLock::new(ProxyConfig::default())));

/// Git-specific proxy configuration storage
/// This proxy is only applied to git operations, not to other network requests.
pub static GIT_PROXY_CONFIG: Lazy<Arc<RwLock<GitProxyConfig>>> =
    Lazy::new(|| Arc::new(RwLock::new(GitProxyConfig::default())));

/// Proxy configuration
#[derive(Debug, Clone, Default)]
pub struct ProxyConfig {
    /// Whether proxy is enabled
    pub enabled: bool,
    /// Proxy URL (e.g., "http://127.0.0.1:7890" or "socks5://127.0.0.1:9050")
    pub url: Option<String>,
    /// Proxy type (http, socks5, socks5h)
    pub proxy_type: Option<String>,
    /// Bypass list (domains/IPs that should not go through proxy)
    pub no_proxy: Option<String>,
}

/// Git-specific proxy configuration
/// Only used for git operations (fetch, push, pull, etc.)
/// When enabled, this takes priority over global proxy for git commands.
#[derive(Debug, Clone, Default)]
pub struct GitProxyConfig {
    /// Whether git-specific proxy is enabled
    pub enabled: bool,
    /// Whether to use global proxy settings for git
    pub use_global_proxy: bool,
    /// Git-specific proxy URL
    pub url: Option<String>,
    /// Proxy type (http, socks5, socks5h)
    pub proxy_type: Option<String>,
}

impl ProxyConfig {
    /// Create a new proxy configuration
    pub fn new(
        enabled: bool,
        url: Option<String>,
        proxy_type: Option<String>,
        no_proxy: Option<String>,
    ) -> Self {
        Self {
            enabled,
            url,
            proxy_type,
            no_proxy,
        }
    }

    /// Check if proxy is configured and enabled
    pub fn is_enabled(&self) -> bool {
        self.enabled && self.url.is_some()
    }

    /// Get environment variables for proxy configuration
    /// Returns a HashMap with HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, and NO_PROXY
    pub fn to_env_vars(&self) -> HashMap<String, String> {
        let mut env_vars = HashMap::new();

        if !self.is_enabled() {
            return env_vars;
        }

        if let Some(ref url) = self.url {
            // Set all proxy environment variables
            // Git uses HTTP_PROXY and HTTPS_PROXY
            env_vars.insert("HTTP_PROXY".to_string(), url.clone());
            env_vars.insert("HTTPS_PROXY".to_string(), url.clone());
            env_vars.insert("ALL_PROXY".to_string(), url.clone());

            // Also set lowercase versions (some tools check these)
            env_vars.insert("http_proxy".to_string(), url.clone());
            env_vars.insert("https_proxy".to_string(), url.clone());
            env_vars.insert("all_proxy".to_string(), url.clone());
        }

        if let Some(ref no_proxy) = self.no_proxy {
            if !no_proxy.is_empty() {
                env_vars.insert("NO_PROXY".to_string(), no_proxy.clone());
                env_vars.insert("no_proxy".to_string(), no_proxy.clone());
            }
        }

        env_vars
    }
}

/// Set the global proxy configuration
pub async fn set_proxy_config(
    enabled: bool,
    url: Option<String>,
    proxy_type: Option<String>,
    no_proxy: Option<String>,
) {
    let mut config = PROXY_CONFIG.write().await;
    *config = ProxyConfig::new(enabled, url, proxy_type, no_proxy);
    log::info!(
        "Proxy configuration updated: enabled={}, url={:?}",
        config.enabled,
        config.url.as_ref().map(|u| {
            // Hide credentials in logs
            if u.contains('@') {
                let parts: Vec<&str> = u.splitn(2, '@').collect();
                if parts.len() == 2 {
                    format!(
                        "{}***@{}",
                        parts[0].split(':').next().unwrap_or("***"),
                        parts[1]
                    )
                } else {
                    "***".to_string()
                }
            } else {
                u.to_string()
            }
        })
    );
}

/// Get the current proxy configuration
pub async fn get_proxy_config() -> ProxyConfig {
    PROXY_CONFIG.read().await.clone()
}

/// Get proxy environment variables for the current configuration
pub async fn get_proxy_env_vars() -> HashMap<String, String> {
    let config = PROXY_CONFIG.read().await;
    config.to_env_vars()
}

/// Tauri command to set proxy configuration from frontend
#[tauri::command]
pub async fn set_global_proxy(
    enabled: bool,
    url: Option<String>,
    proxy_type: Option<String>,
    no_proxy: Option<String>,
) -> Result<(), String> {
    set_proxy_config(enabled, url, proxy_type, no_proxy).await;
    Ok(())
}

/// Tauri command to get current proxy configuration
#[tauri::command]
pub async fn get_global_proxy() -> Result<ProxyConfigResponse, String> {
    let config = get_proxy_config().await;
    Ok(ProxyConfigResponse {
        enabled: config.enabled,
        url: config.url,
        proxy_type: config.proxy_type,
        no_proxy: config.no_proxy,
    })
}

/// Response type for get_global_proxy command
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProxyConfigResponse {
    pub enabled: bool,
    pub url: Option<String>,
    #[serde(rename = "proxyType")]
    pub proxy_type: Option<String>,
    #[serde(rename = "noProxy")]
    pub no_proxy: Option<String>,
}

/// Set the Git-specific proxy configuration
pub async fn set_git_proxy_config(
    enabled: bool,
    use_global_proxy: bool,
    url: Option<String>,
    proxy_type: Option<String>,
) {
    let mut config = GIT_PROXY_CONFIG.write().await;
    *config = GitProxyConfig {
        enabled,
        use_global_proxy,
        url,
        proxy_type,
    };
    log::info!(
        "Git proxy configuration updated: enabled={}, use_global={}, url={:?}",
        config.enabled,
        config.use_global_proxy,
        config.url.as_ref().map(|u| {
            // Hide credentials in logs
            if u.contains('@') {
                let parts: Vec<&str> = u.splitn(2, '@').collect();
                if parts.len() == 2 {
                    format!(
                        "{}***@{}",
                        parts[0].split(':').next().unwrap_or("***"),
                        parts[1]
                    )
                } else {
                    "***".to_string()
                }
            } else {
                u.to_string()
            }
        })
    );
}

/// Get the current Git-specific proxy configuration
pub async fn get_git_proxy_config() -> GitProxyConfig {
    GIT_PROXY_CONFIG.read().await.clone()
}

/// Get effective proxy environment variables for git operations.
/// This resolves the priority: Git-specific proxy > Global proxy.
pub async fn get_git_proxy_env_vars() -> HashMap<String, String> {
    let git_config = GIT_PROXY_CONFIG.read().await;

    // If git-specific proxy is enabled with its own URL (not using global)
    if git_config.enabled && !git_config.use_global_proxy {
        if let Some(ref url) = git_config.url {
            let mut env_vars = HashMap::new();
            env_vars.insert("HTTP_PROXY".to_string(), url.clone());
            env_vars.insert("HTTPS_PROXY".to_string(), url.clone());
            env_vars.insert("ALL_PROXY".to_string(), url.clone());
            env_vars.insert("http_proxy".to_string(), url.clone());
            env_vars.insert("https_proxy".to_string(), url.clone());
            env_vars.insert("all_proxy".to_string(), url.clone());
            return env_vars;
        }
    }

    // If git proxy is enabled but set to use global, or if no git-specific URL
    if git_config.enabled && git_config.use_global_proxy {
        // Fall through to global proxy
        let global_config = PROXY_CONFIG.read().await;
        return global_config.to_env_vars();
    }

    // No git proxy configured
    HashMap::new()
}

/// Tauri command to set Git-specific proxy configuration from frontend
#[tauri::command]
pub async fn set_git_proxy(
    enabled: bool,
    use_global_proxy: bool,
    url: Option<String>,
    proxy_type: Option<String>,
) -> Result<(), String> {
    set_git_proxy_config(enabled, use_global_proxy, url, proxy_type).await;
    Ok(())
}

/// Tauri command to get current Git-specific proxy configuration
#[tauri::command]
pub async fn get_git_proxy() -> Result<GitProxyConfigResponse, String> {
    let config = get_git_proxy_config().await;
    Ok(GitProxyConfigResponse {
        enabled: config.enabled,
        use_global_proxy: config.use_global_proxy,
        url: config.url,
        proxy_type: config.proxy_type,
    })
}

/// Response type for get_git_proxy command
#[derive(Debug, Clone, serde::Serialize)]
pub struct GitProxyConfigResponse {
    pub enabled: bool,
    #[serde(rename = "useGlobalProxy")]
    pub use_global_proxy: bool,
    pub url: Option<String>,
    #[serde(rename = "proxyType")]
    pub proxy_type: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_proxy_config_to_env_vars() {
        let config = ProxyConfig::new(
            true,
            Some("http://127.0.0.1:7890".to_string()),
            Some("http".to_string()),
            Some("localhost,127.0.0.1".to_string()),
        );

        let env_vars = config.to_env_vars();

        assert_eq!(
            env_vars.get("HTTP_PROXY"),
            Some(&"http://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            env_vars.get("HTTPS_PROXY"),
            Some(&"http://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            env_vars.get("ALL_PROXY"),
            Some(&"http://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            env_vars.get("NO_PROXY"),
            Some(&"localhost,127.0.0.1".to_string())
        );
    }

    #[test]
    fn test_proxy_config_disabled() {
        let config = ProxyConfig::default();
        let env_vars = config.to_env_vars();
        assert!(env_vars.is_empty());
    }

    #[test]
    fn test_proxy_config_enabled_no_url() {
        let config = ProxyConfig::new(true, None, Some("http".to_string()), None);
        let env_vars = config.to_env_vars();
        assert!(env_vars.is_empty());
    }
}
