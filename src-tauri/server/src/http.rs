use axum::extract::{
    ws::{Message, WebSocket},
    Path, State, WebSocketUpgrade,
};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::Stream;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::sync::Arc;
use talkcody_core::core::types::{RuntimeEvent, RuntimeTaskState, TaskAction, TaskInput};
use talkcody_core::database::QueryResult;
use talkcody_core::git;
use talkcody_core::http_proxy::{proxy_fetch as core_proxy_fetch, ProxyRequest, ProxyResponse};
use talkcody_core::llm::types::{
    CustomProviderConfig, CustomProviderType, ProtocolType, ProviderConfig,
};
use talkcody_core::scheduler::cron_utils::{
    compute_next_run_at, now_unix_ms, preview_schedule, validate_cron_expr, validate_timezone,
};
use talkcody_core::scheduler::repository::ScheduledTaskRepository;
use talkcody_core::scheduler::types::{
    CreateScheduledTaskRequest, JobStatus, RunCompletePayload, RunStatus, RunTriggerSource,
    ScheduledTask, ScheduledTaskExecutionPolicy, ScheduledTaskRun, ScheduledTaskSchedule,
    UpdateScheduledTaskRequest,
};
use talkcody_core::{directory_tree, file_search, glob, list_files, search, shell_utils};
use tokio_stream::wrappers::BroadcastStream;
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;

