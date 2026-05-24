use super::types::{BranchInfo, RemoteBranchInfo, TagInfo};
use git2::{Error as GitError, Repository};
use std::path::Path;

/// Type alias for upstream branch information tuple
/// (upstream_name, ahead_count, behind_count)
pub type UpstreamInfo = (Option<String>, Option<usize>, Option<usize>);

/// Discovers a Git repository starting from the given path
/// This will search upward from the given path until a .git directory is found
pub fn discover_repository<P: AsRef<Path>>(path: P) -> Result<Repository, GitError> {
    Repository::discover(path)
}

/// Checks if the given path is a Git repository
pub fn is_git_repository<P: AsRef<Path>>(path: P) -> bool {
    Repository::open(path).is_ok()
}

/// Gets the current branch information
pub fn get_current_branch(repo: &Repository) -> Result<BranchInfo, GitError> {
    let head = repo.head()?;

    if head.is_branch() {
        let branch_name = head.shorthand().unwrap_or("unknown").to_string();

        // Get upstream information
        let (upstream, ahead, behind) = get_upstream_info(repo, &head)?;

        Ok(BranchInfo {
            name: branch_name,
            is_current: true,
            is_head: false,
            upstream,
            ahead,
            behind,
        })
    } else {
        // Detached HEAD state
        let oid = head
            .target()
            .ok_or_else(|| GitError::from_str("HEAD has no target"))?;

        Ok(BranchInfo {
            name: format!("detached at {}", &oid.to_string()[..7]),
            is_current: true,
            is_head: true,
            upstream: None,
            ahead: None,
            behind: None,
        })
    }
}

/// Gets upstream branch information and ahead/behind counts
fn get_upstream_info(
    repo: &Repository,
    reference: &git2::Reference,
) -> Result<UpstreamInfo, GitError> {
    // Try to get branch name to find upstream
    let branch_name = match reference.shorthand() {
        Some(name) => name,
        None => return Ok((None, None, None)),
    };

    let branch = match repo.find_branch(branch_name, git2::BranchType::Local) {
        Ok(b) => b,
        Err(_) => return Ok((None, None, None)),
    };

    match branch.upstream() {
        Ok(upstream_branch) => {
            let upstream_name = upstream_branch.name()?.map(|s| s.to_string());

            // Calculate ahead/behind
            let local_oid = reference
                .target()
                .ok_or_else(|| GitError::from_str("Local branch has no target"))?;

            let upstream_oid = upstream_branch
                .get()
                .target()
                .ok_or_else(|| GitError::from_str("Upstream branch has no target"))?;

            match repo.graph_ahead_behind(local_oid, upstream_oid) {
                Ok((ahead, behind)) => Ok((upstream_name, Some(ahead), Some(behind))),
                Err(_) => Ok((upstream_name, None, None)),
            }
        }
        Err(_) => {
            // No upstream branch
            Ok((None, None, None))
        }
    }
}

/// Gets all branches in the repository
pub fn get_all_branches(repo: &Repository) -> Result<Vec<BranchInfo>, GitError> {
    let mut branches = Vec::new();
    let current_head = repo.head()?;
    let current_branch_name = current_head.shorthand();

    // Get local branches
    for branch in repo.branches(Some(git2::BranchType::Local))? {
        let (branch, _branch_type) = branch?;
        let name = branch.name()?.unwrap_or("unknown").to_string();
        let is_current = current_branch_name == Some(&name);
        let is_head = branch.get().kind() == Some(git2::ReferenceType::Direct) && is_current;

        // Get upstream info for this branch
        let (upstream, ahead, behind) = if is_current {
            get_upstream_info(repo, &current_head)?
        } else {
            // For non-current branches, we can't easily get ahead/behind without checking out
            (None, None, None)
        };

        branches.push(BranchInfo {
            name,
            is_current,
            is_head,
            upstream,
            ahead,
            behind,
        });
    }

    // Sort branches: current first, then alphabetically
    branches.sort_by(|a, b| {
        if a.is_current {
            std::cmp::Ordering::Less
        } else if b.is_current {
            std::cmp::Ordering::Greater
        } else {
            a.name.cmp(&b.name)
        }
    });

    Ok(branches)
}

