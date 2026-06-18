//! Tauri command bridge for CoreRuntime.
//!
//! Exposes `runtime_start_task`, `runtime_cancel_task`, and
//! `runtime_send_action` so the frontend can drive the Rust agent loop
//! instead of the TypeScript `LLMService.runAgentLoop()` path.

use talkcody_core::core::types::{RuntimeEvent, RuntimeTaskState, TaskAction, TaskInput};
use talkcody_server::ServerState;
use tauri::Emitter;

fn event_belongs_to_task(event: &RuntimeEvent, task_id: &str, session_id: &str) -> bool {
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
        } => event_task_id == task_id,
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
            task_id: event_task_id,
            session_id: event_session_id,
            ..
        } => {
            event_task_id.as_deref() == Some(task_id)
                || event_session_id.as_deref() == Some(session_id)
        }
    }
}

fn should_stop_forwarding(event: &RuntimeEvent, task_id: &str) -> bool {
    match event {
        RuntimeEvent::TaskCompleted {
            task_id: event_task_id,
            ..
        } => event_task_id == task_id,
        RuntimeEvent::TaskStateChanged {
            task_id: event_task_id,
            state,
            ..
        } => event_task_id == task_id && state.is_terminal(),
        _ => false,
    }
}

/// Start a runtime task.
///
/// The frontend calls this instead of `llmService.runAgentLoop()`.
/// Events are forwarded via Tauri's `window.emit("runtime-event", payload)`.
#[tauri::command]
pub async fn runtime_start_task(
    window: tauri::Window,
    state: tauri::State<'_, ServerState>,
    input: TaskInput,
) -> Result<String, String> {
    let handle = state.runtime().start_task(input).await?;
    let started_task_id = handle.task_id.clone();
    let started_session_id = handle.session_id.clone();

    // Subscribe to the broadcast channel and forward events to the frontend.
    let mut rx = state.event_broadcast.subscribe();
    let window_clone = window.clone();
    tauri::async_runtime::spawn(async move {
        let event_name = format!("runtime-event:{}", started_session_id);
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if event_belongs_to_task(&event, &started_task_id, &started_session_id) {
                        let _ = window_clone.emit(&event_name, &event);
                        if should_stop_forwarding(&event, &started_task_id) {
                            break;
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    log::warn!("[runtime_start_task] Event forwarder lagged by {n} events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });

    Ok(handle.task_id)
}

/// Cancel a running task.
#[tauri::command]
pub async fn runtime_cancel_task(
    state: tauri::State<'_, ServerState>,
    task_id: String,
) -> Result<(), String> {
    state.runtime().cancel_task(&task_id).await
}

/// Send an action (approve/reject/tool-result/cancel) to a waiting task.
#[tauri::command]
pub async fn runtime_send_action(
    state: tauri::State<'_, ServerState>,
    task_id: String,
    action: TaskAction,
) -> Result<(), String> {
    let handle = state
        .runtime()
        .get_task(&task_id)
        .await
        .ok_or_else(|| format!("Task '{}' not found", task_id))?;
    handle.send_action(action).map_err(|e| e.to_string())
}

/// Get the current state of a task.
#[tauri::command]
pub async fn runtime_get_task_state(
    state: tauri::State<'_, ServerState>,
    task_id: String,
) -> Result<Option<RuntimeTaskState>, String> {
    let handle = state.runtime().get_task(&task_id).await;
    match handle {
        Some(handle) => {
            let state = *handle.state.read().await;
            Ok(Some(state))
        }
        None => Ok(None),
    }
}