use crate::{ServerConfig, ServerState};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartTaskResponse {
    task_id: String,
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskActionRequest {
    action: TaskAction,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskStateResponse {
    state: Option<RuntimeTaskState>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildDirectoryTreeRequest {
    root_path: String,
    max_immediate_depth: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadDirectoryChildrenRequest {
    dir_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvalidateDirectoryPathRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListProjectFilesRequest {
    directory_path: String,
    recursive: Option<bool>,
    max_depth: Option<usize>,
    max_files: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchFilesRequest {
    query: String,
    root_path: String,
    max_results: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchFilesByGlobRequest {
    pattern: String,
    path: Option<String>,
    max_results: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchFileContentRequest {
    query: String,
    root_path: String,
    file_types: Option<Vec<String>>,
    exclude_dirs: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadTextFileRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteTextFileRequest {
    path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckFileExistsRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCommandRequest {
    command: String,
    args: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct ShellResult {
    stdout: String,
    stderr: String,
    code: i32,
    timed_out: bool,
    idle_timed_out: bool,
    pid: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbExecuteRequest {
    sql: String,
    params: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbQueryRequest {
    sql: String,
    params: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbBatchRequest {
    statements: Vec<(String, Vec<serde_json::Value>)>,
}

pub fn create_router(state: ServerState) -> Router {
    let config = state.config.clone();
    Router::new()
        .route("/health", get(health))
        .route("/api/runtime/tasks", post(start_task))
        .route("/api/runtime/tasks/:task_id/actions", post(send_action))
        .route("/api/runtime/tasks/:task_id/cancel", post(cancel_task))
        .route("/api/runtime/tasks/:task_id/state", get(get_task_state))
        .route("/api/runtime/tasks/:task_id/events", get(task_events))
        .route(
            "/api/runtime/sessions/:session_id/events",
            get(session_events),
        )
        .route("/api/platform/directory-tree", post(build_directory_tree))
        .route(
            "/api/platform/directory-children",
            post(load_directory_children),
        )
        .route(
            "/api/platform/directory-cache/clear",
            post(clear_directory_cache),
        )
        .route(
            "/api/platform/directory-cache/invalidate",
            post(invalidate_directory_path),
        )
        .route("/api/platform/list-files", post(list_project_files))
        .route(
            "/api/platform/search-files-by-glob",
            post(search_files_by_glob),
        )
        .route("/api/platform/search-files", post(search_files))
        .route(
            "/api/platform/search-file-content",
            post(search_file_content),
        )
        .route("/api/platform/read-text-file", post(read_text_file))
        .route("/api/platform/write-text-file", post(write_text_file))
        .route("/api/platform/check-file-exists", post(check_file_exists))
        .route("/api/platform/git", post(git_command))
        // Terminal WebSocket
        .route("/api/terminal/ws", get(terminal_ws_handler))
        .route("/api/db/execute", post(db_execute))
        .route("/api/db/query", post(db_query))
        .route("/api/db/batch", post(db_batch))
        // Proxy fetch - forwards HTTP requests through the server to bypass CORS
        .route("/api/proxy-fetch", post(proxy_fetch_handler))
        // LLM commands - web mode bridge
        .route(
            "/api/llm/llm_register_custom_provider",
            post(llm_register_custom_provider),
        )
        .route("/api/llm/llm_oauth_status", post(llm_oauth_status_handler))
        .route(
            "/api/llm/llm_get_provider_configs",
            post(llm_get_provider_configs_handler),
        )
        .route("/api/llm/llm_set_setting", post(llm_set_setting_handler))
        .route(
            "/api/llm/llm_list_available_models",
            post(llm_list_available_models_handler),
        )
        .route(
            "/api/llm/llm_save_custom_models",
            post(llm_save_custom_models_handler),
        )
        .route(
            "/api/llm/llm_save_custom_providers",
            post(llm_save_custom_providers_handler),
        )
        .route(
            "/api/llm/llm_generate_title",
            post(llm_generate_title_handler),
        )
        .route("/api/llm/llm_stream_text", post(llm_stream_text_handler))
        .route(
            "/api/llm/stream-events/:request_id",
            get(llm_stream_events_handler),
        )
        // Scheduled tasks - thin HTTP proxy to scheduler module
        .route(
            "/api/scheduled-tasks/list_scheduled_tasks",
            post(scheduled_list_tasks),
        )
        .route(
            "/api/scheduled-tasks/create_scheduled_task",
            post(scheduled_create_task),
        )
        .route(
            "/api/scheduled-tasks/update_scheduled_task",
            post(scheduled_update_task),
        )
        .route(
            "/api/scheduled-tasks/delete_scheduled_task",
            post(scheduled_delete_task),
        )
        .route(
            "/api/scheduled-tasks/pause_scheduled_task",
            post(scheduled_pause_task),
        )
        .route(
            "/api/scheduled-tasks/resume_scheduled_task",
            post(scheduled_resume_task),
        )
        .route(
            "/api/scheduled-tasks/trigger_scheduled_task_now",
            post(scheduled_trigger_now),
        )
        .route(
            "/api/scheduled-tasks/list_scheduled_task_runs",
            post(scheduled_list_runs),
        )
        .route(
            "/api/scheduled-tasks/claim_scheduled_task_runs",
            post(scheduled_claim_runs),
        )
        .route(
            "/api/scheduled-tasks/report_scheduled_task_run_complete",
            post(scheduled_report_complete),
        )
        .route(
            "/api/scheduled-tasks/get_scheduled_task_stats",
            post(scheduled_get_stats),
        )
        .route(
            "/api/scheduled-tasks/preview_scheduled_task_cron",
            post(scheduled_preview_cron),
        )
        .route(
            "/api/scheduled-tasks/validate_scheduled_task_cron",
            post(scheduled_validate_cron),
        )
        .layer(cors_layer(&config))
        .with_state(Arc::new(state))
}

pub async fn serve(
    listener: tokio::net::TcpListener,
    state: ServerState,
) -> Result<(), std::io::Error> {
    axum::serve(listener, create_router(state)).await
}

// ============== Terminal WebSocket Handler ==============

/// WebSocket endpoint for terminal PTY sessions in web mode.
///
/// Protocol (JSON messages):
///
/// Client -> Server:
/// - `{ "type": "spawn", "cwd": "...", "cols": 80, "rows": 24, "preferredShell": null }`
/// - `{ "type": "write", "ptyId": "uuid", "data": "ls\n" }`
/// - `{ "type": "resize", "ptyId": "uuid", "cols": 120, "rows": 40 }`
/// - `{ "type": "kill", "ptyId": "uuid" }`
///
/// Server -> Client:
/// - `{ "type": "spawned", "ptyId": "uuid" }`
/// - `{ "type": "output", "ptyId": "uuid", "data": "..." }`
/// - `{ "type": "close", "ptyId": "uuid" }`
/// - `{ "type": "error", "message": "...", "ptyId?": "uuid" }`

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum TerminalClientMessage {
    Spawn {
        request_id: String,
        cwd: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
        preferred_shell: Option<String>,
    },
    Write {
        pty_id: String,
        data: String,
    },
    Resize {
        pty_id: String,
        cols: u16,
        rows: u16,
    },
    Kill {
        pty_id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum TerminalServerMessage {
    Spawned {
        request_id: String,
        pty_id: String,
    },
    Output {
        pty_id: String,
        data: String,
    },
    Close {
        pty_id: String,
    },
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pty_id: Option<String>,
    },
}

async fn terminal_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
) -> axum::response::Response {
    ws.on_upgrade(move |socket| handle_terminal_socket(socket, state.pty_manager.clone()))
}

async fn handle_terminal_socket(
    socket: WebSocket,
    pty_manager: Arc<talkcody_core::terminal::PtyManager>,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Channel for all outgoing messages to be sent over WebSocket
    let (outgoing_tx, mut outgoing_rx) =
        tokio::sync::mpsc::unbounded_channel::<TerminalServerMessage>();

    // Track all PTY IDs spawned on this connection for cleanup on disconnect
    let active_ptys: Arc<tokio::sync::Mutex<Vec<String>>> =
        Arc::new(tokio::sync::Mutex::new(Vec::new()));

    // Spawn the send loop: forwards all outgoing messages to the WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(msg) = outgoing_rx.recv().await {
            let json = match serde_json::to_string(&msg) {
                Ok(j) => j,
                Err(_) => continue,
            };
            #[allow(clippy::useless_conversion)]
            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                break; // WebSocket closed
            }
        }
    });

    // Receive loop: handle client messages
    loop {
        let msg = ws_rx.next().await;

        match msg {
            Some(Ok(Message::Text(text))) => {
                handle_client_text_message(&text, &pty_manager, &active_ptys, &outgoing_tx).await;
            }
            Some(Ok(Message::Close(_))) | None => {
                break;
            }
            _ => {}
        }
    }

    // Clean up all PTY sessions spawned on this connection
    let ptys_to_kill = active_ptys.lock().await.clone();
    pty_manager.kill_all(&ptys_to_kill);
    send_task.abort();
    log::info!(
        "[terminal-ws] Cleaned up {} PTY sessions on disconnect",
        ptys_to_kill.len()
    );
}

async fn handle_client_text_message(
    text: &str,
    pty_manager: &Arc<talkcody_core::terminal::PtyManager>,
    active_ptys: &Arc<tokio::sync::Mutex<Vec<String>>>,
    outgoing_tx: &tokio::sync::mpsc::UnboundedSender<TerminalServerMessage>,
) {
    let client_msg = match serde_json::from_str::<TerminalClientMessage>(text) {
        Ok(msg) => msg,
        Err(e) => {
            let _ = outgoing_tx.send(TerminalServerMessage::Error {
                message: format!("Invalid message: {}", e),
                pty_id: None,
            });
            return;
        }
    };

    match client_msg {
        TerminalClientMessage::Spawn {
            request_id,
            cwd,
            cols,
            rows,
            preferred_shell,
        } => {
            match pty_manager.spawn(
                cwd.as_deref(),
                cols.unwrap_or(80),
                rows.unwrap_or(24),
                preferred_shell.as_deref(),
            ) {
                Ok((pty_id, mut output_rx)) => {
                    // Track the pty for cleanup
                    active_ptys.lock().await.push(pty_id.clone());

                    // Send spawned confirmation with request_id for correlation
                    let _ = outgoing_tx.send(TerminalServerMessage::Spawned {
                        request_id,
                        pty_id: pty_id.clone(),
                    });

                    // Spawn a task to forward PTY output to the outgoing channel
                    let fwd_tx = outgoing_tx.clone();
                    let fwd_pty_id = pty_id.clone();
                    let fwd_active_ptys = active_ptys.clone();
                    let fwd_pty_manager = pty_manager.clone();
                    tokio::spawn(async move {
                        while let Some(output) = output_rx.recv().await {
                            if fwd_tx
                                .send(TerminalServerMessage::Output {
                                    pty_id: output.pty_id,
                                    data: output.data,
                                })
                                .is_err()
                            {
                                break;
                            }
                        }
                        // PTY process exited - send close message and clean up
                        let _ = fwd_tx.send(TerminalServerMessage::Close {
                            pty_id: fwd_pty_id.clone(),
                        });
                        fwd_active_ptys.lock().await.retain(|id| id != &fwd_pty_id);
                        let _ = fwd_pty_manager.kill(&fwd_pty_id);
                    });
                }
                Err(e) => {
                    let _ = outgoing_tx.send(TerminalServerMessage::Error {
                        message: e,
                        pty_id: None,
                    });
                }
            }
        }
        TerminalClientMessage::Write { pty_id, data } => {
            if let Err(e) = pty_manager.write(&pty_id, &data) {
                let _ = outgoing_tx.send(TerminalServerMessage::Error {
                    message: e,
                    pty_id: Some(pty_id),
                });
            }
        }
        TerminalClientMessage::Resize { pty_id, cols, rows } => {
            if let Err(e) = pty_manager.resize(&pty_id, cols, rows) {
                let _ = outgoing_tx.send(TerminalServerMessage::Error {
                    message: e,
                    pty_id: Some(pty_id),
                });
            }
        }
        TerminalClientMessage::Kill { pty_id } => {
            let _ = pty_manager.kill(&pty_id);
            active_ptys.lock().await.retain(|id| id != &pty_id);
        }
    }
}
fn cors_layer(config: &ServerConfig) -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);

    if config.allowed_origins.is_empty() {
        layer.allow_origin(Any)
    } else {
        layer.allow_origin(
            config
                .allowed_origins
                .iter()
                .filter_map(|origin| origin.parse().ok())
                .collect::<Vec<_>>(),
        )
    }
}

/// Proxy fetch handler - forwards HTTP requests through the server to bypass CORS
/// Used by web mode where the browser cannot directly access external APIs
async fn proxy_fetch_handler(
    Json(request): Json<ProxyRequest>,
) -> Result<Json<ProxyResponse>, ErrorResponse> {
    core_proxy_fetch(request)
        .await
        .map(Json)
        .map_err(ErrorResponse::bad_request)
}

/// Register custom provider handler - saves config and registers in the provider registry
/// Accepts { config: CustomProviderConfig } body to match the Tauri command args format
#[derive(Deserialize)]
struct RegisterCustomProviderRequest {
    config: CustomProviderConfig,
}

async fn llm_register_custom_provider(
    State(state): State<Arc<ServerState>>,
    Json(request): Json<RegisterCustomProviderRequest>,
) -> Result<Json<()>, ErrorResponse> {
    let config = request.config;
    let runtime = state.runtime();
    let api_key_manager = runtime.api_key_manager();
    let provider_registry = runtime.provider_registry();

    let mut current = api_key_manager
        .load_custom_providers()
        .await
        .map_err(ErrorResponse::bad_request)?;
    let provider_id = config.id.clone();
    let provider_name = config.name.clone();
    let provider_type = config.provider_type.clone();
    let base_url = config.base_url.clone();
    current.providers.insert(provider_id.clone(), config);
    api_key_manager
        .save_custom_providers(&current)
        .await
        .map_err(ErrorResponse::bad_request)?;

    let mut registry = provider_registry.clone();
    registry.register_provider(ProviderConfig {
        id: provider_id.clone(),
        name: provider_name,
        protocol: match provider_type {
            CustomProviderType::Anthropic => ProtocolType::Claude,
            CustomProviderType::OpenAiCompatible => ProtocolType::OpenAiCompatible,
        },
        base_url,
        api_key_name: format!("custom_{}", provider_id),
        supports_oauth: false,
        supports_coding_plan: false,
        supports_international: false,
        coding_plan_base_url: None,
        international_base_url: None,
        headers: None,
        extra_body: None,
        auth_type: talkcody_core::llm::types::AuthType::Bearer,
    });

    Ok(Json(()))
}

// --- LLM OAuth Status ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthProviderStatus {
    expires_at: Option<i64>,
    account_id: Option<String>,
    is_connected: Option<bool>,
    has_refresh_token: Option<bool>,
}

#[derive(Serialize)]
struct OAuthStatusResponse {
    anthropic: Option<OAuthProviderStatus>,
    openai: Option<OAuthProviderStatus>,
    #[serde(rename = "githubCopilot")]
    github_copilot: Option<OAuthProviderStatus>,
}

async fn llm_oauth_status_handler(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<OAuthStatusResponse>, ErrorResponse> {
    let api_key_manager = state.runtime().api_key_manager();

    // OpenAI
    let openai_access = api_key_manager
        .get_setting("openai_oauth_access_token")
        .await
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    let openai_refresh = api_key_manager
        .get_setting("openai_oauth_refresh_token")
        .await
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    let openai_expires = api_key_manager
        .get_setting("openai_oauth_expires_at")
        .await
        .ok()
        .flatten()
        .and_then(|s| s.parse::<i64>().ok());
    let openai_account = api_key_manager
        .get_setting("openai_oauth_account_id")
        .await
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    let openai = if openai_access.is_some() || openai_refresh.is_some() {
        Some(OAuthProviderStatus {
            expires_at: openai_expires,
            account_id: openai_account,
            is_connected: Some(true),
            has_refresh_token: Some(openai_refresh.is_some()),
        })
    } else {
        None
    };

    // Anthropic (Claude)
    let anthropic_access = api_key_manager
        .get_setting("claude_oauth_access_token")
        .await
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    let anthropic_refresh = api_key_manager
        .get_setting("claude_oauth_refresh_token")
        .await
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    let anthropic_expires = api_key_manager
        .get_setting("claude_oauth_expires_at")
        .await
        .ok()
        .flatten()
        .and_then(|s| s.parse::<i64>().ok());
    let anthropic = if anthropic_access.is_some() || anthropic_refresh.is_some() {
        Some(OAuthProviderStatus {
            expires_at: anthropic_expires,
            account_id: None,
            is_connected: Some(true),
            has_refresh_token: Some(anthropic_refresh.is_some()),
        })
    } else {
        None
    };

    // GitHub Copilot
    let gh_access = api_key_manager
        .get_setting("github_copilot_oauth_access_token")
        .await
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    let gh_refresh = api_key_manager
        .get_setting("github_copilot_oauth_refresh_token")
        .await
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    let gh_expires = api_key_manager
        .get_setting("github_copilot_oauth_expires_at")
        .await
        .ok()
        .flatten()
        .and_then(|s| s.parse::<i64>().ok());
    let gh_account = api_key_manager
        .get_setting("github_copilot_oauth_account_id")
        .await
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    let github_copilot = if gh_access.is_some() || gh_refresh.is_some() {
        Some(OAuthProviderStatus {
            expires_at: gh_expires,
            account_id: gh_account,
            is_connected: Some(true),
            has_refresh_token: Some(gh_refresh.is_some()),
        })
    } else {
        None
    };

    Ok(Json(OAuthStatusResponse {
        openai,
        anthropic,
        github_copilot,
    }))
}

// --- LLM Get Provider Configs ---

async fn llm_get_provider_configs_handler(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<ProviderConfig>>, ErrorResponse> {
    let registry = state.runtime().provider_registry();
    let mut configs = registry.providers();

    // Also include custom providers from filesystem
    let api_key_manager = state.runtime().api_key_manager();
    if let Ok(custom_config) = api_key_manager.load_custom_providers().await {
        for (provider_id, cp) in custom_config.providers {
            if cp.enabled {
                configs.push(ProviderConfig {
                    id: provider_id,
                    name: cp.name,
                    protocol: match cp.provider_type {
                        CustomProviderType::Anthropic => ProtocolType::Claude,
                        CustomProviderType::OpenAiCompatible => ProtocolType::OpenAiCompatible,
                    },
                    base_url: cp.base_url,
                    api_key_name: format!("custom_{}", cp.id),
                    supports_oauth: false,
                    supports_coding_plan: false,
                    supports_international: false,
                    coding_plan_base_url: None,
                    international_base_url: None,
                    headers: None,
                    extra_body: None,
                    auth_type: talkcody_core::llm::types::AuthType::Bearer,
                });
            }
        }
    }

    Ok(Json(configs))
}

// --- LLM Set Setting ---

#[derive(Deserialize)]
struct SetSettingRequest {
    key: String,
    value: String,
}

async fn llm_set_setting_handler(
    State(state): State<Arc<ServerState>>,
    Json(request): Json<SetSettingRequest>,
) -> Result<Json<()>, ErrorResponse> {
    let api_key_manager = state.runtime().api_key_manager();
    api_key_manager
        .set_setting(&request.key, &request.value)
        .await
        .map_err(ErrorResponse::bad_request)?;
    Ok(Json(()))
}

// --- LLM List Available Models ---

async fn llm_list_available_models_handler(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<talkcody_core::llm::types::AvailableModel>>, ErrorResponse> {
    let api_key_manager = state.runtime().api_key_manager();
    let provider_registry = state.runtime().provider_registry();

    // Clone registry and register custom providers into it so their models are included
    let mut registry = provider_registry.clone();
    if let Ok(custom_config) = api_key_manager.load_custom_providers().await {
        for (provider_id, cp) in custom_config.providers {
            if cp.enabled {
                registry.register_provider(ProviderConfig {
                    id: provider_id,
                    name: cp.name,
                    protocol: match cp.provider_type {
                        CustomProviderType::Anthropic => ProtocolType::Claude,
                        CustomProviderType::OpenAiCompatible => ProtocolType::OpenAiCompatible,
                    },
                    base_url: cp.base_url,
                    api_key_name: format!("custom_{}", cp.id),
                    supports_oauth: false,
                    supports_coding_plan: false,
                    supports_international: false,
                    coding_plan_base_url: None,
                    international_base_url: None,
                    headers: None,
                    extra_body: None,
                    auth_type: talkcody_core::llm::types::AuthType::Bearer,
                });
            }
        }
    }

    let models =
        talkcody_core::llm::models::model_registry::ModelRegistry::compute_available_models(
            api_key_manager,
            &registry,
        )
        .await
        .map_err(ErrorResponse::bad_request)?;
    Ok(Json(models))
}

// --- LLM Save Custom Models ---

#[derive(Deserialize)]
struct SaveCustomModelsRequest {
    config: talkcody_core::llm::types::ModelsConfiguration,
}

async fn llm_save_custom_models_handler(
    State(state): State<Arc<ServerState>>,
    Json(request): Json<SaveCustomModelsRequest>,
) -> Result<Json<()>, ErrorResponse> {
    let api_key_manager = state.runtime().api_key_manager();
    api_key_manager
        .save_custom_models(&request.config)
        .await
        .map_err(ErrorResponse::bad_request)?;
    Ok(Json(()))
}

// --- LLM Save Custom Providers ---

#[derive(Deserialize)]
struct SaveCustomProvidersRequest {
    config: talkcody_core::llm::types::CustomProvidersConfiguration,
}

async fn llm_save_custom_providers_handler(
    State(state): State<Arc<ServerState>>,
    Json(request): Json<SaveCustomProvidersRequest>,
) -> Result<Json<()>, ErrorResponse> {
    let api_key_manager = state.runtime().api_key_manager();
    api_key_manager
        .save_custom_providers(&request.config)
        .await
        .map_err(ErrorResponse::bad_request)?;
    Ok(Json(()))
}

// --- LLM Generate Title ---

#[derive(Deserialize)]
struct GenerateTitleRequest {
    request: talkcody_core::llm::ai_services::types::TitleGenerationRequest,
}

#[derive(Serialize)]
struct TitleGenerationResult {
    title: String,
}

async fn llm_generate_title_handler(
    State(state): State<Arc<ServerState>>,
    Json(request): Json<GenerateTitleRequest>,
) -> Result<Json<TitleGenerationResult>, ErrorResponse> {
    let api_key_manager = state.runtime().api_key_manager();
    let provider_registry = state.runtime().provider_registry();

    // Register custom providers into cloned registry
    let mut registry = provider_registry.clone();
    if let Ok(custom_config) = api_key_manager.load_custom_providers().await {
        for (provider_id, cp) in custom_config.providers {
            if cp.enabled {
                registry.register_provider(ProviderConfig {
                    id: provider_id,
                    name: cp.name,
                    protocol: match cp.provider_type {
                        CustomProviderType::Anthropic => ProtocolType::Claude,
                        CustomProviderType::OpenAiCompatible => ProtocolType::OpenAiCompatible,
                    },
                    base_url: cp.base_url,
                    api_key_name: format!("custom_{}", cp.id),
                    supports_oauth: false,
                    supports_coding_plan: false,
                    supports_international: false,
                    coding_plan_base_url: None,
                    international_base_url: None,
                    headers: None,
                    extra_body: None,
                    auth_type: talkcody_core::llm::types::AuthType::Bearer,
                });
            }
        }
    }

    let service = talkcody_core::llm::ai_services::task_title_service::TaskTitleService::new();
    let result = service
        .generate_title(request.request, api_key_manager, &registry)
        .await
        .map_err(ErrorResponse::bad_request)?;

    Ok(Json(TitleGenerationResult {
        title: result.title,
    }))
}

// --- LLM Stream Text ---
// Web mode: spawns streaming task with BroadcastEmitter, returns request_id
// Frontend then connects to SSE endpoint to receive events

#[derive(Deserialize)]
struct StreamTextRequestWrapper {
    request: talkcody_core::llm::types::StreamTextRequest,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct StreamTextResponse {
    request_id: String,
}

async fn llm_stream_text_handler(
    State(state): State<Arc<ServerState>>,
    Json(request): Json<StreamTextRequestWrapper>,
) -> Result<Json<StreamTextResponse>, ErrorResponse> {
    let request_id = request.request.request_id.clone().unwrap_or_else(|| {
        static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        COUNTER
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            .to_string()
    });

    let api_key_manager = state.runtime().api_key_manager();
    let provider_registry = state.runtime().provider_registry();
    let stream_tx = state.stream_event_broadcast.clone();

    // Clone registry and register custom providers
    let mut registry = provider_registry.clone();
    if let Ok(custom_config) = api_key_manager.load_custom_providers().await {
        for (provider_id, cp) in custom_config.providers {
            if cp.enabled {
                registry.register_provider(ProviderConfig {
                    id: provider_id,
                    name: cp.name,
                    protocol: match cp.provider_type {
                        CustomProviderType::Anthropic => ProtocolType::Claude,
                        CustomProviderType::OpenAiCompatible => ProtocolType::OpenAiCompatible,
                    },
                    base_url: cp.base_url,
                    api_key_name: format!("custom_{}", cp.id),
                    supports_oauth: false,
                    supports_coding_plan: false,
                    supports_international: false,
                    coding_plan_base_url: None,
                    international_base_url: None,
                    headers: None,
                    extra_body: None,
                    auth_type: talkcody_core::llm::types::AuthType::Bearer,
                });
            }
        }
    }

    // Spawn the streaming task in background using BroadcastEmitter
    let handler = talkcody_core::llm::streaming::stream_handler::StreamHandler::new(
        registry,
        api_key_manager.clone(),
    );
    let emitter: talkcody_core::llm::streaming::emitter::BoxedEmitter =
        Arc::new(talkcody_core::llm::streaming::emitter::BroadcastEmitter::new(stream_tx));
    let rid = request_id.clone();

    tokio::spawn(async move {
        if let Err(e) = handler
            .stream_completion(emitter, None, request.request, rid)
            .await
        {
            log::error!("[llm_stream_text_server] Stream error: {}", e);
        }
    });

    Ok(Json(StreamTextResponse { request_id }))
}

// --- SSE Stream Events Endpoint ---
// Frontend connects here to receive stream events for a specific request

async fn llm_stream_events_handler(
    State(state): State<Arc<ServerState>>,
    Path(request_id): Path<String>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.stream_event_broadcast.subscribe();
    let event_name_prefix = format!("llm-stream-{}", request_id);

    let stream = tokio_stream::wrappers::BroadcastStream::new(rx).filter_map(move |result| {
        let prefix = event_name_prefix.clone();
        async move {
            match result {
                Ok(event) => {
                    // Only forward events for this request
                    if event.event.starts_with(&prefix) {
                        let data = serde_json::to_string(&event.payload).ok()?;
                        Some(Ok(Event::default().data(data)))
                    } else {
                        None
                    }
                }
                Err(_) => None,
            }
        }
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn build_directory_tree(
    Json(request): Json<BuildDirectoryTreeRequest>,
) -> Result<Json<directory_tree::FileNode>, ErrorResponse> {
    directory_tree::build_directory_tree(request.root_path, request.max_immediate_depth)
        .map(Json)
        .map_err(ErrorResponse::bad_request)
}

async fn load_directory_children(
    Json(request): Json<LoadDirectoryChildrenRequest>,
) -> Result<Json<Vec<directory_tree::FileNode>>, ErrorResponse> {
    directory_tree::load_directory_children(request.dir_path)
        .map(Json)
        .map_err(ErrorResponse::bad_request)
}

async fn clear_directory_cache() -> StatusCode {
    directory_tree::clear_directory_cache();
    StatusCode::NO_CONTENT
}

async fn invalidate_directory_path(
    Json(request): Json<InvalidateDirectoryPathRequest>,
) -> StatusCode {
    directory_tree::invalidate_directory_path(request.path);
    StatusCode::NO_CONTENT
}

async fn list_project_files(
    Json(request): Json<ListProjectFilesRequest>,
) -> Result<Json<String>, ErrorResponse> {
    list_files::list_project_files(
        request.directory_path,
        request.recursive,
        request.max_depth,
        request.max_files,
    )
    .map(Json)
    .map_err(ErrorResponse::bad_request)
}

async fn search_files(
    Json(request): Json<SearchFilesRequest>,
) -> Result<Json<Vec<file_search::FileSearchResult>>, ErrorResponse> {
    file_search::HighPerformanceFileSearch::new()
        .with_max_results(request.max_results.unwrap_or(200))
        .search_files(&request.root_path, &request.query)
        .map(Json)
        .map_err(ErrorResponse::bad_request)
}

async fn search_files_by_glob(
    Json(request): Json<SearchFilesByGlobRequest>,
) -> Result<Json<Vec<glob::GlobResult>>, ErrorResponse> {
    glob::search_files_by_glob(request.pattern, request.path, request.max_results)
        .map(Json)
        .map_err(ErrorResponse::bad_request)
}

async fn search_file_content(
    Json(request): Json<SearchFileContentRequest>,
) -> Result<Json<Vec<search::SearchResult>>, ErrorResponse> {
    search::RipgrepSearch::new()
        .with_max_results(50)
        .with_max_matches_per_file(10)
        .with_file_types(request.file_types)
        .with_exclude_dirs(request.exclude_dirs)
        .search_content(&request.query, &request.root_path)
        .map(Json)
        .map_err(ErrorResponse::bad_request)
}

async fn read_text_file(
    Json(request): Json<ReadTextFileRequest>,
) -> Result<Json<String>, ErrorResponse> {
    tokio::fs::read_to_string(&request.path)
        .await
        .map(Json)
        .map_err(|e| ErrorResponse::bad_request(format!("Failed to read file: {}", e)))
}

async fn write_text_file(
    Json(request): Json<WriteTextFileRequest>,
) -> Result<StatusCode, ErrorResponse> {
    if let Some(parent) = std::path::Path::new(&request.path).parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            ErrorResponse::bad_request(format!("Failed to create directory: {}", e))
        })?;
    }
    tokio::fs::write(&request.path, &request.content)
        .await
        .map_err(|e| ErrorResponse::bad_request(format!("Failed to write file: {}", e)))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn check_file_exists(Json(request): Json<CheckFileExistsRequest>) -> Json<bool> {
    Json(std::path::Path::new(&request.path).exists())
}

async fn execute_git_command(args: &[String], cwd: Option<&str>) -> Result<ShellResult, String> {
    let mut command = shell_utils::new_git_async_command();
    for arg in args {
        command.arg(arg);
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }

    let output = command
        .output()
        .await
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    Ok(ShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code().unwrap_or(-1),
        timed_out: false,
        idle_timed_out: false,
        pid: None,
    })
}

async fn execute_shell_command(command: &str, cwd: Option<&str>) -> Result<ShellResult, String> {
    #[cfg(unix)]
    let mut shell_command = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut cmd = shell_utils::new_async_command(&shell);
        cmd.arg("-l").arg("-i").arg("-c").arg(command);
        cmd
    };

    #[cfg(windows)]
    let mut shell_command = {
        let shell = shell_utils::get_windows_shell();
        let mut cmd = shell_utils::new_async_command(&shell);
        if shell_utils::is_powershell(&shell) {
            cmd.arg("-NoProfile").arg("-Command").arg(command);
        } else {
            cmd.arg("/C").arg(command);
        }
        cmd
    };

    if let Some(cwd) = cwd {
        shell_command.current_dir(cwd);
    }

    let output = shell_command
        .output()
        .await
        .map_err(|e| format!("Failed to execute shell command: {}", e))?;

    Ok(ShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code().unwrap_or(-1),
        timed_out: false,
        idle_timed_out: false,
        pid: None,
    })
}

async fn git_command(
    Json(request): Json<GitCommandRequest>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    let result = match request.command.as_str() {
        "execute_git" => {
            let args: Vec<String> = serde_json::from_value(request.args["args"].clone())
                .map_err(|e| ErrorResponse::bad_request(e.to_string()))?;
            let cwd = request.args["cwd"].as_str();
            serde_json::to_value(
                execute_git_command(&args, cwd)
                    .await
                    .map_err(ErrorResponse::bad_request)?,
            )
            .map_err(|e| ErrorResponse::bad_request(e.to_string()))?
        }
        "execute_user_shell" => {
            let command = request.args["command"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("command required".into()))?;
            let cwd = request.args["cwd"].as_str();
            serde_json::to_value(
                execute_shell_command(command, cwd)
                    .await
                    .map_err(ErrorResponse::bad_request)?,
            )
            .map_err(|e| ErrorResponse::bad_request(e.to_string()))?
        }
        "git_get_status" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            serde_json::to_value(
                git::git_get_status(repo_path.to_string())
                    .await
                    .map_err(ErrorResponse::bad_request)?,
            )
            .map_err(|e| ErrorResponse::bad_request(e.to_string()))?
        }
        "git_is_repository" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            serde_json::to_value(
                git::git_is_repository(repo_path.to_string())
                    .await
                    .map_err(ErrorResponse::bad_request)?,
            )
            .map_err(|e| ErrorResponse::bad_request(e.to_string()))?
        }
        "git_get_all_file_statuses" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            serde_json::to_value(
                git::git_get_all_file_statuses(repo_path.to_string())
                    .await
                    .map_err(ErrorResponse::bad_request)?,
            )
            .map_err(|e| ErrorResponse::bad_request(e.to_string()))?
        }
        "git_get_line_changes" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            let file_path = request.args["filePath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("filePath required".into()))?;
            serde_json::to_value(
                git::git_get_line_changes(repo_path.to_string(), file_path.to_string())
                    .await
                    .map_err(ErrorResponse::bad_request)?,
            )
            .map_err(|e| ErrorResponse::bad_request(e.to_string()))?
        }
        "git_get_all_file_diffs" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            serde_json::to_value(
                git::git_get_all_file_diffs(repo_path.to_string())
                    .await
                    .map_err(ErrorResponse::bad_request)?,
            )
            .map_err(|e| ErrorResponse::bad_request(e.to_string()))?
        }
        "git_get_raw_diff_text" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            serde_json::to_value(
                git::git_get_raw_diff_text(repo_path.to_string())
                    .await
                    .map_err(ErrorResponse::bad_request)?,
            )
            .map_err(|e| ErrorResponse::bad_request(e.to_string()))?
        }
        "git_get_staged_diff_text" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            serde_json::to_value(
                git::git_get_staged_diff_text(repo_path.to_string())
                    .await
                    .map_err(ErrorResponse::bad_request)?,
            )
            .map_err(|e| ErrorResponse::bad_request(e.to_string()))?
        }
        "git_stage_files" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            let file_paths: Vec<String> = serde_json::from_value(request.args["filePaths"].clone())
                .map_err(|e| ErrorResponse::bad_request(e.to_string()))?;
            git::git_stage_files(repo_path.to_string(), file_paths)
                .await
                .map_err(ErrorResponse::bad_request)?;
            serde_json::Value::Null
        }
        "git_unstage_files" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            let file_paths: Vec<String> = serde_json::from_value(request.args["filePaths"].clone())
                .map_err(|e| ErrorResponse::bad_request(e.to_string()))?;
            git::git_unstage_files(repo_path.to_string(), file_paths)
                .await
                .map_err(ErrorResponse::bad_request)?;
            serde_json::Value::Null
        }
        "git_commit" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            let message = request.args["message"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("message required".into()))?;
            serde_json::to_value(
                git::git_commit(repo_path.to_string(), message.to_string())
                    .await
                    .map_err(ErrorResponse::bad_request)?,
            )
            .map_err(|e| ErrorResponse::bad_request(e.to_string()))?
        }
        "git_stage_all" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            git::git_stage_all(repo_path.to_string())
                .await
                .map_err(ErrorResponse::bad_request)?;
            serde_json::Value::Null
        }
        "git_discard_changes" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            let file_path = request.args["filePath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("filePath required".into()))?;
            git::git_discard_changes(repo_path.to_string(), file_path.to_string())
                .await
                .map_err(ErrorResponse::bad_request)?;
            serde_json::Value::Null
        }
        "git_get_branches" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            serde_json::to_value(
                git::git_get_branches(repo_path.to_string())
                    .await
                    .map_err(ErrorResponse::bad_request)?,
            )
            .map_err(|e| ErrorResponse::bad_request(e.to_string()))?
        }
        "git_checkout_branch" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            let branch_name = request.args["branchName"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("branchName required".into()))?;
            git::git_checkout_branch(repo_path.to_string(), branch_name.to_string())
                .await
                .map_err(ErrorResponse::bad_request)?;
            serde_json::Value::Null
        }
        "git_create_branch" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            let branch_name = request.args["branchName"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("branchName required".into()))?;
            let start_point = request.args["startPoint"].as_str().map(|s| s.to_string());
            git::git_create_branch(repo_path.to_string(), branch_name.to_string(), start_point)
                .await
                .map_err(ErrorResponse::bad_request)?;
            serde_json::Value::Null
        }
        "git_get_file_content_at_head" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            let file_path = request.args["filePath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("filePath required".into()))?;
            serde_json::to_value(
                git::git_get_file_content_at_head(repo_path.to_string(), file_path.to_string())
                    .await
                    .map_err(ErrorResponse::bad_request)?,
            )
            .map_err(|e| ErrorResponse::bad_request(e.to_string()))?
        }
        "git_fetch" => {
            let repo_path = request.args["repoPath"]
                .as_str()
                .ok_or_else(|| ErrorResponse::bad_request("repoPath required".into()))?;
            let remote = request.args["remote"].as_str().map(|s| s.to_string());
            serde_json::to_value(
                git::git_fetch(repo_path.to_string(), remote)
                    .await
                    .map_err(ErrorResponse::bad_request)?,
            )
            .map_err(|e| ErrorResponse::bad_request(e.to_string()))?
        }
        _ => {
            return Err(ErrorResponse::bad_request(format!(
                "Unknown git command: {}",
                request.command
            )))
        }
    };
    Ok(Json(result))
}

