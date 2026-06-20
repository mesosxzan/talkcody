use log::{error, info, warn};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtySpawnResult {
    pub pty_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyOutput {
    pub pty_id: String,
    pub data: String,
}

struct PtySession {
    writer: Box<dyn Write + Send>,
    #[allow(dead_code)]
    child: Box<dyn portable_pty::Child + Send + Sync>,
    #[allow(dead_code)]
    master: Box<dyn portable_pty::MasterPty + Send>,
}

type PtySessionMap = Arc<Mutex<HashMap<String, PtySession>>>;

/// Manages PTY sessions, decoupled from Tauri event emission.
/// Can be used by both Tauri commands and the HTTP server.
/// Internally uses Arc<Mutex<...>> so it's cheaply cloneable and shareable.
#[derive(Clone)]
pub struct PtyManager {
    sessions: PtySessionMap,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawn a new PTY session. Returns the pty_id and an mpsc receiver for output.
    /// The caller is responsible for consuming the receiver (e.g., forwarding to Tauri events or WebSocket).
    pub fn spawn(
        &self,
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
        preferred_shell: Option<&str>,
    ) -> Result<(String, tokio::sync::mpsc::UnboundedReceiver<PtyOutput>), String> {
        info!("Spawning new PTY session");

        let pty_system = native_pty_system();
        let pty_size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system
            .openpty(pty_size)
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        // Try to spawn shell with fallback mechanism on Windows
        #[cfg(target_os = "windows")]
        let (shell, child) = {
            let preferred = preferred_shell;

            // If user specified a specific shell (not auto), try only that shell
            if let Some(shell) = preferred {
                if shell != "auto" {
                    info!("Attempting user-specified shell: {}", shell);
                    let mut cmd = CommandBuilder::new(shell);
                    if let Some(cwd_path) = cwd {
                        cmd.cwd(cwd_path);
                    }
                    // Set TERM environment variable to enable color support
                    cmd.env("TERM", "xterm-256color");
                    cmd.env("COLORTERM", "truecolor");
                    let args = get_shell_args(shell);
                    if !args.is_empty() {
                        cmd.args(&args);
                        info!("Added shell args: {:?}", args);
                    }
                    let child = pair.slave.spawn_command(cmd).map_err(|e| {
                        error!("Failed to spawn user-specified shell '{}': {}", shell, e);
                        format!("Failed to spawn shell '{}': {}", shell, e)
                    })?;
                    (shell.to_string(), child)
                } else {
                    // Auto mode: try shells in order with fallback
                    spawn_with_fallback(&pair.slave, cwd)?
                }
            } else {
                // No preference: auto mode
                spawn_with_fallback(&pair.slave, cwd)?
            }
        };

        #[cfg(not(target_os = "windows"))]
        let (shell, child) = {
            let shell = get_default_shell(preferred_shell);
            info!("Spawning shell: {}", shell);
            let mut cmd = CommandBuilder::new(&shell);

            if let Some(cwd_path) = cwd {
                info!("Setting working directory: {}", cwd_path);
                cmd.cwd(cwd_path);
            }

            // Set TERM environment variable to enable color support
            // This is critical for production builds launched from GUI (not terminal)
            cmd.env("TERM", "xterm-256color");
            cmd.env("COLORTERM", "truecolor");

            // Check if shell is zsh and disable PROMPT_SP (partial line marker)
            if shell.contains("zsh") {
                cmd.args(["-o", "no_prompt_sp", "-l"]);
            } else {
                cmd.arg("-l");
            }

            let child = pair.slave.spawn_command(cmd).map_err(|e| {
                error!("Failed to spawn shell '{}': {}", shell, e);
                format!("Failed to spawn shell: {}", e)
            })?;

            (shell, child)
        };

        info!("Shell '{}' spawned successfully", shell);

        // Release slave handles after spawning - we don't need it anymore
        drop(pair.slave);

        // Windows ConPTY and macOS need time to initialize before reading
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let pty_id = uuid::Uuid::new_v4().to_string();
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;

        // Create output channel
        let (output_tx, output_rx) = tokio::sync::mpsc::unbounded_channel::<PtyOutput>();

        // Store the session - keeping child and master alive is critical on Windows
        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.insert(
                pty_id.clone(),
                PtySession {
                    writer,
                    child,
                    master: pair.master,
                },
            );
        }

        // Spawn a blocking task to read output (blocking I/O needs spawn_blocking)
        let pty_id_clone = pty_id.clone();
        let output_tx_clone = output_tx;
        info!("Starting PTY read loop for {}", pty_id);
        tokio::task::spawn_blocking(move || {
            let mut buffer = [0u8; 8192];
            info!("PTY {} read loop started", pty_id_clone);
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        info!("PTY {} closed (read returned 0)", pty_id_clone);
                        // PTY closed
                        let _ = output_tx_clone.send(PtyOutput {
                            pty_id: pty_id_clone.clone(),
                            data: String::new(),
                        });
                        break;
                    }
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                        info!("PTY {} read {} bytes", pty_id_clone, n);
                        let send_result = output_tx_clone.send(PtyOutput {
                            pty_id: pty_id_clone.clone(),
                            data,
                        });
                        if let Err(e) = send_result {
                            error!("Failed to send PTY output via channel: {}", e);
                            break;
                        }
                    }
                    Err(e) => {
                        error!("Error reading from PTY {}: {}", pty_id_clone, e);
                        break;
                    }
                }
            }

            // Drop the sender to signal channel closure to the consumer
            drop(output_tx_clone);
            info!("PTY {} read loop ended", pty_id_clone);
        });

        Ok((pty_id, output_rx))
    }

    pub fn write(&self, pty_id: &str, data: &str) -> Result<(), String> {
        info!(
            "pty_write called: pty_id={}, data_len={}",
            pty_id,
            data.len()
        );
        let mut sessions = self.sessions.lock().unwrap();

        if let Some(session) = sessions.get_mut(pty_id) {
            session.writer.write_all(data.as_bytes()).map_err(|e| {
                error!("Failed to write to PTY {}: {}", pty_id, e);
                format!("Failed to write to PTY: {}", e)
            })?;
            session.writer.flush().map_err(|e| {
                error!("Failed to flush PTY {}: {}", pty_id, e);
                format!("Failed to flush PTY: {}", e)
            })?;
            info!("pty_write successful for {}", pty_id);
            Ok(())
        } else {
            error!("PTY session {} not found", pty_id);
            Err(format!("PTY session {} not found", pty_id))
        }
    }

    pub fn resize(&self, pty_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        info!("Resizing PTY {} to {}x{}", pty_id, cols, rows);

        let sessions = self.sessions.lock().unwrap();

        if let Some(session) = sessions.get(pty_id) {
            session
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| {
                    error!("Failed to resize PTY {}: {}", pty_id, e);
                    format!("Failed to resize PTY: {}", e)
                })?;
            info!("PTY {} resized successfully to {}x{}", pty_id, cols, rows);
            Ok(())
        } else {
            error!("PTY session {} not found for resize", pty_id);
            Err(format!("PTY session {} not found", pty_id))
        }
    }

    pub fn kill(&self, pty_id: &str) -> Result<(), String> {
        info!("Killing PTY session {}", pty_id);
        let mut sessions = self.sessions.lock().unwrap();

        if let Some(mut session) = sessions.remove(pty_id) {
            // Kill the child process if it's still running
            if let Err(e) = session.child.kill() {
                warn!("Failed to kill PTY child process {}: {}", pty_id, e);
                // Continue anyway - the process may have already exited
            }
            info!("PTY session {} killed successfully", pty_id);
            Ok(())
        } else {
            error!("PTY session {} not found for kill", pty_id);
            Err(format!("PTY session {} not found", pty_id))
        }
    }

    /// Check if a session exists
    pub fn session_exists(&self, pty_id: &str) -> bool {
        let sessions = self.sessions.lock().unwrap();
        sessions.contains_key(pty_id)
    }

    /// Kill all sessions (used for cleanup on WebSocket disconnect)
    pub fn kill_all(&self, pty_ids: &[String]) {
        for pty_id in pty_ids {
            if let Err(e) = self.kill(pty_id) {
                warn!("Failed to kill PTY {} during cleanup: {}", pty_id, e);
            }
        }
    }
}