/// Gets all tags in the repository
pub fn get_all_tags(repo: &Repository) -> Result<Vec<TagInfo>, GitError> {
    let mut tags = Vec::new();
    let current_head = repo.head()?;
    let current_head_oid = current_head.target();

    // Get all tag references
    for reference in repo.references()? {
        let ref_obj = reference?;
        let name = ref_obj.name();

        // Check if it's a tag reference (refs/tags/...)
        if let Some(name) = name {
            if name.starts_with("refs/tags/") {
                let tag_name = name.replace("refs/tags/", "");
                let is_current = ref_obj.target() == current_head_oid;

                tags.push(TagInfo {
                    name: tag_name,
                    is_current,
                });
            }
        }
    }

    // Sort tags alphabetically
    tags.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(tags)
}

/// Gets the repository root path
pub fn get_repository_root(repo: &Repository) -> Option<String> {
    repo.workdir()
        .and_then(|path| path.to_str())
        .map(|s| s.to_string())
}

/// Checkout a branch by name
pub fn checkout_branch(repo_path: &str, branch_name: &str) -> Result<(), String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let output = crate::shell_utils::new_command("git")
        .args(["checkout", branch_name])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to checkout branch: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to checkout branch {}: {}",
            branch_name,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Checkout a tag by name (creates detached HEAD state)
pub fn checkout_tag(repo_path: &str, tag_name: &str) -> Result<(), String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let output = crate::shell_utils::new_command("git")
        .args(["checkout", &format!("tags/{}", tag_name)])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to checkout tag: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to checkout tag {}: {}",
            tag_name,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Create a new branch
