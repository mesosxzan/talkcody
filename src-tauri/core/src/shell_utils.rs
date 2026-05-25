// Shell utility functions for cross-platform command execution

use std::sync::RwLock;

/// Windows flag to prevent console window from appearing when spawning processes.
/// This prevents flashing cmd.exe windows in GUI applications.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Global Git executable path configuration
/// If empty, uses default "git" command
static GIT_EXECUTABLE_PATH: RwLock<String> = RwLock::new(String::new());

/// Set the Git executable path
pub fn set_git_executable_path(path: String) {
    let mut git_path = GIT_EXECUTABLE_PATH.write().unwrap();
    *git_path = path;
}

/// Get the Git executable path
pub fn get_git_executable_path() -> String {
    let git_path = GIT_EXECUTABLE_PATH.read().unwrap();
    if git_path.is_empty() {
        "git".to_string()
    } else {
        git_path.clone()
    }
}

/// Create a new `std::process::Command` with console window hidden on Windows.
///
/// On Windows, this sets the `CREATE_NO_WINDOW` creation flag to prevent
/// a console window from flashing when spawning child processes.
/// On other platforms, this is equivalent to `std::process::Command::new()`.
///
/// This function also injects proxy environment variables if configured.
pub fn new_command(program: &str) -> std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new(program);
        cmd.creation_flags(CREATE_NO_WINDOW);
        inject_proxy_env(&mut cmd);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = std::process::Command::new(program);
        inject_proxy_env(&mut cmd);
        cmd
    }
}

/// Create a new `std::process::Command` for Git with configured executable path.
///
/// Uses the configured Git executable path if set, otherwise falls back to "git".
/// This function is used for all Git operations in the application.
pub fn new_git_command() -> std::process::Command {
    let git_path = get_git_executable_path();
    new_command(&git_path)
}

/// Create a new `tokio::process::Command` with console window hidden on Windows.
///
/// On Windows, this sets the `CREATE_NO_WINDOW` creation flag to prevent
/// a console window from flashing when spawning child processes.
/// On other platforms, this is equivalent to `tokio::process::Command::new()`.
///
/// This function also injects proxy environment variables if configured.
pub fn new_async_command(program: &str) -> tokio::process::Command {
    #[cfg(windows)]
    {
        let mut cmd = tokio::process::Command::new(program);
        cmd.creation_flags(CREATE_NO_WINDOW);
        inject_proxy_env_async(&mut cmd);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = tokio::process::Command::new(program);
        inject_proxy_env_async(&mut cmd);
        cmd
    }
}

/// Create a new `tokio::process::Command` for Git with configured executable path.
///
/// Uses the configured Git executable path if set, otherwise falls back to "git".
/// This function is used for all async Git operations in the application.
pub fn new_git_async_command() -> tokio::process::Command {
    let git_path = get_git_executable_path();
    new_async_command(&git_path)
}

/// Inject proxy environment variables into a sync Command
fn inject_proxy_env(cmd: &mut std::process::Command) {
    // Try to get proxy config synchronously (non-blocking)
    // Since we're in sync context, we use try_read
    if let Ok(config) = crate::proxy_config::PROXY_CONFIG.try_read() {
        if config.is_enabled() {
            if let Some(ref url) = config.url {
                cmd.env("HTTP_PROXY", url);
                cmd.env("HTTPS_PROXY", url);
                cmd.env("ALL_PROXY", url);
                cmd.env("http_proxy", url);
                cmd.env("https_proxy", url);
                cmd.env("all_proxy", url);
            }
            if let Some(ref no_proxy) = config.no_proxy {
                if !no_proxy.is_empty() {
                    cmd.env("NO_PROXY", no_proxy);
                    cmd.env("no_proxy", no_proxy);
                }
            }
        }
    }
}

/// Inject proxy environment variables into an async Command
fn inject_proxy_env_async(cmd: &mut tokio::process::Command) {
    // Try to get proxy config synchronously (non-blocking for async)
    if let Ok(config) = crate::proxy_config::PROXY_CONFIG.try_read() {
        if config.is_enabled() {
            if let Some(ref url) = config.url {
                cmd.env("HTTP_PROXY", url);
                cmd.env("HTTPS_PROXY", url);
                cmd.env("ALL_PROXY", url);
                cmd.env("http_proxy", url);
                cmd.env("https_proxy", url);
                cmd.env("all_proxy", url);
            }
            if let Some(ref no_proxy) = config.no_proxy {
                if !no_proxy.is_empty() {
                    cmd.env("NO_PROXY", no_proxy);
                    cmd.env("no_proxy", no_proxy);
                }
            }
        }
    }
}