/// Windows shell configurations: (command, version_args, shell_args)
/// Note: cmd.exe /? returns exit code 1, so we use /c exit 0 to check availability
/// PowerShell detection uses -NoLogo -NoProfile -Command "exit 0" to reliably exit with success
#[cfg(target_os = "windows")]
const WINDOWS_SHELLS: &[(&str, &[&str], &[&str])] = &[
    ("pwsh", &["--version"], &["-NoLogo", "-NoExit"]),
    (
        "powershell",
        &["-NoLogo", "-NoProfile", "-Command", "exit 0"],
        &["-NoLogo", "-NoExit"],
    ),
    ("cmd.exe", &["/c", "exit", "0"], &[]),
];

/// Check if a shell command is available and working
#[cfg(target_os = "windows")]
fn check_shell_available(cmd: &str, args: &[&str]) -> bool {
    match crate::shell_utils::new_command(cmd).args(args).output() {
        Ok(output) => {
            if output.status.success() {
                true
            } else {
                warn!(
                    "{} found but returned error status: {:?}",
                    cmd, output.status
                );
                false
            }
        }
        Err(e) => {
            info!("{} not available: {}", cmd, e);
            false
        }
    }
}

/// Get default shell based on user preference or auto-detection
fn get_default_shell(preferred_shell: Option<&str>) -> String {
    #[cfg(target_os = "windows")]
    {
        // If user specified a shell, try to use it
        if let Some(shell) = preferred_shell {
            if shell != "auto" {
                info!("Using user-preferred shell: {}", shell);
                return shell.to_string();
            }
        }

        // Auto-detect: prefer PowerShell Core > Windows PowerShell > cmd.exe
        for (cmd, version_args, _) in WINDOWS_SHELLS {
            if check_shell_available(cmd, version_args) {
                info!("Detected shell: {}", cmd);
                return cmd.to_string();
            }
        }

        // Final fallback
        warn!("No shell detected, falling back to COMSPEC or cmd.exe");
        crate::shell_utils::get_windows_shell()
    }

    #[cfg(not(target_os = "windows"))]
    {
        // If user specified a shell, try to use it
        if let Some(shell) = preferred_shell {
            if shell != "auto" {
                info!("Using user-preferred shell: {}", shell);
                return shell.to_string();
            }
        }

        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// Get shell arguments based on shell type
#[cfg(target_os = "windows")]
fn get_shell_args(shell: &str) -> Vec<&'static str> {
    for (cmd, _, args) in WINDOWS_SHELLS {
        if shell.contains(cmd) {
            return args.to_vec();
        }
    }
    // Default: no args for unknown shells
    vec![]
}

/// Try to spawn shells in order, falling back to next shell if one fails
#[cfg(target_os = "windows")]
fn spawn_with_fallback(
    slave: &Box<dyn portable_pty::SlavePty + Send>,
    cwd: Option<&str>,
) -> Result<(String, Box<dyn portable_pty::Child + Send + Sync>), String> {
    let mut last_error = String::new();

    for (shell_cmd, version_args, shell_args) in WINDOWS_SHELLS {
        // First check if shell is available
        if !check_shell_available(shell_cmd, version_args) {
            info!("Shell {} not available, trying next...", shell_cmd);
            continue;
        }

        info!("Attempting to spawn shell: {}", shell_cmd);
        let mut cmd = CommandBuilder::new(*shell_cmd);

        if let Some(cwd_path) = cwd {
            cmd.cwd(cwd_path);
        }

        // Set TERM environment variable to enable color support
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        if !shell_args.is_empty() {
            cmd.args(*shell_args);
            info!("Added shell args: {:?}", shell_args);
        }

        match slave.spawn_command(cmd) {
            Ok(child) => {
                info!("Successfully spawned shell: {}", shell_cmd);
                return Ok((shell_cmd.to_string(), child));
            }
            Err(e) => {
                warn!(
                    "Failed to spawn shell '{}': {}, trying next...",
                    shell_cmd, e
                );
                last_error = format!("Failed to spawn shell '{}': {}", shell_cmd, e);
            }
        }
    }

    // All shells failed
    error!(
        "All shell spawn attempts failed. Last error: {}",
        last_error
    );
    Err(format!(
        "Failed to spawn any shell. Tried: {:?}. Last error: {}",
        WINDOWS_SHELLS
            .iter()
            .map(|(cmd, _, _)| *cmd)
            .collect::<Vec<_>>(),
        last_error
    ))
}

// ============== Tauri Commands ==============
// These commands use PtyManager internally and forward output via app.emit()

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    pty_manager: tauri::State<'_, Arc<PtyManager>>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    preferred_shell: Option<String>,
) -> Result<PtySpawnResult, String> {
    let (pty_id, mut output_rx) = pty_manager.spawn(
        cwd.as_deref(),
        cols.unwrap_or(24),
        rows.unwrap_or(80),
        preferred_shell.as_deref(),
    )?;

    // Forward output from the channel to Tauri events
    let app_clone = app.clone();
    let pty_id_clone = pty_id.clone();
    let manager = (**pty_manager).clone();
    tokio::spawn(async move {
        while let Some(output) = output_rx.recv().await {
            let emit_result = app_clone.emit("pty-output", &output);
            if let Err(e) = emit_result {
                error!("Failed to emit pty-output event: {}", e);
            }
        }
        // Channel closed = PTY process exited
        let _ = app_clone.emit("pty-close", serde_json::json!({ "pty_id": pty_id_clone }));
        // Clean up the session from PtyManager
        if let Err(e) = manager.kill(&pty_id_clone) {
            warn!("Failed to clean up PTY session {}: {}", pty_id_clone, e);
        }
    });

    Ok(PtySpawnResult { pty_id })
}

