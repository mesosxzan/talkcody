//! Tool Registry and Dispatch
//!
//! Provides a registry of available tools and dispatch mechanism for tool execution.
//! Tools execute on the backend host (filesystem, git, shell, LSP, search).

use crate::core::types::*;
use crate::database::Database;
use crate::storage::models::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Tool execution context passed to all tool handlers
#[derive(Clone)]
pub struct ToolContext {
    pub session_id: SessionId,
    pub task_id: RuntimeTaskId,
    pub workspace_root: String,
    pub worktree_path: Option<String>,
    pub settings: TaskSettings,
    pub subagent_id: Option<String>,
    pub db: Arc<Database>,
}

/// Result of tool execution
#[derive(Debug, Clone)]
pub struct ToolExecutionOutput {
    pub success: bool,
    pub data: serde_json::Value,
    pub error: Option<String>,
}

/// Tool handler function type
pub type ToolHandler = Arc<
    dyn Fn(ToolRequest, ToolContext) -> futures::future::BoxFuture<'static, ToolExecutionOutput>
        + Send
        + Sync,
>;

/// Tool registry containing all available tools
pub struct ToolRegistry {
    tools: RwLock<HashMap<String, ToolDefinition>>,
    handlers: RwLock<HashMap<String, ToolHandler>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: RwLock::new(HashMap::new()),
            handlers: RwLock::new(HashMap::new()),
        }
    }

    /// Register a new tool
    pub async fn register(
        &self,
        definition: ToolDefinition,
        handler: ToolHandler,
    ) -> Result<(), String> {
        let name = definition.name.clone();

        let mut tools = self.tools.write().await;
        if tools.contains_key(&name) {
            return Err(format!("Tool '{}' already registered", name));
        }

        tools.insert(name.clone(), definition);
        drop(tools);

        let mut handlers = self.handlers.write().await;
        handlers.insert(name, handler);

        Ok(())
    }

    /// Unregister a tool
    pub async fn unregister(&self, name: &str) -> Result<(), String> {
        let mut tools = self.tools.write().await;
        if tools.remove(name).is_none() {
            return Err(format!("Tool '{}' not found", name));
        }
        drop(tools);

        let mut handlers = self.handlers.write().await;
        handlers.remove(name);

        Ok(())
    }

    /// Get tool definition
    pub async fn get_definition(&self, name: &str) -> Option<ToolDefinition> {
        let normalized_name = crate::core::tool_name_normalizer::normalize_tool_name(name);
        let tools = self.tools.read().await;
        tools.get(&normalized_name).cloned()
    }

    /// List all registered tools
    pub async fn list_tools(&self) -> Vec<ToolDefinition> {
        let tools = self.tools.read().await;
        tools.values().cloned().collect()
    }

    /// Check if a tool requires approval
    pub async fn requires_approval(&self, name: &str) -> bool {
        let normalized_name = crate::core::tool_name_normalizer::normalize_tool_name(name);
        let tools = self.tools.read().await;
        tools
            .get(&normalized_name)
            .map(|def| def.requires_approval)
            .unwrap_or(true) // Default to requiring approval for unknown tools
    }

    /// Execute a tool
    pub async fn execute(&self, request: ToolRequest, context: ToolContext) -> ToolResult {
        let normalized_name = crate::core::tool_name_normalizer::normalize_tool_name(&request.name);
        let request = ToolRequest {
            name: normalized_name,
            ..request
        };

        let handler = {
            let handlers = self.handlers.read().await;
            match handlers.get(&request.name) {
                Some(h) => h.clone(),
                None => {
                    return ToolResult {
                        tool_call_id: request.tool_call_id,
                        name: Some(request.name.clone()),
                        success: false,
                        output: serde_json::Value::Null,
                        error: Some(format!("Tool '{}' not found", request.name)),
                    };
                }
            }
        };

        let output = handler(request.clone(), context).await;

        ToolResult {
            tool_call_id: request.tool_call_id,
            name: Some(request.name),
            success: output.success,
            output: output.data,
            error: output.error,
        }
    }

    /// Create default tool registry with built-in tools
    pub async fn create_default() -> Self {
        let registry = Self::new();

        // Register tools from canonical definitions
        let definitions = crate::core::tool_definitions::get_tool_definitions();

        for tool_def in definitions {
            let name = tool_def.0.name.clone();
            let handler: ToolHandler = Arc::new(
                move |req: crate::core::types::ToolRequest, ctx: ToolContext| {
                    let name = name.clone();
                    Box::pin(async move {
                        // Route to platform implementation
                        execute_tool_by_name(&name, req, ctx).await
                    })
                },
            );

            let _ = registry.register(tool_def.0, handler).await;
        }

        registry
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        // This is a synchronous default, so we can't register tools here
        // Use create_default() instead
        Self::new()
    }
}