/// Get the shell executable path for Windows, handling COMSPEC environment variable
/// with proper quote trimming
#[cfg(windows)]
pub fn get_windows_shell() -> String {
    let shell = std::env::var("COMSPEC")
        .map(|s| s.trim_matches('"').to_string())
        .unwrap_or_else(|_| "cmd.exe".to_string());

    // Validate shell path is not empty after trimming
    if shell.is_empty() {
        "cmd.exe".to_string()
    } else {
        shell
    }
}

/// Check if the shell is PowerShell
/// Available on all platforms for use in cross-platform code
pub fn is_powershell(shell: &str) -> bool {
    shell.to_lowercase().contains("powershell") || shell.to_lowercase().contains("pwsh")
}

/// Tauri command to set Git executable path from frontend
#[tauri::command]
pub fn set_git_executable(git_path: String) -> Result<(), String> {
    set_git_executable_path(git_path);
    Ok(())
}

/// Tauri command to get current Git executable path
#[tauri::command]
pub fn get_git_executable() -> Result<String, String> {
    Ok(get_git_executable_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    use std::sync::{Mutex, OnceLock};

    #[cfg(windows)]
    static COMSPEC_TEST_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

    #[cfg(windows)]
    struct ComspecGuard {
        original: Option<String>,
    }

    #[cfg(windows)]
    impl Drop for ComspecGuard {
        fn drop(&mut self) {
            if let Some(value) = self.original.as_deref() {
                std::env::set_var("COMSPEC", value);
            } else {
                std::env::remove_var("COMSPEC");
            }
        }
    }

    #[cfg(windows)]
    fn with_comspec<T>(value: Option<&str>, test: impl FnOnce() -> T) -> T {
        let _lock = COMSPEC_TEST_MUTEX
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _guard = ComspecGuard {
            original: std::env::var("COMSPEC").ok(),
        };

        if let Some(value) = value {
            std::env::set_var("COMSPEC", value);
        } else {
            std::env::remove_var("COMSPEC");
        }

        test()
    }

    #[test]
    #[cfg(windows)]
    fn test_get_windows_shell_default() {
        with_comspec(None, || {
            let shell = get_windows_shell();
            assert_eq!(shell, "cmd.exe");
        });
    }

    #[test]
    #[cfg(windows)]
    fn test_get_windows_shell_with_quotes() {
        with_comspec(Some("\"C:\\Windows\\System32\\cmd.exe\""), || {
            let shell = get_windows_shell();
            assert_eq!(shell, "C:\\Windows\\System32\\cmd.exe");
            assert!(!shell.contains('"'));
        });
    }

    #[test]
    #[cfg(windows)]
    fn test_get_windows_shell_without_quotes() {
        with_comspec(Some("C:\\Windows\\System32\\cmd.exe"), || {
            let shell = get_windows_shell();
            assert_eq!(shell, "C:\\Windows\\System32\\cmd.exe");
        });
    }

    #[test]
    #[cfg(windows)]
    fn test_get_windows_shell_empty_after_trim() {
        with_comspec(Some("\"\""), || {
            let shell = get_windows_shell();
            assert_eq!(shell, "cmd.exe");
        });
    }

    #[test]
    fn test_is_powershell() {
        assert!(is_powershell("powershell"));
        assert!(is_powershell("powershell.exe"));
        assert!(is_powershell(
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        ));
        assert!(is_powershell("pwsh"));
        assert!(is_powershell("pwsh.exe"));
        assert!(is_powershell("PowerShell")); // case insensitive
        assert!(is_powershell("POWERSHELL")); // case insensitive

        assert!(!is_powershell("cmd.exe"));
        assert!(!is_powershell("bash"));
        assert!(!is_powershell("zsh"));
    }

    #[test]
    #[cfg(windows)]
    fn test_get_windows_shell_powershell() {
        with_comspec(
            Some("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
            || {
                let shell = get_windows_shell();
                assert!(is_powershell(&shell));
            },
        );
    }
}