pub fn create_branch(
    repo_path: &str,
    branch_name: &str,
    start_point: Option<&str>,
) -> Result<(), String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let mut args = vec!["checkout", "-b", branch_name];
    if let Some(start) = start_point {
        args.push(start);
    }

    let output = crate::shell_utils::new_command("git")
        .args(&args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to create branch: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to create branch {}: {}",
            branch_name,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Get all remote branches
pub fn get_all_remote_branches(repo: &Repository) -> Result<Vec<RemoteBranchInfo>, GitError> {
    let mut remote_branches = Vec::new();

    // Get all references
    for reference in repo.references()? {
        let ref_obj = reference?;
        let name = ref_obj.name();

        // Check if it's a remote branch (refs/remotes/...)
        if let Some(name) = name {
            if let Some(stripped) = name.strip_prefix("refs/remotes/") {
                // Parse remote/branch format
                let parts: Vec<&str> = stripped.splitn(2, '/').collect();
                if parts.len() == 2 {
                    let remote = parts[0].to_string();
                    let branch_name = parts[1].to_string();
                    let full_name = format!("{}/{}", remote, branch_name);

                    remote_branches.push(RemoteBranchInfo {
                        remote,
                        name: branch_name,
                        full_name,
                    });
                }
            }
        }
    }

    // Sort by remote name, then branch name
    remote_branches.sort_by(|a, b| a.remote.cmp(&b.remote).then_with(|| a.name.cmp(&b.name)));

    Ok(remote_branches)
}

/// Fetch from remote repository
pub fn fetch(repo_path: &str, remote: Option<&str>) -> Result<String, String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let remote_name = remote.unwrap_or("--all");
    let mut args = vec!["fetch"];

    if remote_name != "--all" {
        args.push(remote_name);
    } else {
        args.push("--all");
    }

    let output = crate::shell_utils::new_command("git")
        .args(&args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to fetch: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to fetch: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(format!("Fetched from {}", remote_name))
}

/// Checkout a remote branch (creates local tracking branch)
pub fn checkout_remote_branch(
    repo_path: &str,
    remote_branch: &str,
    local_branch: Option<&str>,
) -> Result<(), String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    // If local_branch name is provided, use it; otherwise use the remote branch name
    let branch_name = local_branch.unwrap_or_else(|| {
        // Extract branch name from remote/branch format
        remote_branch
            .split('/')
            .next_back()
            .unwrap_or(remote_branch)
    });

    // Try to checkout with tracking
    let output = crate::shell_utils::new_command("git")
        .args(["checkout", "-b", branch_name, "--track", remote_branch])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to checkout remote branch: {}", e))?;

    if !output.status.success() {
        // If tracking fails, try simple checkout (branch might already exist locally)
        let output = crate::shell_utils::new_command("git")
            .args(["checkout", branch_name])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to checkout branch: {}", e))?;

        if !output.status.success() {
            return Err(format!(
                "Failed to checkout branch {}: {}",
                branch_name,
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }

    Ok(())
}

/// Delete a local branch
pub fn delete_branch(repo_path: &str, branch_name: &str) -> Result<(), String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    // First check if we're on the branch to delete
    let output = crate::shell_utils::new_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to get current branch: {}", e))?;

    let current_branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if current_branch == branch_name {
        return Err("Cannot delete the current branch".to_string());
    }

    // Try to delete the branch
    let output = crate::shell_utils::new_command("git")
        .args(["branch", "-d", branch_name])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to delete branch: {}", e))?;

    if !output.status.success() {
        // Try force delete if regular delete fails
        let force_output = crate::shell_utils::new_command("git")
            .args(["branch", "-D", branch_name])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to force delete branch: {}", e))?;

        if !force_output.status.success() {
            return Err(format!(
                "Failed to delete branch {}: {}",
                branch_name,
                String::from_utf8_lossy(&force_output.stderr)
            ));
        }
    }

    Ok(())
}

/// Push a local branch to remote repository
pub fn push_branch(
    repo_path: &str,
    branch_name: &str,
    remote: Option<&str>,
    set_upstream: bool,
) -> Result<String, String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let remote_name = remote.unwrap_or("origin");
    let mut args = vec!["push", remote_name, branch_name];

    if set_upstream {
        args.insert(2, "-u");
    }

    let output = crate::shell_utils::new_command("git")
        .args(&args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to push branch: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to push branch {}: {}",
            branch_name,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(format!("Pushed branch {} to {}", branch_name, remote_name))
}

/// Create a tag
pub fn create_tag(
    repo_path: &str,
    tag_name: &str,
    message: Option<&str>,
    target: Option<&str>,
) -> Result<(), String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let mut args = vec!["tag"];

    if let Some(msg) = message {
        args.push("-a");
        args.push(tag_name);
        args.push("-m");
        args.push(msg);
    } else {
        args.push(tag_name);
    }

    if let Some(tgt) = target {
        args.push(tgt);
    }

    let output = crate::shell_utils::new_command("git")
        .args(&args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to create tag: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to create tag {}: {}",
            tag_name,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Push tags to remote repository
pub fn push_tag(
    repo_path: &str,
    tag_name: Option<&str>,
    remote: Option<&str>,
) -> Result<String, String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let remote_name = remote.unwrap_or("origin");
    let output = if let Some(tag) = tag_name {
        crate::shell_utils::new_command("git")
            .args(["push", remote_name, "tag", tag])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to push tag: {}", e))?
    } else {
        // Push all tags
        crate::shell_utils::new_command("git")
            .args(["push", remote_name, "--tags"])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to push tags: {}", e))?
    };

    if !output.status.success() {
        return Err(format!(
            "Failed to push tags: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(format!(
        "Pushed {} to {}",
        tag_name
            .map(|t| format!("tag {}", t))
            .unwrap_or_else(|| "all tags".to_string()),
        remote_name
    ))
}

/// Delete a tag
pub fn delete_tag(repo_path: &str, tag_name: &str, remote: Option<&str>) -> Result<(), String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    // Delete local tag
    let output = crate::shell_utils::new_command("git")
        .args(["tag", "-d", tag_name])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to delete local tag: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to delete local tag {}: {}",
            tag_name,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Delete remote tag if remote is specified
    if let Some(remote_name) = remote {
        let output = crate::shell_utils::new_command("git")
            .args(["push", remote_name, &format!(":refs/tags/{}", tag_name)])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to delete remote tag: {}", e))?;

        if !output.status.success() {
            return Err(format!(
                "Failed to delete remote tag {}: {}",
                tag_name,
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }

    Ok(())
}

/// Merge a branch into the current branch
pub fn merge_branch(
    repo_path: &str,
    branch_name: &str,
    no_ff: bool,
    message: Option<&str>,
) -> Result<String, String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let mut args = vec!["merge", branch_name];

    if no_ff {
        args.push("--no-ff");
    }

    if let Some(msg) = message {
        args.push("-m");
        args.push(msg);
    }

    let output = crate::shell_utils::new_command("git")
        .args(&args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to merge branch: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);

        // Check for merge conflicts
        if stderr.contains("CONFLICT") || stdout.contains("CONFLICT") {
            return Err(format!(
                "Merge conflict detected. Please resolve conflicts and commit.\n{}",
                stderr
            ));
        }

        return Err(format!(
            "Failed to merge branch {}: {}",
            branch_name, stderr
        ));
    }

    Ok(format!("Merged branch {} into current branch", branch_name))
}

/// Abort an in-progress merge
pub fn abort_merge(repo_path: &str) -> Result<(), String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let output = crate::shell_utils::new_command("git")
        .args(["merge", "--abort"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to abort merge: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to abort merge: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Check if there is an ongoing merge
pub fn is_merging(repo_path: &str) -> Result<bool, String> {
    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let output = crate::shell_utils::new_command("git")
        .args(["rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to check merge status: {}", e))?;

    Ok(output.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    use tempfile::TempDir;

    /// Helper to create a temporary git repository
    fn create_temp_git_repo() -> TempDir {
        let temp_dir = TempDir::new().unwrap();
        crate::shell_utils::new_command("git")
            .args(["init"])
            .current_dir(temp_dir.path())
            .output()
            .expect("Failed to initialize git repo");

        // Configure git user for the repo
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

        temp_dir
    }

    #[test]
    fn test_discover_repository_in_git_dir() {
        let temp_dir = create_temp_git_repo();

        let result = discover_repository(temp_dir.path());
        assert!(
            result.is_ok(),
            "Should discover repository in git directory"
        );

        let repo = result.unwrap();
        assert!(repo.workdir().is_some());
    }

    #[test]
    fn test_discover_repository_in_subdirectory() {
        let temp_dir = create_temp_git_repo();

        // Create a subdirectory
        let subdir = temp_dir.path().join("src").join("components");
        std::fs::create_dir_all(&subdir).unwrap();

        // Should discover repo from subdirectory
        let result = discover_repository(&subdir);
        assert!(
            result.is_ok(),
            "Should discover repository from subdirectory"
        );
    }

    #[test]
    fn test_discover_repository_not_found() {
        let temp_dir = TempDir::new().unwrap();
        // This is NOT a git repo

        let result = discover_repository(temp_dir.path());
        assert!(
            result.is_err(),
            "Should fail to discover repository in non-git directory"
        );
    }

    #[test]
    fn test_is_git_repository_true() {
        let temp_dir = create_temp_git_repo();

        assert!(
            is_git_repository(temp_dir.path()),
            "Should identify as git repository"
        );
    }

    #[test]
    fn test_is_git_repository_false() {
        let temp_dir = TempDir::new().unwrap();
        // This is NOT a git repo

        assert!(
            !is_git_repository(temp_dir.path()),
            "Should not identify as git repository"
        );
    }

    #[test]
    fn test_get_repository_root() {
        let temp_dir = create_temp_git_repo();

        let repo = Repository::open(temp_dir.path()).unwrap();
        let root = get_repository_root(&repo);

        assert!(root.is_some());
        let root_path = root.unwrap();
        assert!(root_path.contains(temp_dir.path().file_name().unwrap().to_str().unwrap()));
    }

    #[test]
    fn test_get_current_branch_on_main() {
        let temp_dir = create_temp_git_repo();

        // Create initial commit to have a valid HEAD
        let test_file = temp_dir.path().join("README.md");
        std::fs::write(&test_file, "# Test").unwrap();

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

        let repo = Repository::open(temp_dir.path()).unwrap();
        let branch = get_current_branch(&repo);

        assert!(branch.is_ok());
        let branch_info = branch.unwrap();
        // Branch could be "main" or "master" depending on git version
        assert!(
            branch_info.name == "main" || branch_info.name == "master",
            "Expected 'main' or 'master', got '{}'",
            branch_info.name
        );
        assert!(branch_info.is_current);
        assert!(!branch_info.is_head); // Not detached HEAD
    }

    #[test]
    fn test_get_current_branch_detached_head() {
        let temp_dir = create_temp_git_repo();

        // Create initial commit
        let test_file = temp_dir.path().join("README.md");
        std::fs::write(&test_file, "# Test").unwrap();

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

        // Detach HEAD
        crate::shell_utils::new_command("git")
            .args(["checkout", "--detach", "HEAD"])
            .current_dir(temp_dir.path())
            .output()
            .unwrap();

        let repo = Repository::open(temp_dir.path()).unwrap();
        let branch = get_current_branch(&repo);

        assert!(branch.is_ok());
        let branch_info = branch.unwrap();
        assert!(branch_info.name.starts_with("detached at"));
        assert!(branch_info.is_head); // Detached HEAD
    }

    #[test]
    fn test_get_current_branch_feature_branch() {
        let temp_dir = create_temp_git_repo();

        // Create initial commit on main
        let test_file = temp_dir.path().join("README.md");
        std::fs::write(&test_file, "# Test").unwrap();

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

        // Create and checkout feature branch
        crate::shell_utils::new_command("git")
            .args(["checkout", "-b", "feature/test-branch"])
            .current_dir(temp_dir.path())
            .output()
            .unwrap();

        let repo = Repository::open(temp_dir.path()).unwrap();
        let branch = get_current_branch(&repo);

        assert!(branch.is_ok());
        let branch_info = branch.unwrap();
        assert_eq!(branch_info.name, "feature/test-branch");
        assert!(branch_info.is_current);
    }
}
