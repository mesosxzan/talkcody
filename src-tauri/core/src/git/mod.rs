pub mod diff;
pub mod operations;
pub mod repository;
pub mod status;
pub mod types;
pub mod worktree;

use types::{
    BranchInfo, DiffLineType, FileDiff, GitFileStatus, GitStatus, RemoteBranchInfo, TagInfo,
};
use worktree::{MergeResult, SyncResult, WorktreeChanges, WorktreeInfo, WorktreePoolStatus};

/// Gets the Git status for a repository at the given path
#[tauri::command]
pub async fn git_get_status(repo_path: String) -> Result<GitStatus, String> {
    let repo = repository::discover_repository(&repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    status::get_repository_status(&repo)
        .map_err(|e| format!("Failed to get repository status: {}", e))
}

/// Checks if a path is a Git repository
#[tauri::command]
pub async fn git_is_repository(repo_path: String) -> Result<bool, String> {
    Ok(repository::is_git_repository(&repo_path))
}

/// Gets all file statuses as a map
#[tauri::command]
pub async fn git_get_all_file_statuses(
    repo_path: String,
) -> Result<std::collections::HashMap<String, (GitFileStatus, bool)>, String> {
    let repo = repository::discover_repository(&repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    status::get_all_file_statuses(&repo)
        .map_err(|e| format!("Failed to get all file statuses: {}", e))
}

/// Gets line-level changes for a file (for editor gutter indicators)
#[tauri::command]
pub async fn git_get_line_changes(
    repo_path: String,
    file_path: String,
) -> Result<Vec<(u32, DiffLineType)>, String> {
    let repo = repository::discover_repository(&repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    // Convert absolute path to relative path from repo root
    let repo_root = repository::get_repository_root(&repo)
        .ok_or_else(|| "Failed to get repository root".to_string())?;

    let relative_path = if file_path.starts_with(&repo_root) {
        file_path[repo_root.len()..].trim_start_matches('/')
    } else {
        &file_path
    };

    diff::get_line_changes(&repo, relative_path)
        .map_err(|e| format!("Failed to get line changes: {}", e))
}

/// Gets full diff for all changed files in the repository
#[tauri::command]
pub async fn git_get_all_file_diffs(repo_path: String) -> Result<Vec<FileDiff>, String> {
    let repo = repository::discover_repository(&repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let git_status = status::get_repository_status(&repo)
        .map_err(|e| format!("Failed to get repository status: {}", e))?;

    let mut diffs = Vec::new();

    // Collect all file paths from modified and staged files
    for file in git_status.modified.iter().chain(git_status.staged.iter()) {
        if let Ok(file_diff) = diff::get_file_diff(&repo, &file.path) {
            diffs.push(file_diff);
        }
    }

    Ok(diffs)
}

/// Gets raw diff text for all changed files (for AI commit message generation)
/// Returns text similar to `git diff` output
#[tauri::command]
pub async fn git_get_raw_diff_text(repo_path: String) -> Result<String, String> {
    let repo = repository::discover_repository(&repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    diff::get_raw_diff_text(&repo).map_err(|e| format!("Failed to get raw diff text: {}", e))
}

/// Gets raw diff text for staged files only (for AI commit message generation)
/// Returns text similar to `git diff --cached` output - the actual content that will be committed
#[tauri::command]
pub async fn git_get_staged_diff_text(repo_path: String) -> Result<String, String> {
    let repo = repository::discover_repository(&repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    diff::get_staged_diff_text(&repo).map_err(|e| format!("Failed to get staged diff text: {}", e))
}

// ============================================================================
// Worktree Commands
// ============================================================================

/// Get the default worktree root directory
#[tauri::command]
pub async fn git_get_default_worktree_root() -> Result<String, String> {
    let root = worktree::get_default_worktree_root();
    Ok(root.to_string_lossy().to_string())
}

/// Acquire a worktree from the pool for a task
/// If force is true, will discard any uncommitted changes in existing worktree
#[tauri::command]
pub async fn git_acquire_worktree(
    project_path: String,
    pool_index: u32,
    task_id: String,
    force: Option<bool>,
    worktree_root: Option<String>,
) -> Result<WorktreeInfo, String> {
    worktree::acquire_worktree(
        &project_path,
        pool_index,
        &task_id,
        force.unwrap_or(false),
        worktree_root.as_deref(),
    )
}

/// Release a worktree back to the pool
#[tauri::command]
pub async fn git_release_worktree(project_path: String, pool_index: u32) -> Result<(), String> {
    worktree::release_worktree(&project_path, pool_index)
}

/// Remove a worktree completely from the pool
#[tauri::command]
pub async fn git_remove_worktree(
    project_path: String,
    pool_index: u32,
    worktree_root: Option<String>,
) -> Result<(), String> {
    worktree::remove_worktree(&project_path, pool_index, worktree_root.as_deref())
}

/// List all worktrees in the pool for a project
#[tauri::command]
pub async fn git_list_worktrees(
    project_path: String,
    worktree_root: Option<String>,
) -> Result<WorktreePoolStatus, String> {
    worktree::list_worktrees(&project_path, worktree_root.as_deref())
}

/// Get changes in a worktree
#[tauri::command]
pub async fn git_get_worktree_changes(worktree_path: String) -> Result<WorktreeChanges, String> {
    worktree::get_worktree_changes(&worktree_path)
}

/// Commit all changes in a worktree
#[tauri::command]
pub async fn git_commit_worktree(worktree_path: String, message: String) -> Result<String, String> {
    worktree::commit_worktree(&worktree_path, &message)
}

/// Merge a worktree's changes back to the main branch
#[tauri::command]
pub async fn git_merge_worktree(
    project_path: String,
    pool_index: u32,
    commit_message: Option<String>,
    worktree_root: Option<String>,
) -> Result<MergeResult, String> {
    worktree::merge_worktree_to_main(
        &project_path,
        pool_index,
        commit_message.as_deref(),
        worktree_root.as_deref(),
    )
}

/// Abort an in-progress merge
#[tauri::command]
pub async fn git_abort_merge(project_path: String) -> Result<(), String> {
    worktree::abort_merge(&project_path)
}

/// Continue a merge after conflicts are resolved
#[tauri::command]
pub async fn git_continue_merge(
    project_path: String,
    message: Option<String>,
) -> Result<MergeResult, String> {
    worktree::continue_merge(&project_path, message.as_deref())
}

/// Clean up all worktrees for a project
#[tauri::command]
pub async fn git_cleanup_worktrees(
    project_path: String,
    worktree_root: Option<String>,
) -> Result<(), String> {
    worktree::cleanup_all_worktrees(&project_path, worktree_root.as_deref())
}

/// Sync a worktree with the latest main branch using rebase
#[tauri::command]
pub async fn git_sync_worktree_from_main(
    project_path: String,
    pool_index: u32,
    worktree_root: Option<String>,
) -> Result<SyncResult, String> {
    worktree::sync_worktree_from_main(&project_path, pool_index, worktree_root.as_deref())
}

/// Abort an in-progress rebase in a worktree
#[tauri::command]
pub async fn git_abort_rebase(worktree_path: String) -> Result<(), String> {
    worktree::abort_rebase(&worktree_path)
}

// ============================================================================
// Git Operations Commands (Stage, Unstage, Commit)
// ============================================================================

/// Stage files for commit
#[tauri::command]
pub async fn git_stage_files(repo_path: String, file_paths: Vec<String>) -> Result<(), String> {
    operations::stage_files(&repo_path, &file_paths)
}

/// Unstage files (reset to HEAD)
#[tauri::command]
pub async fn git_unstage_files(repo_path: String, file_paths: Vec<String>) -> Result<(), String> {
    operations::unstage_files(&repo_path, &file_paths)
}

/// Commit staged changes with a message
#[tauri::command]
pub async fn git_commit(repo_path: String, message: String) -> Result<String, String> {
    operations::commit_changes(&repo_path, &message)
}

/// Stage all changes (git add -A)
#[tauri::command]
pub async fn git_stage_all(repo_path: String) -> Result<(), String> {
    operations::stage_all(&repo_path)
}

/// Discard changes in a file (checkout -- file)
#[tauri::command]
pub async fn git_discard_changes(repo_path: String, file_path: String) -> Result<(), String> {
    operations::discard_changes(&repo_path, &file_path)
}

/// Delete an untracked file from the working directory
#[tauri::command]
pub async fn git_delete_untracked_file(repo_path: String, file_path: String) -> Result<(), String> {
    operations::delete_untracked_file(&repo_path, &file_path)
}

/// Get diff for a specific file
#[tauri::command]
pub async fn git_get_file_diff(repo_path: String, file_path: String) -> Result<FileDiff, String> {
    let repo = repository::discover_repository(&repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    diff::get_file_diff(&repo, &file_path).map_err(|e| format!("Failed to get file diff: {}", e))
}

/// Push commits to remote repository
#[tauri::command]
pub async fn git_push(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<String, String> {
    operations::push(&repo_path, remote.as_deref(), branch.as_deref())
}

/// Push commits to remote repository (async with cancellation support)
#[tauri::command]
pub async fn git_push_async(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
    operation_id: Option<String>,
) -> Result<String, String> {
    operations::push_async(
        &repo_path,
        remote.as_deref(),
        branch.as_deref(),
        operation_id.as_deref(),
    )
    .await
}

/// Cancel an ongoing git push operation
#[tauri::command]
pub async fn git_cancel_push(operation_id: String) -> Result<(), String> {
    operations::cancel_push(&operation_id).await
}

/// Pull changes from remote repository
#[tauri::command]
pub async fn git_pull(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<String, String> {
    operations::pull(&repo_path, remote.as_deref(), branch.as_deref())
}

// ============================================================================
// Branch and Tag Commands
// ============================================================================

/// Get all branches in the repository
#[tauri::command]
pub async fn git_get_branches(repo_path: String) -> Result<Vec<BranchInfo>, String> {
    let repo = repository::discover_repository(&repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    repository::get_all_branches(&repo).map_err(|e| format!("Failed to get branches: {}", e))
}

/// Get all tags in the repository
#[tauri::command]
pub async fn git_get_tags(repo_path: String) -> Result<Vec<TagInfo>, String> {
    let repo = repository::discover_repository(&repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    repository::get_all_tags(&repo).map_err(|e| format!("Failed to get tags: {}", e))
}

/// Checkout a branch
#[tauri::command]
pub async fn git_checkout_branch(repo_path: String, branch_name: String) -> Result<(), String> {
    repository::checkout_branch(&repo_path, &branch_name)
}

/// Checkout a tag (creates detached HEAD state)
#[tauri::command]
pub async fn git_checkout_tag(repo_path: String, tag_name: String) -> Result<(), String> {
    repository::checkout_tag(&repo_path, &tag_name)
}

/// Create a new branch
#[tauri::command]
pub async fn git_create_branch(
    repo_path: String,
    branch_name: String,
    start_point: Option<String>,
) -> Result<(), String> {
    repository::create_branch(&repo_path, &branch_name, start_point.as_deref())
}

/// Get all remote branches
#[tauri::command]
pub async fn git_get_remote_branches(repo_path: String) -> Result<Vec<RemoteBranchInfo>, String> {
    let repo = repository::discover_repository(&repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    repository::get_all_remote_branches(&repo)
        .map_err(|e| format!("Failed to get remote branches: {}", e))
}

/// Fetch from remote repository
#[tauri::command]
pub async fn git_fetch(repo_path: String, remote: Option<String>) -> Result<String, String> {
    repository::fetch(&repo_path, remote.as_deref())
}

/// Checkout a remote branch (creates local tracking branch)
#[tauri::command]
pub async fn git_checkout_remote_branch(
    repo_path: String,
    remote_branch: String,
    local_branch: Option<String>,
) -> Result<(), String> {
    repository::checkout_remote_branch(&repo_path, &remote_branch, local_branch.as_deref())
}

/// Delete a local branch
#[tauri::command]
pub async fn git_delete_branch(repo_path: String, branch_name: String) -> Result<(), String> {
    repository::delete_branch(&repo_path, &branch_name)
}

/// Push a local branch to remote
#[tauri::command]
pub async fn git_push_branch(
    repo_path: String,
    branch_name: String,
    remote: Option<String>,
    set_upstream: Option<bool>,
) -> Result<String, String> {
    repository::push_branch(
        &repo_path,
        &branch_name,
        remote.as_deref(),
        set_upstream.unwrap_or(false),
    )
}

/// Create a tag
#[tauri::command]
pub async fn git_create_tag(
    repo_path: String,
    tag_name: String,
    message: Option<String>,
    target: Option<String>,
) -> Result<(), String> {
    repository::create_tag(&repo_path, &tag_name, message.as_deref(), target.as_deref())
}

/// Push tags to remote
#[tauri::command]
pub async fn git_push_tag(
    repo_path: String,
    tag_name: Option<String>,
    remote: Option<String>,
) -> Result<String, String> {
    repository::push_tag(&repo_path, tag_name.as_deref(), remote.as_deref())
}

/// Delete a tag
#[tauri::command]
pub async fn git_delete_tag(
    repo_path: String,
    tag_name: String,
    remote: Option<String>,
) -> Result<(), String> {
    repository::delete_tag(&repo_path, &tag_name, remote.as_deref())
}

/// Merge a branch into current branch
#[tauri::command]
pub async fn git_merge_branch(
    repo_path: String,
    branch_name: String,
    no_ff: Option<bool>,
    message: Option<String>,
) -> Result<String, String> {
    repository::merge_branch(
        &repo_path,
        &branch_name,
        no_ff.unwrap_or(false),
        message.as_deref(),
    )
}

/// Abort an in-progress merge
#[tauri::command]
pub async fn git_abort_regular_merge(repo_path: String) -> Result<(), String> {
    repository::abort_merge(&repo_path)
}

/// Check if there is an ongoing merge
#[tauri::command]
pub async fn git_is_merging(repo_path: String) -> Result<bool, String> {
    repository::is_merging(&repo_path)
}

/// Get file content at HEAD (committed version)
#[tauri::command]
pub async fn git_get_file_content_at_head(
    repo_path: String,
    file_path: String,
) -> Result<String, String> {
    let repo = repository::discover_repository(&repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    diff::get_file_content_at_head(&repo, &file_path)
        .map_err(|e| format!("Failed to get file content at HEAD: {}", e))
}