async fn db_execute(
    State(state): State<Arc<ServerState>>,
    Json(request): Json<DbExecuteRequest>,
) -> Result<Json<QueryResult>, ErrorResponse> {
    state
        .storage()
        .chat_history
        .get_db()
        .execute(&request.sql, request.params)
        .await
        .map(Json)
        .map_err(ErrorResponse::bad_request)
}

async fn db_query(
    State(state): State<Arc<ServerState>>,
    Json(request): Json<DbQueryRequest>,
) -> Result<Json<QueryResult>, ErrorResponse> {
    state
        .storage()
        .chat_history
        .get_db()
        .query(&request.sql, request.params)
        .await
        .map(Json)
        .map_err(ErrorResponse::bad_request)
}

async fn db_batch(
    State(state): State<Arc<ServerState>>,
    Json(request): Json<DbBatchRequest>,
) -> Result<Json<Vec<QueryResult>>, ErrorResponse> {
    state
        .storage()
        .chat_history
        .get_db()
        .batch(request.statements)
        .await
        .map(Json)
        .map_err(ErrorResponse::bad_request)
}

async fn start_task(
    State(state): State<Arc<ServerState>>,
    Json(input): Json<TaskInput>,
) -> Result<Json<StartTaskResponse>, ErrorResponse> {
    let handle = state
        .runtime()
        .start_task(input)
        .await
        .map_err(ErrorResponse::bad_request)?;
    Ok(Json(StartTaskResponse {
        task_id: handle.task_id,
        session_id: handle.session_id,
    }))
}

