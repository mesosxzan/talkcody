use super::types::{BranchInfo, TagInfo};
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
