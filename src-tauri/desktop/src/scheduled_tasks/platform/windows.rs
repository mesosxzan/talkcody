//! Windows Task Scheduler integration for the scheduled-task offline runner.
//!
//! Key design decisions:
//! - `schtasks /Create` does **not** support per-task environment variables directly,
//!   so we write a small wrapper batch file that sets `TALKCODY_APP_DATA_DIR` before
//!   launching the actual TalkCody binary. The batch file lives next to the database
//!   in the app data directory.
//! - The `/TR` argument for `schtasks` must use the wrapper `.bat` file path, quoted
//!   if it contains spaces. `schtasks` itself strips one level of quotes from `/TR`,
//!   so we rely on `cmd.exe /C` invocation through the batch script to handle paths
//!   with spaces correctly.
//! - The fallback `headless_app_data_dir` in `mod.rs` uses `dirs::data_dir()` joined
//!   with `com.talkcody`, matching the Tauri app identifier on Windows.

use crate::scheduled_tasks::{
    app_data_dir, app_run_interval_minutes, executable_path, runner_args, ScheduledTaskRunnerStatus,
};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;

const TASK_NAME: &str = "TalkCodyScheduledTaskRunner";
const WRAPPER_FILENAME: &str = "talkcody-scheduler-runner.bat";

/// Path to the wrapper batch file stored in the app data directory.
fn wrapper_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app_data_dir(app)?;
    Ok(data_dir.join(WRAPPER_FILENAME))
}

/// Generate the wrapper batch script content.
///
/// The script sets `TALKCODY_APP_DATA_DIR` so the headless runner can locate
/// the SQLite database, then invokes the TalkCody executable with the
/// `--scheduled-task-runner` flag.
fn wrapper_content(exe: &PathBuf, data_dir: &PathBuf) -> String {
    // Use short 8.3 paths when possible to avoid quoting issues with spaces.
    // However, 8.3 names are not always available, so we still quote paths.
    let exe_str = exe.to_string_lossy();
    let data_dir_str = data_dir.to_string_lossy();
    let args = runner_args().join(" ");

    format!(
        "@echo off\r\n\
         set TALKCODY_APP_DATA_DIR={data_dir_str}\r\n\
         \"{exe_str}\" {args}\r\n",
        data_dir_str = data_dir_str,
        exe_str = exe_str,
        args = args,
    )
}

pub fn status(app: &AppHandle) -> Result<ScheduledTaskRunnerStatus, String> {
    let wrapper = wrapper_path(app)?;
    // If the wrapper batch file exists, the task is considered installed.
    // We also verify via schtasks to be thorough.
    let schtasks_installed = Command::new("schtasks")
        .args(["/Query", "/TN", TASK_NAME])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let installed = wrapper.exists() && schtasks_installed;

    Ok(ScheduledTaskRunnerStatus {
        supported: true,
        installed,
        platform: "windows".to_string(),
        detail: Some(TASK_NAME.to_string()),
    })
}

pub fn sync(app: &AppHandle, enabled: bool) -> Result<ScheduledTaskRunnerStatus, String> {
    if enabled {
        let exe = executable_path(app)?;
        let data_dir = app_data_dir(app)?;

        // Ensure the data directory exists before writing the wrapper script.
        if !data_dir.exists() {
            fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        }

        // Write the wrapper batch file with the env var and executable path.
        let wrapper = wrapper_path(app)?;
        let content = wrapper_content(&exe, &data_dir);
        fs::write(&wrapper, content).map_err(|e| e.to_string())?;

        // schtasks /TR: use the wrapper .bat file path, quoted for spaces.
        // schtasks strips one layer of quotes from /TR, so we wrap in quotes
        // and also use cmd.exe /C to ensure the bat file is executed properly.
        let tr_value = format!("cmd.exe /C \"{}\"", wrapper.to_string_lossy());

        let _ = Command::new("schtasks")
            .args([
                "/Create",
                "/F",
                "/SC",
                "MINUTE",
                "/MO",
                &app_run_interval_minutes().to_string(),
                "/TN",
                TASK_NAME,
                "/TR",
                &tr_value,
            ])
            .output();
    } else {
        // Delete the scheduled task and the wrapper batch file.
        let _ = Command::new("schtasks")
            .args(["/Delete", "/F", "/TN", TASK_NAME])
            .output();

        let wrapper = wrapper_path(app)?;
        if wrapper.exists() {
            let _ = fs::remove_file(&wrapper);
        }
    }

    status(app)
}