async fn send_action(
    State(state): State<Arc<ServerState>>,
    Path(task_id): Path<String>,
    Json(request): Json<TaskActionRequest>,
) -> Result<StatusCode, ErrorResponse> {
    let handle = state
        .runtime()
        .get_task(&task_id)
        .await
        .ok_or_else(|| ErrorResponse::not_found(format!("Task '{}' not found", task_id)))?;

    handle
        .send_action(request.action)
        .map_err(ErrorResponse::bad_request)?;

    Ok(StatusCode::NO_CONTENT)
}

async fn cancel_task(
    State(state): State<Arc<ServerState>>,
    Path(task_id): Path<String>,
) -> Result<StatusCode, ErrorResponse> {
    state
        .runtime()
        .cancel_task(&task_id)
        .await
        .map_err(ErrorResponse::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_task_state(
    State(state): State<Arc<ServerState>>,
    Path(task_id): Path<String>,
) -> Json<TaskStateResponse> {
    let state = match state.runtime().get_task(&task_id).await {
        Some(handle) => Some(*handle.state.read().await),
        None => None,
    };

    Json(TaskStateResponse { state })
}

async fn task_events(
    State(state): State<Arc<ServerState>>,
    Path(task_id): Path<String>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let session_id = state
        .runtime()
        .get_task(&task_id)
        .await
        .map(|handle| handle.session_id);

    runtime_events(state, move |event| {
        runtime_event_belongs_to_task(event, &task_id)
            || session_id
                .as_deref()
                .is_some_and(|session_id| runtime_event_belongs_to_session(event, session_id))
    })
}

async fn session_events(
    State(state): State<Arc<ServerState>>,
    Path(session_id): Path<String>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    runtime_events(state, move |event| {
        runtime_event_belongs_to_session(event, &session_id)
    })
}

fn runtime_events(
    state: Arc<ServerState>,
    filter: impl Fn(&RuntimeEvent) -> bool + Clone + Send + 'static,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(state.event_broadcast.subscribe()).filter_map(move |event| {
        let filter = filter.clone();
        async move {
            let event = match event {
                Ok(event) => event,
                Err(error) => {
                    log::warn!("[server] runtime event stream skipped event: {}", error);
                    return None;
                }
            };

            if !filter(&event) {
                return None;
            }

            match serde_json::to_string(&event) {
                Ok(data) => Some(Ok(Event::default().event("runtime-event").data(data))),
                Err(error) => {
                    log::error!("[server] failed to serialize runtime event: {}", error);
                    None
                }
            }
        }
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}

fn runtime_event_belongs_to_task(event: &RuntimeEvent, task_id: &str) -> bool {
    match event {
        RuntimeEvent::TaskStateChanged {
            task_id: event_task_id,
            ..
        }
        | RuntimeEvent::ToolCallRequested {
            task_id: event_task_id,
            ..
        }
        | RuntimeEvent::ToolCallStarted {
            task_id: event_task_id,
            ..
        }
        | RuntimeEvent::ToolCallCompleted {
            task_id: event_task_id,
            ..
        }
        | RuntimeEvent::TaskCompleted {
            task_id: event_task_id,
            ..
        } => event_task_id == task_id,
        RuntimeEvent::Error {
            task_id: Some(event_task_id),
            ..
        } => event_task_id == task_id,
        _ => false,
    }
}

fn runtime_event_belongs_to_session(event: &RuntimeEvent, session_id: &str) -> bool {
    match event {
        RuntimeEvent::MessageCreated {
            session_id: event_session_id,
            ..
        }
        | RuntimeEvent::Token {
            session_id: event_session_id,
            ..
        }
        | RuntimeEvent::ReasoningStart {
            session_id: event_session_id,
            ..
        }
        | RuntimeEvent::ReasoningDelta {
            session_id: event_session_id,
            ..
        }
        | RuntimeEvent::ReasoningEnd {
            session_id: event_session_id,
            ..
        }
        | RuntimeEvent::Usage {
            session_id: event_session_id,
            ..
        }
        | RuntimeEvent::Done {
            session_id: event_session_id,
            ..
        }
        | RuntimeEvent::TaskCompleted {
            session_id: event_session_id,
            ..
        } => event_session_id == session_id,
        RuntimeEvent::Error {
            session_id: Some(event_session_id),
            ..
        } => event_session_id == session_id,
        _ => false,
    }
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: String,
}

#[derive(Debug)]
struct ErrorResponse {
    status: StatusCode,
    message: String,
}

impl ErrorResponse {
    fn bad_request(message: String) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message,
        }
    }

    fn not_found(message: String) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message,
        }
    }
}