/// Tool dispatcher that manages tool execution with approval workflow
pub struct ToolDispatcher {
    registry: Arc<ToolRegistry>,
}

impl ToolDispatcher {
    pub fn new(registry: Arc<ToolRegistry>) -> Self {
        Self { registry }
    }

    /// Dispatch a tool execution request
    /// Returns ToolCallRequested event if approval is required, otherwise executes immediately
    pub async fn dispatch(
        &self,
        request: ToolRequest,
        context: ToolContext,
        auto_approve: bool,
    ) -> Result<ToolDispatchResult, String> {
        let normalized_name = crate::core::tool_name_normalizer::normalize_tool_name(&request.name);
        let request = ToolRequest {
            name: normalized_name,
            ..request
        };

        // Check if tool requires approval
        let requires_approval = self.registry.requires_approval(&request.name).await;
        let requires_user_input = matches!(request.name.as_str(), "askUserQuestions");

        if requires_user_input {
            if let Err(error) = validate_ask_user_questions_input(&request.input) {
                return Ok(ToolDispatchResult::Completed(ToolResult {
                    tool_call_id: request.tool_call_id,
                    name: Some(request.name),
                    success: false,
                    output: serde_json::Value::Null,
                    error: Some(error),
                }));
            }
            Ok(ToolDispatchResult::PendingUserInput(request))
        } else if requires_approval && !auto_approve {
            // Return pending for approval
            Ok(ToolDispatchResult::PendingApproval(request))
        } else {
            // Execute immediately
            let result = self.registry.execute(request, context).await;
            Ok(ToolDispatchResult::Completed(result))
        }
    }

    /// Execute a tool that was pending approval
    pub async fn execute_approved(&self, request: ToolRequest, context: ToolContext) -> ToolResult {
        self.registry.execute(request, context).await
    }
}

/// Result of tool dispatch
#[derive(Debug, Clone)]
pub enum ToolDispatchResult {
    /// Tool executed immediately
    Completed(ToolResult),
    /// Tool requires user approval
    PendingApproval(ToolRequest),
    /// Tool is waiting for a user-provided structured result
    PendingUserInput(ToolRequest),
}

