use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Global registry of running git processes for cancellation support
/// Maps operation ID to process PID
static RUNNING_GIT_PROCESSES: Lazy<Arc<RwLock<HashMap<String, u32>>>> =
    Lazy::new(|| Arc::new(RwLock::new(HashMap::new())));

/// Generate a unique operation ID
fn generate_operation_id(repo_path: &str, operation: &str) -> String {
    format!("{}:{}", repo_path, operation)
}

/// Register a running process
async fn register_process(operation_id: &str, pid: u32) {
    let mut processes = RUNNING_GIT_PROCESSES.write().await;
    processes.insert(operation_id.to_string(), pid);
}

/// Unregister a process (when done)
async fn unregister_process(operation_id: &str) {
    let mut processes = RUNNING_GIT_PROCESSES.write().await;
    processes.remove(operation_id);
}

/// Get process PID by operation ID
async fn get_process_pid(operation_id: &str) -> Option<u32> {
    let processes = RUNNING_GIT_PROCESSES.read().await;
    processes.get(operation_id).copied()
}

/// Kill a running process by operation ID
pub async fn kill_git_process(operation_id: &str) -> Result<(), String> {
    let pid = get_process_pid(operation_id).await;

    if let Some(pid) = pid {
        // Kill the process
        #[cfg(unix)]
        {
            use nix::sys::signal::{kill, Signal};
            use nix::unistd::Pid;
            kill(Pid::from_raw(pid as i32), Signal::SIGTERM)
                .map_err(|e| format!("Failed to kill process {}: {}", pid, e))?;
        }
        #[cfg(windows)]
        {
            // On Windows, use winapi to terminate the process
            use winapi::um::handleapi::CloseHandle;
            use winapi::um::processthreadsapi::{OpenProcess, TerminateProcess};
            use winapi::um::winnt::PROCESS_TERMINATE;

            // SAFETY: We're calling Windows API functions to terminate a process.
            // The handle is checked for null before use and properly closed.
            unsafe {
                let handle = OpenProcess(PROCESS_TERMINATE, false as i32, pid);
                if handle.is_null() {
                    return Err(format!("Failed to open process {} for termination", pid));
                }

                let result = TerminateProcess(handle, 1);
                if result == 0 {
                    CloseHandle(handle);
                    return Err(format!("Failed to terminate process {}", pid));
                }

                // Close the handle
                CloseHandle(handle);
            }
        }

        unregister_process(operation_id).await;
        Ok(())
    } else {
        Err(format!(
            "No running process found for operation: {}",
            operation_id
        ))
    }
}