impl IntoResponse for ErrorResponse {
    fn into_response(self) -> axum::response::Response {
        let mut headers = HeaderMap::new();
        headers.insert(
            "content-type",
            "application/json".parse().expect("valid header value"),
        );
        (
            self.status,
            headers,
            Json(ErrorBody {
                error: self.message,
            }),
        )
            .into_response()
    }
}

// ============== Scheduled Tasks HTTP handlers ==============
// Thin wrappers around the scheduler module functions that are normally
// exposed as Tauri commands. These allow the web client to call the same
// logic over HTTP.

fn scheduled_repo(state: &ServerState) -> ScheduledTaskRepository {
    ScheduledTaskRepository::new(state.storage().chat_history.get_db())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledListTasksRequest {
    project_id: Option<String>,
}

async fn scheduled_list_tasks(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<ScheduledListTasksRequest>,
) -> Result<Json<Vec<ScheduledTask>>, ErrorResponse> {
    let repo = scheduled_repo(&state);
    repo.list(req.project_id.as_deref())
        .await
        .map(Json)
        .map_err(ErrorResponse::bad_request)
}

async fn scheduled_create_task(
    State(state): State<Arc<ServerState>>,
    Json(request): Json<CreateScheduledTaskRequest>,
) -> Result<Json<ScheduledTask>, ErrorResponse> {
    if let ScheduledTaskSchedule::Cron { expr, tz } = &request.schedule {
        validate_cron_expr(expr).map_err(ErrorResponse::bad_request)?;
        if let Some(tz_str) = tz {
            validate_timezone(tz_str).map_err(ErrorResponse::bad_request)?;
        }
    }
    let repo = scheduled_repo(&state);
    let now_ms = now_unix_ms();
    let id = Uuid::new_v4().to_string();
    let next_run_at =
        compute_next_run_at(&request.schedule, &request.execution_policy, now_ms, &id).ok();
    let task = ScheduledTask {
        id: id.clone(),
        name: request.name,
        description: request.description,
        project_id: request.project_id,
        schedule: request.schedule,
        schedule_nl_text: request.schedule_nl_text,
        payload: request.payload,
        execution_policy: request.execution_policy,
        retry_policy: request.retry_policy,
        notification_policy: request.notification_policy,
        delivery_policy: request.delivery_policy,
        offline_policy: request.offline_policy,
        status: JobStatus::Enabled,
        next_run_at,
        last_run_at: None,
        paused_at: None,
        created_at: now_ms,
        updated_at: now_ms,
    };
    repo.create(&task)
        .await
        .map_err(ErrorResponse::bad_request)?;
    Ok(Json(task))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledUpdateRequest {
    id: String,
    request: UpdateScheduledTaskRequest,
}

async fn scheduled_update_task(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<ScheduledUpdateRequest>,
) -> Result<Json<ScheduledTask>, ErrorResponse> {
    // Reuse the same logic as the Tauri command
    let repo = scheduled_repo(&state);
    let existing = repo
        .find_by_id(&req.id)
        .await
        .map_err(ErrorResponse::bad_request)?
        .ok_or_else(|| ErrorResponse::not_found(format!("Task not found: {}", req.id)))?;
    let now_ms = now_unix_ms();
    let new_schedule = req
        .request
        .schedule
        .clone()
        .unwrap_or(existing.schedule.clone());
    let new_exec_policy = req
        .request
        .execution_policy
        .clone()
        .unwrap_or(existing.execution_policy.clone());
    let next_run_at = if req.request.schedule.is_some() || req.request.execution_policy.is_some() {
        compute_next_run_at(&new_schedule, &new_exec_policy, now_ms, &req.id).ok()
    } else {
        existing.next_run_at
    };
    let updated = ScheduledTask {
        id: existing.id.clone(),
        name: req.request.name.unwrap_or(existing.name),
        description: req.request.description.or(existing.description),
        project_id: req.request.project_id.unwrap_or(existing.project_id),
        schedule: new_schedule,
        schedule_nl_text: req.request.schedule_nl_text.or(existing.schedule_nl_text),
        payload: req.request.payload.unwrap_or(existing.payload),
        execution_policy: new_exec_policy,
        retry_policy: req.request.retry_policy.unwrap_or(existing.retry_policy),
        notification_policy: req
            .request
            .notification_policy
            .unwrap_or(existing.notification_policy),
        delivery_policy: req
            .request
            .delivery_policy
            .unwrap_or(existing.delivery_policy),
        offline_policy: req
            .request
            .offline_policy
            .unwrap_or(existing.offline_policy),
        status: req.request.status.unwrap_or(existing.status),
        next_run_at,
        last_run_at: existing.last_run_at,
        paused_at: existing.paused_at,
        created_at: existing.created_at,
        updated_at: now_ms,
    };
    repo.update(&req.id, &updated)
        .await
        .map_err(ErrorResponse::bad_request)?;
    Ok(Json(updated))
}

#[derive(Debug, Deserialize)]
struct ScheduledIdRequest {
    id: String,
}

async fn scheduled_delete_task(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<ScheduledIdRequest>,
) -> Result<StatusCode, ErrorResponse> {
    let repo = scheduled_repo(&state);
    repo.delete(&req.id)
        .await
        .map_err(ErrorResponse::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn scheduled_pause_task(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<ScheduledIdRequest>,
) -> Result<Json<ScheduledTask>, ErrorResponse> {
    let repo = scheduled_repo(&state);
    repo.pause_task(&req.id)
        .await
        .map_err(ErrorResponse::bad_request)?;
    repo.find_by_id(&req.id)
        .await
        .map_err(ErrorResponse::bad_request)?
        .map(Json)
        .ok_or_else(|| ErrorResponse::not_found(format!("Task not found: {}", req.id)))
}

async fn scheduled_resume_task(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<ScheduledIdRequest>,
) -> Result<Json<ScheduledTask>, ErrorResponse> {
    let repo = scheduled_repo(&state);
    let existing = repo
        .find_by_id(&req.id)
        .await
        .map_err(ErrorResponse::bad_request)?
        .ok_or_else(|| ErrorResponse::not_found(format!("Task not found: {}", req.id)))?;
    let now_ms = now_unix_ms();
    let next_run_at = compute_next_run_at(
        &existing.schedule,
        &existing.execution_policy,
        now_ms,
        &req.id,
    )
    .ok();
    repo.resume_task(&req.id, next_run_at)
        .await
        .map_err(ErrorResponse::bad_request)?;
    repo.find_by_id(&req.id)
        .await
        .map_err(ErrorResponse::bad_request)?
        .map(Json)
        .ok_or_else(|| ErrorResponse::not_found(format!("Task not found: {}", req.id)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTriggerNowRequest {
    job_id: String,
}

async fn scheduled_trigger_now(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<ScheduledTriggerNowRequest>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    // In web/server mode we simply mark a run as queued; the scheduler tick
    // will pick it up.  We cannot emit Tauri events from the server.
    let repo = scheduled_repo(&state);
    let job = repo
        .find_by_id(&req.job_id)
        .await
        .map_err(ErrorResponse::bad_request)?
        .ok_or_else(|| ErrorResponse::not_found(format!("Task not found: {}", req.job_id)))?;
    let run_id = Uuid::new_v4().to_string();
    let run = ScheduledTaskRun {
        id: run_id.clone(),
        scheduled_task_id: job.id.clone(),
        task_id: None,
        status: RunStatus::Queued,
        triggered_at: now_unix_ms(),
        completed_at: None,
        error: None,
        attempt: 0,
        trigger_source: RunTriggerSource::Manual,
        scheduled_for_at: Some(now_unix_ms()),
        payload_snapshot_json: None,
        project_id_snapshot: job.project_id.clone(),
        delivery_status: None,
        delivery_error: None,
    };
    repo.create_run(&run)
        .await
        .map_err(ErrorResponse::bad_request)?;
    Ok(Json(serde_json::json!({ "runId": run_id })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledListRunsRequest {
    job_id: String,
    limit: Option<u32>,
}

async fn scheduled_list_runs(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<ScheduledListRunsRequest>,
) -> Result<Json<Vec<ScheduledTaskRun>>, ErrorResponse> {
    let repo = scheduled_repo(&state);
    repo.list_runs(&req.job_id, req.limit.unwrap_or(50))
        .await
        .map(Json)
        .map_err(ErrorResponse::bad_request)
}

async fn scheduled_claim_runs(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<ScheduledTaskRun>>, ErrorResponse> {
    let repo = scheduled_repo(&state);
    let runs = repo
        .list_queued_runs()
        .await
        .map_err(ErrorResponse::bad_request)?;
    Ok(Json(runs))
}

async fn scheduled_report_complete(
    State(state): State<Arc<ServerState>>,
    Json(payload): Json<RunCompletePayload>,
) -> Result<StatusCode, ErrorResponse> {
    let repo = scheduled_repo(&state);
    let status = if payload.success {
        RunStatus::Completed
    } else {
        RunStatus::Failed
    };
    repo.update_run_complete(
        &payload.run_id,
        &status,
        payload.task_id,
        payload.error,
        payload.delivery_status,
        payload.delivery_error,
    )
    .await
    .map_err(ErrorResponse::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn scheduled_get_stats(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<serde_json::Value>, ErrorResponse> {
    let repo = scheduled_repo(&state);
    repo.get_stats_summary()
        .await
        .map(Json)
        .map_err(ErrorResponse::bad_request)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledPreviewCronRequest {
    schedule: ScheduledTaskSchedule,
    execution_policy: ScheduledTaskExecutionPolicy,
    count: Option<usize>,
}

async fn scheduled_preview_cron(
    Json(req): Json<ScheduledPreviewCronRequest>,
) -> Result<Json<Vec<talkcody_core::scheduler::cron_utils::CronPreviewEntry>>, ErrorResponse> {
    preview_schedule(
        &req.schedule,
        &req.execution_policy,
        now_unix_ms(),
        req.count.unwrap_or(5),
        "preview",
    )
    .map(Json)
    .map_err(ErrorResponse::bad_request)
}

#[derive(Debug, Deserialize)]
struct ScheduledValidateCronRequest {
    expr: String,
}

async fn scheduled_validate_cron(
    Json(req): Json<ScheduledValidateCronRequest>,
) -> Result<StatusCode, ErrorResponse> {
    validate_cron_expr(&req.expr)
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(ErrorResponse::bad_request)
}

#[cfg(test)]
mod terminal_ws_tests {
    use super::*;

    #[test]
    fn test_client_message_deserialization_spawn() {
        let json = r#"{"type":"spawn","requestId":"abc123","cwd":"/tmp","cols":80,"rows":24,"preferredShell":"bash"}"#;
        let msg: TerminalClientMessage = serde_json::from_str(json).unwrap();
        match msg {
            TerminalClientMessage::Spawn {
                request_id,
                cwd,
                cols,
                rows,
                preferred_shell,
            } => {
                assert_eq!(request_id, "abc123");
                assert_eq!(cwd, Some("/tmp".to_string()));
                assert_eq!(cols, Some(80));
                assert_eq!(rows, Some(24));
                assert_eq!(preferred_shell, Some("bash".to_string()));
            }
            _ => panic!("Expected Spawn message"),
        }
    }

    #[test]
    fn test_client_message_deserialization_write() {
        let json = r#"{"type":"write","ptyId":"uuid-1","data":"ls\n"}"#;
        let msg: TerminalClientMessage = serde_json::from_str(json).unwrap();
        match msg {
            TerminalClientMessage::Write { pty_id, data } => {
                assert_eq!(pty_id, "uuid-1");
                assert_eq!(data, "ls\n");
            }
            _ => panic!("Expected Write message"),
        }
    }

    #[test]
    fn test_server_message_serialization_spawned() {
        let msg = TerminalServerMessage::Spawned {
            request_id: "abc123".to_string(),
            pty_id: "uuid-1".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"requestId\":\"abc123\""));
        assert!(json.contains("\"ptyId\":\"uuid-1\""));
        assert!(json.contains("\"type\":\"spawned\""));
    }

    #[test]
    fn test_server_message_serialization_output() {
        let msg = TerminalServerMessage::Output {
            pty_id: "uuid-1".to_string(),
            data: "hello".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"ptyId\":\"uuid-1\""));
        assert!(json.contains("\"type\":\"output\""));
    }

    #[test]
    fn test_server_message_serialization_error_optional_pty_id() {
        let msg = TerminalServerMessage::Error {
            message: "something went wrong".to_string(),
            pty_id: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(!json.contains("ptyId"));
        assert!(json.contains("\"message\":\"something went wrong\""));
    }

    #[test]
    fn test_server_message_serialization_error_with_pty_id() {
        let msg = TerminalServerMessage::Error {
            message: "session not found".to_string(),
            pty_id: Some("uuid-1".to_string()),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"ptyId\":\"uuid-1\""));
    }
}
