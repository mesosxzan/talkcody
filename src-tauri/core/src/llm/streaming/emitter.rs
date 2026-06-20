// Stream Emitter abstraction - decouples stream event delivery from tauri::Window
// Allows the same StreamHandler to work in both Tauri desktop and server (web) modes

use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::broadcast;

/// Trait for emitting stream events.
/// Implemented by TauriEmitter (desktop mode) and BroadcastEmitter (server/web mode).
#[async_trait]
pub trait StreamEmitter: Send + Sync {
    /// Emit an event with the given name and JSON payload
    async fn emit(&self, event: &str, payload: Value) -> Result<(), String>;
}

// ============================================================
// Tauri Emitter - wraps tauri::Window for desktop mode
// ============================================================

pub struct TauriEmitter {
    window: tauri::Window,
}

impl TauriEmitter {
    pub fn new(window: tauri::Window) -> Self {
        Self { window }
    }
}

#[async_trait]
impl StreamEmitter for TauriEmitter {
    async fn emit(&self, event: &str, payload: Value) -> Result<(), String> {
        use tauri::Emitter;
        self.window
            .emit(event, payload)
            .map_err(|e| format!("Failed to emit event: {}", e))
    }
}

// ============================================================
// Broadcast Emitter - uses tokio broadcast channel for server/web mode
// ============================================================

/// Event sent through the broadcast channel
#[derive(Debug, Clone, serde::Serialize)]
pub struct BroadcastEvent {
    pub event: String,
    pub payload: Value,
}

pub struct BroadcastEmitter {
    tx: broadcast::Sender<BroadcastEvent>,
}

impl BroadcastEmitter {
    pub fn new(tx: broadcast::Sender<BroadcastEvent>) -> Self {
        Self { tx }
    }
}

#[async_trait]
impl StreamEmitter for BroadcastEmitter {
    async fn emit(&self, event: &str, payload: Value) -> Result<(), String> {
        let stream_event = BroadcastEvent {
            event: event.to_string(),
            payload,
        };
        self.tx
            .send(stream_event)
            .map_err(|e| format!("Failed to broadcast event: {}", e))?;
        Ok(())
    }
}

// ============================================================
// Type-erased emitter for use in StreamHandler
// ============================================================

/// Type-erased box of StreamEmitter, allows StreamHandler to work with any emitter
pub type BoxedEmitter = Arc<dyn StreamEmitter>;

/// Helper to create a no-op emitter (for testing or when no events are needed)
pub struct NoopEmitter;

#[async_trait]
impl StreamEmitter for NoopEmitter {
    async fn emit(&self, _event: &str, _payload: Value) -> Result<(), String> {
        Ok(())
    }
}