#[tauri::command]
pub fn pty_write(
    pty_manager: tauri::State<'_, Arc<PtyManager>>,
    pty_id: String,
    data: String,
) -> Result<(), String> {
    pty_manager.write(&pty_id, &data)
}

#[tauri::command]
pub fn pty_resize(
    pty_manager: tauri::State<'_, Arc<PtyManager>>,
    pty_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty_manager.resize(&pty_id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(
    pty_manager: tauri::State<'_, Arc<PtyManager>>,
    pty_id: String,
) -> Result<(), String> {
    pty_manager.kill(&pty_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test that get_default_shell returns a valid shell
    #[test]
    fn test_get_default_shell_auto() {
        let shell = get_default_shell(None);
        assert!(!shell.is_empty(), "Default shell should not be empty");

        #[cfg(target_os = "windows")]
        {
            // On Windows, should be one of the known shells
            let valid_shells = ["pwsh", "powershell", "cmd.exe", "cmd"];
            let is_valid = valid_shells.iter().any(|s| shell.contains(s));
            assert!(
                is_valid,
                "Shell '{}' should be a valid Windows shell",
                shell
            );
        }

        #[cfg(not(target_os = "windows"))]
        {
            // On Unix, should be a path or shell name
            assert!(
                shell.contains("sh") || shell.contains("bash") || shell.contains("zsh"),
                "Shell '{}' should be a valid Unix shell",
                shell
            );
        }
    }

    /// Test that user-preferred shell is respected
    #[test]
    fn test_get_default_shell_with_preference() {
        let shell = get_default_shell(Some("custom-shell"));
        assert_eq!(shell, "custom-shell", "Should use user-preferred shell");
    }

    /// Test that "auto" preference triggers auto-detection
    #[test]
    fn test_get_default_shell_auto_preference() {
        let shell = get_default_shell(Some("auto"));
        // "auto" should trigger auto-detection, not return "auto"
        assert_ne!(shell, "auto", "Should not return 'auto' as shell name");
    }

    /// Test PtyManager creation
    #[test]
    fn test_pty_manager_new() {
        let _manager = PtyManager::new();
    }

    /// Test PtyManager write/resize/kill on non-existent session
    #[test]
    fn test_pty_manager_nonexistent_session() {
        let manager = PtyManager::new();
        assert!(manager.write("nonexistent", "test").is_err());
        assert!(manager.resize("nonexistent", 80, 24).is_err());
        assert!(manager.kill("nonexistent").is_err());
        assert!(!manager.session_exists("nonexistent"));
    }

    /// Test PtyManager clone shares state
    #[test]
    fn test_pty_manager_clone_shares_state() {
        let manager = PtyManager::new();
        let manager2 = manager.clone();
        // Both should share the same sessions map
        assert!(!manager.session_exists("test"));
        assert!(!manager2.session_exists("test"));
    }

    /// Windows-specific tests
    #[cfg(target_os = "windows")]
    mod windows_tests {
        use super::*;

        /// Test that check_shell_available correctly identifies available shells
        #[test]
        fn test_check_shell_available_cmd() {
            let available = check_shell_available("cmd.exe", &["/c", "exit", "0"]);
            assert!(available, "cmd.exe should be available on Windows");
        }

        /// Test that check_shell_available returns false for non-existent shell
        #[test]
        fn test_check_shell_available_nonexistent() {
            let available = check_shell_available("nonexistent-shell-12345", &["--version"]);
            assert!(!available, "Non-existent shell should not be available");
        }

        /// Test that get_shell_args returns correct args for known shells
        #[test]
        fn test_get_shell_args() {
            let pwsh_args = get_shell_args("pwsh");
            assert!(pwsh_args.contains(&"-NoLogo"), "pwsh should have -NoLogo");
            assert!(pwsh_args.contains(&"-NoExit"), "pwsh should have -NoExit");

            let cmd_args = get_shell_args("cmd.exe");
            assert!(cmd_args.is_empty(), "cmd.exe should have no special args");

            let unknown_args = get_shell_args("unknown-shell");
            assert!(unknown_args.is_empty(), "Unknown shell should have no args");
        }

        /// Test that WINDOWS_SHELLS constant is properly defined
        #[test]
        fn test_windows_shells_constant() {
            assert!(
                !WINDOWS_SHELLS.is_empty(),
                "WINDOWS_SHELLS should not be empty"
            );

            let shell_names: Vec<&str> = WINDOWS_SHELLS.iter().map(|(cmd, _, _)| *cmd).collect();
            assert!(shell_names.contains(&"pwsh"), "Should include pwsh");
            assert!(
                shell_names.contains(&"powershell"),
                "Should include powershell"
            );
            assert!(shell_names.contains(&"cmd.exe"), "Should include cmd.exe");
        }
    }

    /// Cross-platform PTY tests using PtyManager
    mod pty_manager_tests {
        use super::*;
        use std::thread;
        use std::time::Duration;

        /// Test basic PTY creation via PtyManager
        #[test]
        fn test_pty_manager_spawn_and_kill() {
            let manager = PtyManager::new();

            let (pty_id, _output_rx) = manager
                .spawn(None, 80, 24, None)
                .expect("Failed to spawn PTY");

            assert!(manager.session_exists(&pty_id));

            // Wait for shell to initialize
            thread::sleep(Duration::from_millis(100));

            // Session should still exist
            assert!(
                manager.session_exists(&pty_id),
                "Session should still exist after 100ms"
            );

            // Clean up
            manager.kill(&pty_id).expect("Failed to kill");
            assert!(!manager.session_exists(&pty_id));
        }

        /// Test that kill removes session
        #[test]
        fn test_pty_manager_kill() {
            let manager = PtyManager::new();

            let (pty_id, _output_rx) = manager
                .spawn(None, 80, 24, None)
                .expect("Failed to spawn PTY");

            assert!(manager.session_exists(&pty_id));
            manager.kill(&pty_id).expect("Failed to kill");
            assert!(!manager.session_exists(&pty_id));
        }

        /// Test kill_all
        #[test]
        fn test_pty_manager_kill_all() {
            let manager = PtyManager::new();

            let (id1, _) = manager.spawn(None, 80, 24, None).expect("Failed to spawn");
            let (id2, _) = manager.spawn(None, 80, 24, None).expect("Failed to spawn");

            manager.kill_all(&[id1.clone(), id2.clone()]);

            assert!(!manager.session_exists(&id1));
            assert!(!manager.session_exists(&id2));
        }

        /// Test multiple PTY sessions
        #[test]
        fn test_multiple_pty_sessions() {
            let manager = PtyManager::new();
            let mut ids = Vec::new();

            for _ in 0..3 {
                let (id, _) = manager.spawn(None, 80, 24, None).expect("Failed to spawn");
                ids.push(id);
            }

            thread::sleep(Duration::from_millis(100));

            for id in &ids {
                assert!(manager.session_exists(id));
            }

            manager.kill_all(&ids);

            for id in &ids {
                assert!(!manager.session_exists(id));
            }
        }
    }
}
