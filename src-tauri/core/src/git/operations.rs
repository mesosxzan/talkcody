use std::path::Path;

/// Stage files for commit
pub fn stage_files(repo_path: &str, file_paths: &[String]) -> Result<(), String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    for file_path in file_paths {
        let output = crate::shell_utils::new_command("git")
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
        let output = crate::shell_utils::new_command("git")
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
    let output = crate::shell_utils::new_command("git")
        .args(["diff", "--cached", "--quiet"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to check staged changes: {}", e))?;

    if output.status.success() {
        return Err("No staged changes to commit".to_string());
    }

    // Commit
    let output = crate::shell_utils::new_command("git")
        .args(["commit", "-m", message])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to commit: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to commit: {}", stderr));
    }

    // Get the commit hash
    let output = crate::shell_utils::new_command("git")
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

    let output = crate::shell_utils::new_command("git")
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

    let output = crate::shell_utils::new_command("git")
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

/// Push commits to remote repository
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
        let output = crate::shell_utils::new_command("git")
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
    let output = crate::shell_utils::new_command("git")
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
        let output = crate::shell_utils::new_command("git")
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
    let output = crate::shell_utils::new_command("git")
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

        crate::shell_utils::new_command("git")
            .args(["init"])
            .current_dir(temp_dir.path())
            .output()
            .expect("Failed to initialize git repo");

        crate::shell_utils::new_command("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(temp_dir.path())
            .output()
            .expect("Failed to configure git email");

        crate::shell_utils::new_command("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(temp_dir.path())
            .output()
            .expect("Failed to configure git name");

        // Create initial commit
        let readme = temp_dir.path().join("README.md");
        std::fs::write(&readme, "# Initial").unwrap();

        crate::shell_utils::new_command("git")
            .args(["add", "."])
            .current_dir(temp_dir.path())
            .output()
            .unwrap();

        crate::shell_utils::new_command("git")
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