/// Stage files for commit
pub fn stage_files(repo_path: &str, file_paths: &[String]) -> Result<(), String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    for file_path in file_paths {
        let output = crate::shell_utils::new_git_command()
            .args(["add", file_path])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to stage file {}: {}", file_path, e))?;

        if !output.status.success() {
            return Err(format!(
                "Failed to stage file {}: {}",
                file_path,
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }

    Ok(())
}

/// Unstage files (reset to HEAD)
pub fn unstage_files(repo_path: &str, file_paths: &[String]) -> Result<(), String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    for file_path in file_paths {
        let output = crate::shell_utils::new_git_command()
            .args(["reset", "HEAD", "--", file_path])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to unstage file {}: {}", file_path, e))?;

        if !output.status.success() {
            return Err(format!(
                "Failed to unstage file {}: {}",
                file_path,
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }

    Ok(())
}

/// Commit staged changes with a message
pub fn commit_changes(repo_path: &str, message: &str) -> Result<String, String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    // Check if there are staged changes
    let output = crate::shell_utils::new_git_command()
        .args(["diff", "--cached", "--quiet"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to check staged changes: {}", e))?;

    if output.status.success() {
        return Err("No staged changes to commit".to_string());
    }

    // Commit
    let output = crate::shell_utils::new_git_command()
        .args(["commit", "-m", message])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to commit: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to commit: {}", stderr));
    }

    // Get the commit hash
    let output = crate::shell_utils::new_git_command()
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to get commit hash: {}", e))?;

    if !output.status.success() {
        return Err("Failed to get commit hash".to_string());
    }

    let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(hash)
}

/// Stage all changes (git add -A)
pub fn stage_all(repo_path: &str) -> Result<(), String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let output = crate::shell_utils::new_git_command()
        .args(["add", "-A"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to stage all changes: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to stage all changes: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Discard changes in a file (checkout -- file)
pub fn discard_changes(repo_path: &str, file_path: &str) -> Result<(), String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let output = crate::shell_utils::new_git_command()
        .args(["checkout", "--", file_path])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to discard changes in {}: {}", file_path, e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to discard changes in {}: {}",
            file_path,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Delete an untracked file from the working directory
/// This permanently removes the file from disk (equivalent to `rm` on the file)
pub fn delete_untracked_file(repo_path: &str, file_path: &str) -> Result<(), String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let full_path = Path::new(repo_path).join(file_path);

    // Security check: ensure the resolved path is within the repository
    let canonical_repo = std::fs::canonicalize(repo_path)
        .map_err(|e| format!("Failed to resolve repository path: {}", e))?;
    let canonical_file = full_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve file path: {}", e))?;

    if !canonical_file.starts_with(&canonical_repo) {
        return Err(format!(
            "File path '{}' is outside the repository",
            file_path
        ));
    }

    // Only allow deleting files, not directories
    if !canonical_file.is_file() {
        return Err(format!(
            "Path '{}' is not a regular file. Only files can be deleted.",
            file_path
        ));
    }

    std::fs::remove_file(&canonical_file)
        .map_err(|e| format!("Failed to delete file '{}': {}", file_path, e))?;

    Ok(())
}

/// Push commits to remote repository (sync version)
pub fn push(repo_path: &str, remote: Option<&str>, branch: Option<&str>) -> Result<String, String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let remote_name = remote.unwrap_or("origin");

    // Get current branch if not specified
    let branch_name = if let Some(b) = branch {
        b.to_string()
    } else {
        // Get current branch name
        let output = crate::shell_utils::new_git_command()
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to get current branch: {}", e))?;

        if !output.status.success() {
            return Err("Failed to get current branch name".to_string());
        }

        String::from_utf8_lossy(&output.stdout).trim().to_string()
    };

    // Push to remote
    let output = crate::shell_utils::new_git_command()
        .args(["push", remote_name, &branch_name])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to push: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to push: {}", stderr));
    }

    Ok(format!("Pushed to {}/{}", remote_name, branch_name))
}

/// Push commits to remote repository (async version with cancellation support)
/// Returns the result message
pub async fn push_async(
    repo_path: &str,
    remote: Option<&str>,
    branch: Option<&str>,
    operation_id: Option<&str>,
) -> Result<String, String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let remote_name = remote.unwrap_or("origin").to_string();

    // Get current branch if not specified
    let branch_name = if let Some(b) = branch {
        b.to_string()
    } else {
        // Get current branch name
        let output = crate::shell_utils::new_git_command()
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to get current branch: {}", e))?;

        if !output.status.success() {
            return Err("Failed to get current branch name".to_string());
        }

        String::from_utf8_lossy(&output.stdout).trim().to_string()
    };

    // Generate operation ID if not provided
    let op_id = operation_id
        .map(|s| s.to_string())
        .unwrap_or_else(|| generate_operation_id(repo_path, "push"));

    // Push to remote using async command with cancellation support
    let mut child = crate::shell_utils::new_git_async_command()
        .args(["push", &remote_name, &branch_name])
        .current_dir(repo_path)
        .spawn()
        .map_err(|e| format!("Failed to start push: {}", e))?;

    // Register the process for cancellation
    if let Some(pid) = child.id() {
        register_process(&op_id, pid).await;
    }

    // Wait for completion
    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait for push: {}", e))?;

    // Unregister the process
    unregister_process(&op_id).await;

    if !status.success() {
        return Err("Push failed or was cancelled".to_string());
    }

    Ok(format!("Pushed to {}/{}", remote_name, branch_name))
}

/// Cancel an ongoing git push operation
pub async fn cancel_push(operation_id: &str) -> Result<(), String> {
    kill_git_process(operation_id).await
}

/// Pull changes from remote repository
pub fn pull(repo_path: &str, remote: Option<&str>, branch: Option<&str>) -> Result<String, String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let remote_name = remote.unwrap_or("origin");

    // Get current branch if not specified
    let branch_name = if let Some(b) = branch {
        b.to_string()
    } else {
        // Get current branch name
        let output = crate::shell_utils::new_git_command()
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to get current branch: {}", e))?;

        if !output.status.success() {
            return Err("Failed to get current branch name".to_string());
        }

        String::from_utf8_lossy(&output.stdout).trim().to_string()
    };

    // Pull from remote
    let output = crate::shell_utils::new_git_command()
        .args(["pull", remote_name, &branch_name])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to pull: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to pull: {}", stderr));
    }

    Ok(format!("Pulled from {}/{}", remote_name, branch_name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_temp_git_repo() -> TempDir {
        let temp_dir = TempDir::new().unwrap();

        crate::shell_utils::new_git_command()
            .args(["init"])
            .current_dir(temp_dir.path())
            .output()
            .expect("Failed to initialize git repo");

        crate::shell_utils::new_git_command()
            .args(["config", "user.email", "test@example.com"])
            .current_dir(temp_dir.path())
            .output()
            .expect("Failed to configure git email");

        crate::shell_utils::new_git_command()
            .args(["config", "user.name", "Test User"])
            .current_dir(temp_dir.path())
            .output()
            .expect("Failed to configure git name");

        // Create initial commit
        let readme = temp_dir.path().join("README.md");
        std::fs::write(&readme, "# Initial").unwrap();

        crate::shell_utils::new_git_command()
            .args(["add", "."])
            .current_dir(temp_dir.path())
            .output()
            .unwrap();

        crate::shell_utils::new_git_command()
            .args(["commit", "-m", "Initial commit"])
            .current_dir(temp_dir.path())
            .output()
            .unwrap();

        temp_dir
    }

    #[test]
    fn test_stage_files() {
        let temp_dir = create_temp_git_repo();

        // Create a new file
        let new_file = temp_dir.path().join("new.txt");
        std::fs::write(&new_file, "new content").unwrap();

        let repo_path = temp_dir.path().to_string_lossy().to_string();
        let result = stage_files(&repo_path, &["new.txt".to_string()]);
        assert!(result.is_ok());
    }

    #[test]
    fn test_commit_changes() {
        let temp_dir = create_temp_git_repo();

        // Create and stage a new file
        let new_file = temp_dir.path().join("new.txt");
        std::fs::write(&new_file, "new content").unwrap();

        let repo_path = temp_dir.path().to_string_lossy().to_string();
        stage_files(&repo_path, &["new.txt".to_string()]).unwrap();

        let result = commit_changes(&repo_path, "Add new file");
        assert!(result.is_ok());
        assert!(!result.unwrap().is_empty());
    }

    #[test]
    fn test_stage_all() {
        let temp_dir = create_temp_git_repo();

        // Create multiple files
        let file1 = temp_dir.path().join("file1.txt");
        let file2 = temp_dir.path().join("file2.txt");
        std::fs::write(&file1, "content 1").unwrap();
        std::fs::write(&file2, "content 2").unwrap();

        let repo_path = temp_dir.path().to_string_lossy().to_string();
        let result = stage_all(&repo_path);
        assert!(result.is_ok());
    }

    #[test]
    fn test_unstage_files() {
        let temp_dir = create_temp_git_repo();

        // Create and stage a new file
        let new_file = temp_dir.path().join("new.txt");
        std::fs::write(&new_file, "new content").unwrap();

        let repo_path = temp_dir.path().to_string_lossy().to_string();
        stage_files(&repo_path, &["new.txt".to_string()]).unwrap();

        // Unstage
        let result = unstage_files(&repo_path, &["new.txt".to_string()]);
        assert!(result.is_ok());
    }
}