/// Execute a tool by name using the platform
async fn execute_tool_by_name(
    name: &str,
    request: ToolRequest,
    ctx: ToolContext,
) -> ToolExecutionOutput {
    let platform = crate::platform::Platform::new();
    let platform_ctx = platform.create_context(&ctx.workspace_root, ctx.worktree_path.as_deref());

    // Map camelCase tool name to platform tool name
    // All arms return ToolExecutionOutput directly for consistency
    let result: ToolExecutionOutput = match name {
        "readFile" | "read_file" => {
            let path = request
                .input
                .get("file_path")
                .and_then(|v| v.as_str())
                .or_else(|| request.input.get("path").and_then(|v| v.as_str()))
                .unwrap_or("");
            let platform_result = platform.filesystem.read_file(path, &platform_ctx).await;
            ToolExecutionOutput {
                success: platform_result.success,
                data: serde_json::to_value(&platform_result.data).unwrap_or_default(),
                error: platform_result.error,
            }
        }
        "writeFile" | "write_file" => {
            let path = request
                .input
                .get("file_path")
                .and_then(|v| v.as_str())
                .or_else(|| request.input.get("path").and_then(|v| v.as_str()))
                .unwrap_or("");
            let content = request
                .input
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let platform_result = platform
                .filesystem
                .write_file(path, content, &platform_ctx)
                .await;
            ToolExecutionOutput {
                success: platform_result.success,
                data: serde_json::to_value(platform_result.data).unwrap_or_default(),
                error: platform_result.error,
            }
        }
        "editFile" | "edit_file" => {
            // Edit file using platform
            let path = request
                .input
                .get("file_path")
                .and_then(|v| v.as_str())
                .or_else(|| request.input.get("path").and_then(|v| v.as_str()))
                .unwrap_or("");
            if let Some(edits) = request.input.get("edits").and_then(|v| v.as_array()) {
                // Read current content
                let read_result = platform.filesystem.read_file(path, &platform_ctx).await;
                if read_result.success {
                    if let Some(content) = read_result.data {
                        let mut new_content = content;
                        for edit in edits {
                            if let (Some(old_str), Some(new_str)) = (
                                edit.get("old_string").and_then(|v| v.as_str()),
                                edit.get("new_string").and_then(|v| v.as_str()),
                            ) {
                                new_content = new_content.replace(old_str, new_str);
                            }
                        }
                        let write_result = platform
                            .filesystem
                            .write_file(path, &new_content, &platform_ctx)
                            .await;
                        ToolExecutionOutput {
                            success: write_result.success,
                            data: serde_json::to_value(write_result.data).unwrap_or_default(),
                            error: write_result.error,
                        }
                    } else {
                        ToolExecutionOutput {
                            success: false,
                            data: serde_json::Value::Null,
                            error: Some("Failed to read file content".to_string()),
                        }
                    }
                } else {
                    ToolExecutionOutput {
                        success: false,
                        data: serde_json::Value::Null,
                        error: Some("Failed to read file for editing".to_string()),
                    }
                }
            } else {
                ToolExecutionOutput {
                    success: false,
                    data: serde_json::Value::Null,
                    error: Some("No edits provided".to_string()),
                }
            }
        }
        "glob" => {
            // Glob implementation using walkdir
            if let Some(pattern) = request.input.get("pattern").and_then(|v| v.as_str()) {
                // Simple glob implementation - convert pattern to suffix matching
                let files: Vec<String> = std::fs::read_dir(&ctx.workspace_root)
                    .ok()
                    .into_iter()
                    .flatten()
                    .filter_map(|e| e.ok())
                    .filter(|e| {
                        let name = e.file_name().to_string_lossy().to_string();
                        // Very simple pattern matching
                        if let Some(ext) = pattern.strip_prefix("**/*.") {
                            name.ends_with(ext)
                        } else if let Some(ext) = pattern.strip_prefix("*.") {
                            name.ends_with(ext)
                        } else {
                            name.contains(pattern)
                        }
                    })
                    .map(|e| e.path().to_string_lossy().to_string())
                    .collect();

                ToolExecutionOutput {
                    success: true,
                    data: serde_json::json!(files),
                    error: None,
                }
            } else {
                ToolExecutionOutput {
                    success: false,
                    data: serde_json::Value::Null,
                    error: Some("No pattern provided".to_string()),
                }
            }
        }
        "codeSearch" | "search_files" => {
            if let Some(query) = request.input.get("query").and_then(|v| v.as_str()) {
                let search_result = crate::search::RipgrepSearch::new()
                    .with_max_results(50)
                    .search_content(query, &ctx.workspace_root);
                match search_result {
                    Ok(results) => ToolExecutionOutput {
                        success: true,
                        data: serde_json::json!(results),
                        error: None,
                    },
                    Err(e) => ToolExecutionOutput {
                        success: false,
                        data: serde_json::Value::Null,
                        error: Some(e),
                    },
                }
            } else {
                ToolExecutionOutput {
                    success: false,
                    data: serde_json::Value::Null,
                    error: Some("No query provided".to_string()),
                }
            }
        }
        "listFiles" | "list_files" | "list_directory" => {
            let path = request
                .input
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or(".");
            let platform_result = platform
                .filesystem
                .list_directory(path, &platform_ctx)
                .await;
            ToolExecutionOutput {
                success: platform_result.success,
                data: serde_json::to_value(&platform_result.data).unwrap_or_default(),
                error: platform_result.error,
            }
        }
        "bash" | "execute_shell" | "executeShell" => {
            let command = request
                .input
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let cwd = request.input.get("cwd").and_then(|v| v.as_str());
            let platform_result = platform.shell.execute(command, cwd, &platform_ctx).await;
            ToolExecutionOutput {
                success: platform_result.success,
                data: serde_json::to_value(&platform_result.data).unwrap_or_default(),
                error: platform_result.error,
            }
        }
        "lsp" => {
            // LSP operations - return placeholder for now
            ToolExecutionOutput {
                success: true,
                data: serde_json::json!({"message": "LSP tool executed"}),
                error: None,
            }
        }
        "webFetch" | "web_fetch" => {
            if let Some(url) = request.input.get("url").and_then(|v| v.as_str()) {
                // Perform HTTP fetch
                match reqwest::get(url).await {
                    Ok(response) => match response.text().await {
                        Ok(text) => ToolExecutionOutput {
                            success: true,
                            data: serde_json::json!({"content": text}),
                            error: None,
                        },
                        Err(e) => ToolExecutionOutput {
                            success: false,
                            data: serde_json::Value::Null,
                            error: Some(format!("Failed to read response: {}", e)),
                        },
                    },
                    Err(e) => ToolExecutionOutput {
                        success: false,
                        data: serde_json::Value::Null,
                        error: Some(format!("Failed to fetch: {}", e)),
                    },
                }
            } else {
                ToolExecutionOutput {
                    success: false,
                    data: serde_json::Value::Null,
                    error: Some("No URL provided".to_string()),
                }
            }
        }
        "webSearch" | "web_search" => {
            // Web search - return placeholder
            ToolExecutionOutput {
                success: true,
                data: serde_json::json!({"results": [], "message": "Web search placeholder"}),
                error: None,
            }
        }
        "callAgent" | "call_agent" => ToolExecutionOutput {
            success: false,
            data: serde_json::Value::Null,
            error: Some("callAgent must be executed by the runtime agent loop".to_string()),
        },
        "todoWrite" | "todo_write" => execute_todo_write(&request, &ctx).await,
        "askUserQuestions" | "ask_user_questions" => ToolExecutionOutput {
            success: true,
            data: serde_json::json!({
                "status": "waiting_for_user",
                "questions": request.input.get("questions").cloned().unwrap_or(serde_json::Value::Array(vec![]))
            }),
            error: None,
        },
        "exitPlanMode" | "exit_plan_mode" => ToolExecutionOutput {
            success: true,
            data: serde_json::json!({"exited": true}),
            error: None,
        },
        "githubPR" | "github_pr" => ToolExecutionOutput {
            success: true,
            data: serde_json::json!({"message": "GitHub PR placeholder"}),
            error: None,
        },
        "git_status" | "gitStatus" => {
            let platform_result = platform.git.get_status(&platform_ctx).await;
            ToolExecutionOutput {
                success: platform_result.success,
                data: serde_json::to_value(&platform_result.data).unwrap_or_default(),
                error: platform_result.error,
            }
        }
        _ => ToolExecutionOutput {
            success: false,
            data: serde_json::Value::Null,
            error: Some(format!("Unknown tool: {}", name)),
        },
    };

    result
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredTodoPayload {
    task_id: String,
    todos: Vec<StoredTodoItem>,
    last_updated: i64,
    version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct StoredTodoItem {
    id: String,
    conversation_id: String,
    content: String,
    status: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct TodoWriteItem {
    id: String,
    content: String,
    status: String,
}

fn todo_file_path(db: &Database, task_id: &str) -> Result<PathBuf, String> {
    let db_parent = Path::new(db.db_path())
        .parent()
        .ok_or_else(|| "Database path does not have a parent directory".to_string())?;
    Ok(db_parent.join("todos").join(format!("{}.json", task_id)))
}

fn validate_todos(todos: &[TodoWriteItem]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    let mut in_progress_count = 0usize;

    for todo in todos {
        if todo.content.trim().is_empty() {
            return Err(format!("Todo with ID \"{}\" has empty content", todo.id));
        }
        if !matches!(
            todo.status.as_str(),
            "pending" | "in_progress" | "completed"
        ) {
            return Err(format!(
                "Invalid status \"{}\" for todo \"{}\"",
                todo.status, todo.id
            ));
        }
        if !ids.insert(todo.id.clone()) {
            return Err("Duplicate todo IDs found".to_string());
        }
        if todo.status == "in_progress" {
            in_progress_count += 1;
        }
    }

    if in_progress_count > 1 {
        return Err("Only one task can be in_progress at a time".to_string());
    }

    Ok(())
}

async fn execute_todo_write(request: &ToolRequest, ctx: &ToolContext) -> ToolExecutionOutput {
    let Some(todos_value) = request.input.get("todos") else {
        return ToolExecutionOutput {
            success: false,
            data: serde_json::Value::Null,
            error: Some("Missing todos".to_string()),
        };
    };

    let Some(todos_array) = todos_value.as_array() else {
        return ToolExecutionOutput {
            success: false,
            data: serde_json::Value::Null,
            error: Some("todos must be an array".to_string()),
        };
    };

    let now = chrono::Utc::now().timestamp_millis();
    let persistence_task_id = ctx
        .subagent_id
        .clone()
        .unwrap_or_else(|| ctx.task_id.clone());

    let todos = todos_array
        .iter()
        .map(|todo| TodoWriteItem {
            id: todo
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            content: todo
                .get("content")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            status: todo
                .get("status")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
        })
        .collect::<Vec<_>>();

    if let Err(error) = validate_todos(&todos) {
        return ToolExecutionOutput {
            success: false,
            data: serde_json::Value::Null,
            error: Some(error),
        };
    }

    let stored_todos = todos
        .iter()
        .map(|todo| StoredTodoItem {
            id: todo.id.clone(),
            conversation_id: persistence_task_id.clone(),
            content: todo.content.clone(),
            status: todo.status.clone(),
            created_at: now,
            updated_at: now,
        })
        .collect::<Vec<_>>();

    let payload = StoredTodoPayload {
        task_id: persistence_task_id.clone(),
        todos: stored_todos,
        last_updated: now,
        version: "1.0".to_string(),
    };

    let serialized = match serde_json::to_string_pretty(&payload) {
        Ok(value) => value,
        Err(error) => {
            return ToolExecutionOutput {
                success: false,
                data: serde_json::Value::Null,
                error: Some(format!("Failed to serialize todos: {}", error)),
            };
        }
    };

    let file_path = match todo_file_path(&ctx.db, &persistence_task_id) {
        Ok(path) => path,
        Err(error) => {
            return ToolExecutionOutput {
                success: false,
                data: serde_json::Value::Null,
                error: Some(error),
            };
        }
    };

    if let Some(parent_dir) = file_path.parent() {
        if let Err(error) = tokio::fs::create_dir_all(parent_dir).await {
            return ToolExecutionOutput {
                success: false,
                data: serde_json::Value::Null,
                error: Some(format!("Failed to create todos directory: {}", error)),
            };
        }
    }

    match tokio::fs::write(&file_path, serialized).await {
        Ok(_) => ToolExecutionOutput {
            success: true,
            data: serde_json::to_value(todos).unwrap_or_default(),
            error: None,
        },
        Err(error) => ToolExecutionOutput {
            success: false,
            data: serde_json::Value::Null,
            error: Some(format!("Failed to persist todos: {}", error)),
        },
    }
}

fn validate_ask_user_questions_input(input: &serde_json::Value) -> Result<(), String> {
    let Some(questions) = input.get("questions").and_then(|value| value.as_array()) else {
        return Err("questions must be an array".to_string());
    };

    if questions.is_empty() || questions.len() > 4 {
        return Err("questions must contain between 1 and 4 items".to_string());
    }

    let mut ids = std::collections::HashSet::new();
    for question in questions {
        let Some(question_object) = question.as_object() else {
            return Err("Each question must be an object".to_string());
        };

        let id = question_object
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if id.trim().is_empty() {
            return Err("Question IDs must be non-empty".to_string());
        }
        if !ids.insert(id.to_string()) {
            return Err("Duplicate question IDs found".to_string());
        }

        let question_text = question_object
            .get("question")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if question_text.trim().is_empty() {
            return Err(format!("Question \"{}\" must include non-empty text", id));
        }

        let header = question_object
            .get("header")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if header.trim().is_empty() {
            return Err(format!(
                "Question \"{}\" must include a non-empty header",
                id
            ));
        }
        if header.chars().count() > 20 {
            return Err(format!(
                "Question \"{}\" header must be 20 characters or fewer",
                id
            ));
        }

        let Some(options) = question_object
            .get("options")
            .and_then(|value| value.as_array())
        else {
            return Err(format!("Question \"{}\" options must be an array", id));
        };
        if options.len() < 2 || options.len() > 5 {
            return Err(format!(
                "Question \"{}\" must include between 2 and 5 options",
                id
            ));
        }

        for option in options {
            let Some(option_object) = option.as_object() else {
                return Err(format!("Question \"{}\" contains an invalid option", id));
            };
            let label = option_object
                .get("label")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let description = option_object
                .get("description")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if label.trim().is_empty() || description.trim().is_empty() {
                return Err(format!(
                    "Question \"{}\" options must include non-empty label and description",
                    id
                ));
            }
        }

        if !question_object
            .get("multiSelect")
            .is_some_and(|value| value.is_boolean())
        {
            return Err(format!(
                "Question \"{}\" must include a boolean multiSelect field",
                id
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;
    use tempfile::TempDir;

    async fn create_test_context() -> (ToolContext, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let storage = Storage::new(
            temp_dir.path().to_path_buf(),
            temp_dir.path().join("attachments"),
        )
        .await
        .expect("storage should be created");

        (
            ToolContext {
                session_id: "sess_test".to_string(),
                task_id: "task_test".to_string(),
                workspace_root: temp_dir.path().to_string_lossy().to_string(),
                worktree_path: None,
                settings: TaskSettings::default(),
                subagent_id: None,
                db: storage.settings.get_db(),
            },
            temp_dir,
        )
    }

    #[tokio::test]
    async fn test_tool_registry() {
        let registry = ToolRegistry::new();

        let tool = ToolDefinition {
            name: "test_tool".to_string(),
            description: "A test tool".to_string(),
            parameters: serde_json::json!({}),
            requires_approval: false,
        };

        let handler: ToolHandler = Arc::new(|_req, _ctx| {
            Box::pin(async move {
                ToolExecutionOutput {
                    success: true,
                    data: serde_json::json!({"result": "ok"}),
                    error: None,
                }
            })
        });

        registry
            .register(tool, handler)
            .await
            .expect("Failed to register tool");

        let definition = registry.get_definition("test_tool").await;
        assert!(definition.is_some());
        assert_eq!(definition.unwrap().name, "test_tool");
    }

    #[tokio::test]
    async fn test_tool_registry_duplicate() {
        let registry = ToolRegistry::new();

        let tool = ToolDefinition {
            name: "dup_tool".to_string(),
            description: "Test".to_string(),
            parameters: serde_json::json!({}),
            requires_approval: false,
        };

        let handler: ToolHandler = Arc::new(|_req, _ctx| {
            Box::pin(async move {
                ToolExecutionOutput {
                    success: true,
                    data: serde_json::json!({}),
                    error: None,
                }
            })
        });

        registry
            .register(tool.clone(), handler.clone())
            .await
            .expect("First register should succeed");
        let result = registry.register(tool, handler).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_default_registry() {
        let registry = ToolRegistry::create_default().await;

        let tools = registry.list_tools().await;
        assert!(!tools.is_empty());

        // Check that read_file doesn't require approval
        let read_file_def = registry.get_definition("read_file").await;
        assert!(read_file_def.is_some());
        assert!(!read_file_def.unwrap().requires_approval);

        // Check that write_file requires approval
        let write_file_def = registry.get_definition("write_file").await;
        assert!(write_file_def.is_some());
        assert!(write_file_def.unwrap().requires_approval);
    }

    #[tokio::test]
    async fn ask_user_questions_dispatches_as_pending_user_input() {
        let registry = Arc::new(ToolRegistry::create_default().await);
        let dispatcher = ToolDispatcher::new(registry);
        let (context, _temp_dir) = create_test_context().await;

        let result = dispatcher
            .dispatch(
                ToolRequest {
                    tool_call_id: "ask_1".to_string(),
                    name: "askUserQuestions".to_string(),
                    input: serde_json::json!({
                        "questions": [{
                            "id": "q1",
                            "question": "Which approach?",
                            "header": "Approach",
                            "options": [
                                {"label": "A", "description": "Use A"},
                                {"label": "B", "description": "Use B"}
                            ],
                            "multiSelect": false
                        }]
                    }),
                    provider_metadata: None,
                },
                context,
                false,
            )
            .await
            .expect("dispatch should succeed");

        assert!(matches!(result, ToolDispatchResult::PendingUserInput(_)));
    }

    #[tokio::test]
    async fn ask_user_questions_rejects_duplicate_question_ids() {
        let registry = Arc::new(ToolRegistry::create_default().await);
        let dispatcher = ToolDispatcher::new(registry);
        let (context, _temp_dir) = create_test_context().await;

        let result = dispatcher
            .dispatch(
                ToolRequest {
                    tool_call_id: "ask_dup".to_string(),
                    name: "askUserQuestions".to_string(),
                    input: serde_json::json!({
                        "questions": [
                            {
                                "id": "q1",
                                "question": "Which approach?",
                                "header": "Approach",
                                "options": [
                                    {"label": "A", "description": "Use A"},
                                    {"label": "B", "description": "Use B"}
                                ],
                                "multiSelect": false
                            },
                            {
                                "id": "q1",
                                "question": "Which fallback?",
                                "header": "Fallback",
                                "options": [
                                    {"label": "C", "description": "Use C"},
                                    {"label": "D", "description": "Use D"}
                                ],
                                "multiSelect": false
                            }
                        ]
                    }),
                    provider_metadata: None,
                },
                context,
                false,
            )
            .await
            .expect("dispatch should succeed");

        match result {
            ToolDispatchResult::Completed(result) => {
                assert!(!result.success);
                assert_eq!(
                    result.error.as_deref(),
                    Some("Duplicate question IDs found")
                );
            }
            other => panic!("unexpected dispatch result: {other:?}"),
        }
    }

    #[tokio::test]
    async fn todo_write_validates_and_persists_payload() {
        let registry = ToolRegistry::create_default().await;
        let (context, _temp_dir) = create_test_context().await;

        let result = registry
            .execute(
                ToolRequest {
                    tool_call_id: "todo_1".to_string(),
                    name: "todoWrite".to_string(),
                    input: serde_json::json!({
                        "todos": [
                            {
                                "id": "todo-1",
                                "content": "Implement runtime tool gap",
                                "status": "in_progress"
                            }
                        ]
                    }),
                    provider_metadata: None,
                },
                context.clone(),
            )
            .await;

        assert!(result.success);
        assert_eq!(
            result.output,
            serde_json::json!([{
                "id": "todo-1",
                "content": "Implement runtime tool gap",
                "status": "in_progress"
            }])
        );

        let file_path =
            todo_file_path(&context.db, "task_test").expect("todo file path should build");
        let stored_value = tokio::fs::read_to_string(file_path)
            .await
            .expect("todo payload should be stored");
        let payload: StoredTodoPayload =
            serde_json::from_str(&stored_value).expect("payload should deserialize");

        assert_eq!(payload.task_id, "task_test");
        assert_eq!(payload.todos.len(), 1);
        assert_eq!(payload.todos[0].id, "todo-1");
        assert_eq!(payload.todos[0].conversation_id, "task_test");
        assert_eq!(payload.todos[0].content, "Implement runtime tool gap");
        assert_eq!(payload.todos[0].status, "in_progress");
    }

    #[tokio::test]
    async fn todo_write_rejects_multiple_in_progress_items() {
        let registry = ToolRegistry::create_default().await;
        let (context, _temp_dir) = create_test_context().await;

        let result = registry
            .execute(
                ToolRequest {
                    tool_call_id: "todo_2".to_string(),
                    name: "todoWrite".to_string(),
                    input: serde_json::json!({
                        "todos": [
                            {"id": "todo-1", "content": "A", "status": "in_progress"},
                            {"id": "todo-2", "content": "B", "status": "in_progress"}
                        ]
                    }),
                    provider_metadata: None,
                },
                context,
            )
            .await;

        assert!(!result.success);
        assert_eq!(
            result.error.as_deref(),
            Some("Only one task can be in_progress at a time")
        );
    }
}
