//! Core Runtime
//!
//! The main runtime that orchestrates task execution and session management.
//! Owns the lifecycle of all runtime tasks.

use crate::core::completion_hooks::{
    AutoReviewHook, CompletionHookPipeline, HookContext, HookResult, RalphLoopHook, StopHook,
};
use crate::core::session::SessionManager;
use crate::core::tool_hooks::HookRunner;
use crate::core::tool_name_normalizer::normalize_tool_name;
use crate::core::tools::{
    ToolContext, ToolDispatchOutcome, ToolDispatchResult, ToolDispatcher, ToolRegistry,
};
use crate::core::types::*;
use crate::core::{
    CompletionLoopConfig, CompletionLoopManager, CompletionLoopState, CompletionStopReason,
    ToolExecutor,
};
use crate::llm::ai_services::model_resolver::{resolve_model_identifier, FallbackStrategy};
use crate::llm::auth::api_key_manager::ApiKeyManager;
use crate::llm::providers::provider_registry::ProviderRegistry;
use crate::llm::tracing::TraceWriter;
use crate::llm::types::{
    ContentPart, ConversationMode, InputMode, Message as LlmMessage,
    MessageContent as LlmMessageContent, ResponseMetadataProvider, ResponseTransport, StreamEvent,
    TraceContext, TransportFallbackTarget,
};
use crate::storage::{
    Attachment, AttachmentOrigin, Message, MessageContent, MessageRole, SessionId, SessionStatus,
    Storage, StoredToolResult, TaskSettings, ToolCall, ToolResultStatus, WorkspaceInfo,
};
use futures_util::future::BoxFuture;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, RwLock};

#[derive(Debug, Clone)]
struct ResolvedAgentConfig {
    model: String,
    system_prompt: Option<String>,
    available_tools: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct StreamIterationOutput {
    assistant_text: String,
    tool_calls: Vec<ToolRequest>,
    finish_reason: Option<String>,
    response_id: Option<String>,
    transport_session_id: Option<String>,
    response_transport: Option<ResponseTransport>,
    response_provider: Option<ResponseMetadataProvider>,
    continuation_accepted: Option<bool>,
    transport_fallback_target: Option<TransportFallbackTarget>,
    raw_chunks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolMessageAttachment {
    id: String,
    filename: String,
    file_path: String,
    mime_type: String,
    size: i64,
}

#[derive(Debug, Clone)]
struct ToolExecutionEnvelope {
    result: ToolResult,
    additional_context: Vec<String>,
}

#[derive(Debug)]
enum TaskTermination {
    Cancelled(String),
    Failed(String),
}

#[derive(Debug)]
enum ToolApproval {
    Approve,
    Reject(Option<String>),
    ProvidedResult(serde_json::Value),
}

const MAX_AUTO_CONTINUE_ATTEMPTS: u32 = 10;
const MAX_UNKNOWN_FINISH_REASON_RETRIES: u32 = 3;

fn is_truncation_finish_reason(reason: Option<&str>) -> bool {
    matches!(reason, Some("length" | "max_tokens"))
}

fn is_normal_finish_reason(reason: Option<&str>) -> bool {
    matches!(
        reason,
        Some("stop" | "end_turn" | "stop_sequence" | "tool_calls")
    )
}

/// Core runtime that manages all tasks and sessions
#[derive(Clone)]
#[allow(dead_code)]
pub struct CoreRuntime {
    /// Storage layer
    _storage: Storage,
    /// Session manager
    session_manager: Arc<SessionManager>,
    /// Active tasks
    tasks: Arc<RwLock<HashMap<RuntimeTaskId, TaskHandle>>>,
    /// Event broadcaster
    event_sender: EventSender,
    /// Settings for validation
    _settings_validator: SettingsValidator,
    /// Provider registry for LLM
    provider_registry: ProviderRegistry,
    /// API key manager
    api_key_manager: ApiKeyManager,
    /// Trace writer for runtime/tool spans
    trace_writer: Arc<TraceWriter>,
}

/// Settings validator
#[derive(Clone)]
pub struct SettingsValidator;

impl SettingsValidator {
    pub fn new() -> Self {
        Self
    }

    /// Validate task settings
    pub fn validate(&self, settings: &TaskSettings) -> SettingsValidation {
        let mut validation = SettingsValidation::valid();

        // Validate auto_approve_edits
        if settings.auto_approve_edits == Some(true) {
            validation.add_warning(
                "Auto-approve edits is enabled. This may allow unintended file modifications."
                    .to_string(),
            );
        }

        // Validate auto_approve_plan
        if settings.auto_approve_plan == Some(true) {
            validation.add_warning(
                "Auto-approve plan is enabled. The agent will execute plan steps without confirmation."
                    .to_string(),
            );
        }

        validation
    }
}

impl Default for SettingsValidator {
    fn default() -> Self {
        Self::new()
    }
}

impl CoreRuntime {
    /// Create a new CoreRuntime instance
    pub async fn new(
        storage: Storage,
        event_sender: EventSender,
        provider_registry: ProviderRegistry,
        api_key_manager: ApiKeyManager,
    ) -> Result<Self, String> {
        // Create session manager
        let session_manager = Arc::new(SessionManager::new(storage.clone()));
        let trace_writer = Arc::new(TraceWriter::new(storage.settings.get_db()));
        trace_writer.start();

        Ok(Self {
            _storage: storage,
            session_manager,
            tasks: Arc::new(RwLock::new(HashMap::new())),
            event_sender,
            _settings_validator: SettingsValidator::new(),
            provider_registry,
            api_key_manager,
            trace_writer,
        })
    }

    /// Start a new task
    pub async fn start_task(&self, input: TaskInput) -> Result<TaskHandle, String> {
        // Validate settings if provided
        if let Some(ref settings) = input.settings {
            let validation = self._settings_validator.validate(settings);
            if !validation.valid {
                return Err(format!(
                    "Invalid settings: {}",
                    validation.errors.join(", ")
                ));
            }
        }

        // Create or get session
        let session = if let Some(ref session_id) = self.find_session_for_task(&input) {
            if self
                .session_manager
                .get_session(session_id)
                .await?
                .is_some()
            {
                self.session_manager.activate_session(session_id).await?;
                self.session_manager
                    .get_session(session_id)
                    .await?
                    .ok_or("Session not found")?
            } else {
                self.session_manager
                    .create_session_with_id(
                        session_id.clone(),
                        input.project_id.clone(),
                        None,
                        input.settings.clone(),
                    )
                    .await?
            }
        } else {
            self.session_manager
                .create_session(input.project_id.clone(), None, input.settings.clone())
                .await?
        };

        let task_id = format!("task_{}", uuid::Uuid::new_v4().to_string().replace("-", ""));
        let now = chrono::Utc::now().timestamp();

        // Create task state
        let task = RuntimeTask {
            id: task_id.clone(),
            session_id: session.id.clone(),
            agent_id: input.agent_id.clone(),
            state: RuntimeTaskState::Pending,
            created_at: now,
            started_at: None,
            completed_at: None,
            error_message: None,
            metadata: HashMap::new(),
        };

        // Create action channel
        let (action_tx, action_rx) = mpsc::unbounded_channel();

        // Create task handle
        let task_state = Arc::new(RwLock::new(RuntimeTaskState::Pending));
        let handle = TaskHandle {
            task_id: task_id.clone(),
            session_id: session.id.clone(),
            state: task_state.clone(),
            action_sender: Arc::new(action_tx),
        };

        // Store task handle
        {
            let mut tasks = self.tasks.write().await;
            tasks.insert(task_id.clone(), handle.clone());
        }

        // Spawn task execution
        let runtime_clone = self.clone();
        let event_sender = self.event_sender.clone();

        tokio::spawn(async move {
            runtime_clone
                .run_task(task, input, task_state, action_rx, event_sender)
                .await;
        });

        Ok(handle)
    }

    /// Get a task handle by ID
    pub async fn get_task(&self, task_id: &str) -> Option<TaskHandle> {
        let tasks = self.tasks.read().await;
        tasks.get(task_id).cloned()
    }

    /// List all active tasks
    pub async fn list_active_tasks(&self) -> Vec<TaskHandle> {
        let tasks = self.tasks.read().await;
        tasks.values().cloned().collect()
    }

    /// Get read access to the tasks map (for Tauri command bridge)
    pub fn tasks_handle(&self) -> &Arc<RwLock<HashMap<RuntimeTaskId, TaskHandle>>> {
        &self.tasks
    }

    /// Cancel a task
    pub async fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        let handle = self
            .get_task(task_id)
            .await
            .ok_or_else(|| format!("Task '{}' not found", task_id))?;

        handle.cancel()?;
        Ok(())
    }

    /// Get session manager
    pub fn session_manager(&self) -> Arc<SessionManager> {
        self.session_manager.clone()
    }

    /// Main task execution loop powered by the Rust agent runtime.
    async fn run_task(
        &self,
        mut task: RuntimeTask,
        input: TaskInput,
        task_state: Arc<RwLock<RuntimeTaskState>>,
        action_rx: mpsc::UnboundedReceiver<TaskAction>,
        event_sender: EventSender,
    ) {
        // Update task state to running
        let now = chrono::Utc::now().timestamp();
        task.state = RuntimeTaskState::Running;
        task.started_at = Some(now);
        *task_state.write().await = RuntimeTaskState::Running;

        // Emit state change event
        let _ = event_sender.send(RuntimeEvent::TaskStateChanged {
            task_id: task.id.clone(),
            state: RuntimeTaskState::Running,
            previous_state: RuntimeTaskState::Pending,
        });

        if self
            .should_persist_initial_message(&task.session_id, &input.initial_message)
            .await
        {
            let initial_message = Message {
                id: format!("msg_{}", uuid::Uuid::new_v4()),
                session_id: task.session_id.clone(),
                role: MessageRole::User,
                content: MessageContent::Text {
                    text: input.initial_message.clone(),
                },
                created_at: now,
                tool_call_id: None,
                parent_id: None,
            };

            if let Err(e) = self
                .session_manager
                .add_message(initial_message.clone())
                .await
            {
                let _ = event_sender.send(RuntimeEvent::Error {
                    task_id: Some(task.id.clone()),
                    session_id: Some(task.session_id.clone()),
                    message: format!("Failed to add message: {}", e),
                });
                self.complete_task(
                    &task,
                    RuntimeTaskState::Failed,
                    Some(e.to_string()),
                    &event_sender,
                )
                .await;
                return;
            }

            let _ = event_sender.send(RuntimeEvent::MessageCreated {
                session_id: task.session_id.clone(),
                message: initial_message,
            });
        }

        let agent_config = match self.resolve_agent_config(&input).await {
            Ok(config) => config,
            Err(error) => {
                self.complete_task(&task, RuntimeTaskState::Failed, Some(error), &event_sender)
                    .await;
                let mut tasks = self.tasks.write().await;
                tasks.remove(&task.id);
                return;
            }
        };

        let tool_registry = Arc::new(ToolRegistry::create_default().await);
        let tool_dispatcher = Arc::new(ToolDispatcher::new(tool_registry.clone()));
        let tool_executor = ToolExecutor::new();
        let hook_runner = HookRunner::new();
        let action_rx = Arc::new(Mutex::new(action_rx));
        let mut loop_manager =
            CompletionLoopManager::new(CompletionLoopConfig::default_for_task(false));
        let tool_settings = input.settings.clone().unwrap_or_default();
        let mut transient_messages: Vec<Message> = Vec::new();
        let mut did_run_session_start = false;
        let mut auto_continue_count = 0u32;
        let mut unknown_finish_reason_count = 0u32;
        let completion_hook_pipeline = Self::build_completion_hook_pipeline();

        let task_result = loop {
            loop_manager.increment_iteration();

            if !did_run_session_start {
                let hook_cwd = input
                    .workspace
                    .as_ref()
                    .and_then(|workspace| workspace.worktree_path.clone())
                    .or_else(|| {
                        input
                            .workspace
                            .as_ref()
                            .map(|workspace| workspace.root_path.clone())
                    })
                    .unwrap_or_else(|| ".".to_string());

                match hook_runner
                    .run_session_start(
                        &task.session_id,
                        &hook_cwd,
                        &tool_settings,
                        self._storage.settings.get_db(),
                        "startup",
                    )
                    .await
                {
                    Ok(summary) => {
                        if !summary.additional_context.is_empty() {
                            transient_messages.push(Self::create_transient_system_message(
                                &task.session_id,
                                summary.additional_context.join("\n"),
                            ));
                        }
                    }
                    Err(error) => break Err(TaskTermination::Failed(error)),
                }

                did_run_session_start = true;
            }

            let mut session_messages = match self
                .session_manager
                .get_messages(&task.session_id, None, None)
                .await
            {
                Ok(messages) => messages,
                Err(error) => break Err(TaskTermination::Failed(error)),
            };
            session_messages.extend(transient_messages.clone());

            let iteration_output = match self
                .run_llm_iteration(
                    &task,
                    &input,
                    &agent_config,
                    &session_messages,
                    tool_registry.clone(),
                    &event_sender,
                )
                .await
            {
                Ok(output) => output,
                Err(error) => break Err(TaskTermination::Failed(error)),
            };

            let has_tool_calls = !iteration_output.tool_calls.is_empty();
            let finish_reason = iteration_output.finish_reason.as_deref();

            if !has_tool_calls && is_truncation_finish_reason(finish_reason) {
                auto_continue_count += 1;
                if auto_continue_count <= MAX_AUTO_CONTINUE_ATTEMPTS {
                    if !iteration_output.assistant_text.trim().is_empty() {
                        if let Err(error) = self
                            .persist_text_message(
                                &task.session_id,
                                MessageRole::Assistant,
                                iteration_output.assistant_text.clone(),
                                None,
                                None,
                                &event_sender,
                            )
                            .await
                        {
                            break Err(TaskTermination::Failed(error));
                        }
                    }
                    transient_messages.push(Self::create_transient_user_message(
                        &task.session_id,
                        "Continue from where you left off.",
                    ));
                    continue;
                }
            } else {
                auto_continue_count = 0;
            }

            let is_unknown_finish_reason = !has_tool_calls
                && !is_normal_finish_reason(finish_reason)
                && !is_truncation_finish_reason(finish_reason);
            if is_unknown_finish_reason {
                unknown_finish_reason_count += 1;
                if unknown_finish_reason_count <= MAX_UNKNOWN_FINISH_REASON_RETRIES {
                    continue;
                }
                break Err(TaskTermination::Failed(format!(
                    "Agent loop failed after {} unknown finish reason retries",
                    MAX_UNKNOWN_FINISH_REASON_RETRIES
                )));
            }
            unknown_finish_reason_count = 0;

            if !iteration_output.assistant_text.trim().is_empty() {
                if let Err(error) = self
                    .persist_text_message(
                        &task.session_id,
                        MessageRole::Assistant,
                        iteration_output.assistant_text.clone(),
                        None,
                        None,
                        &event_sender,
                    )
                    .await
                {
                    break Err(TaskTermination::Failed(error));
                }
            }

            if has_tool_calls {
                if let Err(error) = self
                    .persist_tool_calls_message(
                        &task.session_id,
                        &iteration_output.tool_calls,
                        &event_sender,
                    )
                    .await
                {
                    break Err(TaskTermination::Failed(error));
                }

                let tool_context = ToolContext {
                    session_id: task.session_id.clone(),
                    task_id: task.id.clone(),
                    workspace_root: input
                        .workspace
                        .as_ref()
                        .map(|workspace| workspace.root_path.clone())
                        .unwrap_or_else(|| ".".to_string()),
                    worktree_path: input
                        .workspace
                        .as_ref()
                        .and_then(|workspace| workspace.worktree_path.clone()),
                    settings: tool_settings.clone(),
                    subagent_id: None,
                    db: self._storage.settings.get_db(),
                };

                let iteration_tool_settings = tool_settings.clone();
                let termination = Arc::new(Mutex::new(None::<TaskTermination>));
                let tool_results = tool_executor
                    .execute_with_smart_concurrency(iteration_output.tool_calls.clone(), {
                        let runtime = self.clone();
                        let action_rx = action_rx.clone();
                        let event_sender = event_sender.clone();
                        let task_state = task_state.clone();
                        let session_manager = self.session_manager.clone();
                        let dispatcher = tool_dispatcher.clone();
                        let task_id = task.id.clone();
                        let termination = termination.clone();
                        move |request| {
                            let runtime = runtime.clone();
                            let action_rx = action_rx.clone();
                            let event_sender = event_sender.clone();
                            let task_state = task_state.clone();
                            let session_manager = session_manager.clone();
                            let dispatcher = dispatcher.clone();
                            let task_id = task_id.clone();
                            let context = tool_context.clone();
                            let settings = iteration_tool_settings.clone();
                            let termination = termination.clone();
                            async move {
                                match runtime
                                    .execute_tool_request(
                                        dispatcher,
                                        request.clone(),
                                        context,
                                        settings,
                                        action_rx,
                                        task_state,
                                        session_manager,
                                        event_sender,
                                        task_id,
                                    )
                                    .await
                                {
                                    Ok(result) => result,
                                    Err(task_termination) => {
                                        let error_message = match &task_termination {
                                            TaskTermination::Cancelled(message)
                                            | TaskTermination::Failed(message) => message.clone(),
                                        };
                                        let mut slot = termination.lock().await;
                                        if slot.is_none() {
                                            *slot = Some(task_termination);
                                        }
                                        ToolExecutionEnvelope {
                                            result: ToolResult {
                                                tool_call_id: request.tool_call_id,
                                                name: Some(request.name),
                                                success: false,
                                                output: serde_json::Value::Null,
                                                error: Some(error_message),
                                            },
                                            additional_context: Vec::new(),
                                        }
                                    }
                                }
                            }
                        }
                    })
                    .await;

                if let Some(termination) = termination.lock().await.take() {
                    break Err(termination);
                }

                let mut persist_error: Option<String> = None;
                let mut hook_additional_contexts: Vec<String> = Vec::new();
                for (request, envelope) in tool_results {
                    if let Err(error) = self
                        .persist_tool_result_message(
                            &task.session_id,
                            &request,
                            &envelope.result,
                            &event_sender,
                        )
                        .await
                    {
                        persist_error = Some(error);
                        break;
                    }
                    hook_additional_contexts.extend(envelope.additional_context);
                }
                if let Some(error) = persist_error {
                    break Err(TaskTermination::Failed(error));
                }
                if !hook_additional_contexts.is_empty() {
                    transient_messages.push(Self::create_transient_system_message(
                        &task.session_id,
                        hook_additional_contexts.join("\n"),
                    ));
                }
            }

            if !has_tool_calls {
                let hook_context = HookContext {
                    task_id: task.id.clone(),
                    session_id: task.session_id.clone(),
                    messages: session_messages,
                    full_text: iteration_output.assistant_text.clone(),
                    settings: tool_settings.clone(),
                };

                match completion_hook_pipeline.run(&hook_context).await {
                    Ok(HookResult::Iterate { context }) => {
                        transient_messages.push(Self::create_transient_user_message(
                            &task.session_id,
                            context,
                        ));
                        continue;
                    }
                    Ok(HookResult::Stop { .. }) | Ok(HookResult::Continue { .. }) => {}
                    Err(error) => break Err(TaskTermination::Failed(error)),
                }
            }

            let loop_state = CompletionLoopState {
                last_finish_reason: iteration_output.finish_reason.clone(),
            };
            let decision = loop_manager.should_continue(&loop_state, has_tool_calls, false);

            if !decision.should_continue {
                if let Some(reason) = decision.stop_reason {
                    loop_manager.record_stop_reason(reason);
                    match reason {
                        CompletionStopReason::Completion => break Ok(()),
                        CompletionStopReason::MaxIterations => {
                            break Err(TaskTermination::Failed(
                                "Agent loop reached the iteration limit".to_string(),
                            ))
                        }
                        CompletionStopReason::UserStop => {
                            break Err(TaskTermination::Cancelled(
                                "Task cancelled by user".to_string(),
                            ))
                        }
                        CompletionStopReason::Error => {
                            break Err(TaskTermination::Failed(
                                "Agent loop stopped after an error finish reason".to_string(),
                            ))
                        }
                    }
                }
            }
        };

        match task_result {
            Ok(()) => {
                self.complete_task(&task, RuntimeTaskState::Completed, None, &event_sender)
                    .await;
            }
            Err(TaskTermination::Cancelled(message)) => {
                self.complete_task(
                    &task,
                    RuntimeTaskState::Cancelled,
                    Some(message),
                    &event_sender,
                )
                .await;
            }
            Err(TaskTermination::Failed(message)) => {
                self.complete_task(
                    &task,
                    RuntimeTaskState::Failed,
                    Some(message),
                    &event_sender,
                )
                .await;
            }
        }

        // Remove from active tasks
        let mut tasks = self.tasks.write().await;
        tasks.remove(&task.id);
    }

    async fn resolve_agent_config(&self, input: &TaskInput) -> Result<ResolvedAgentConfig, String> {
        let agent = match input.agent_id.as_deref() {
            Some(agent_id) => self._storage.agents.get_agent(agent_id).await?,
            None => None,
        };

        let preferred_model = agent
            .as_ref()
            .map(|agent| agent.model.clone())
            .filter(|model| !model.trim().is_empty())
            .or_else(|| {
                input
                    .settings
                    .as_ref()
                    .and_then(|settings| settings.extra.get("model"))
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string())
            });

        let model = resolve_model_identifier(
            &self.api_key_manager,
            &self.provider_registry,
            preferred_model,
            FallbackStrategy::AnyAvailable,
        )
        .await?;

        let available_tools = agent
            .as_ref()
            .map(|agent| agent.tools.clone())
            .filter(|tools| !tools.is_empty())
            .unwrap_or_else(|| {
                crate::core::tool_definitions::get_tool_definitions()
                    .into_iter()
                    .map(|(definition, _)| definition.name)
                    .collect()
            });

        Ok(ResolvedAgentConfig {
            model,
            system_prompt: agent
                .and_then(|agent| agent.system_prompt)
                .filter(|prompt| !prompt.trim().is_empty())
                .or_else(|| {
                    Some(
                        "You are TalkCody, a software engineering agent. Use tools when needed and keep the response grounded in repository state."
                            .to_string(),
                    )
                }),
            available_tools,
        })
    }

    fn build_completion_hook_pipeline() -> CompletionHookPipeline {
        let mut pipeline = CompletionHookPipeline::new();
        pipeline.add_hook(Box::new(StopHook::new()));
        pipeline.add_hook(Box::new(RalphLoopHook::new()));
        pipeline.add_hook(Box::new(AutoReviewHook::new()));
        pipeline
    }

    fn create_transient_user_message(session_id: &str, text: impl Into<String>) -> Message {
        Message {
            id: format!("msg_{}", uuid::Uuid::new_v4()),
            session_id: session_id.to_string(),
            role: MessageRole::User,
            content: MessageContent::Text { text: text.into() },
            created_at: chrono::Utc::now().timestamp(),
            tool_call_id: None,
            parent_id: None,
        }
    }

    fn create_transient_system_message(session_id: &str, text: impl Into<String>) -> Message {
        Message {
            id: format!("msg_{}", uuid::Uuid::new_v4()),
            session_id: session_id.to_string(),
            role: MessageRole::System,
            content: MessageContent::Text { text: text.into() },
            created_at: chrono::Utc::now().timestamp(),
            tool_call_id: None,
            parent_id: None,
        }
    }

    fn create_trace_context(task_id: &str, iteration: u32) -> TraceContext {
        TraceContext {
            trace_id: Some(task_id.to_string()),
            parent_span_id: None,
            span_name: Some(format!("agent-loop-iteration-{}", iteration)),
            metadata: Some(HashMap::from([(
                "iteration".to_string(),
                iteration.to_string(),
            )])),
        }
    }

    fn start_tool_span(
        &self,
        task_id: &str,
        request: &ToolRequest,
        context: &ToolContext,
    ) -> String {
        let normalized_name = normalize_tool_name(&request.name);
        let attributes = HashMap::from([
            (
                "toolCallId".to_string(),
                serde_json::json!(request.tool_call_id),
            ),
            ("toolName".to_string(), serde_json::json!(request.name)),
            (
                "normalizedToolName".to_string(),
                serde_json::json!(normalized_name),
            ),
            (
                "sessionId".to_string(),
                serde_json::json!(context.session_id),
            ),
            ("taskId".to_string(), serde_json::json!(task_id)),
            (
                "subagentId".to_string(),
                serde_json::json!(context.subagent_id.clone()),
            ),
        ]);
        self.trace_writer.start_span(
            task_id.to_string(),
            None,
            format!("tool.{}", normalized_name),
            attributes,
        )
    }

    fn finish_tool_span(
        &self,
        span_id: String,
        request: &ToolRequest,
        result: Result<&ToolResult, &TaskTermination>,
    ) {
        match result {
            Ok(tool_result) => {
                self.trace_writer.add_event(
                    span_id.clone(),
                    "tool.result".to_string(),
                    Some(serde_json::json!({
                        "toolCallId": request.tool_call_id,
                        "toolName": request.name,
                        "success": tool_result.success,
                        "error": tool_result.error,
                    })),
                );
            }
            Err(termination) => {
                let message = match termination {
                    TaskTermination::Cancelled(message) | TaskTermination::Failed(message) => {
                        message
                    }
                };
                self.trace_writer.add_event(
                    span_id.clone(),
                    "tool.error".to_string(),
                    Some(serde_json::json!({
                        "toolCallId": request.tool_call_id,
                        "toolName": request.name,
                        "message": message,
                    })),
                );
            }
        }
        self.trace_writer
            .end_span(span_id, chrono::Utc::now().timestamp_millis());
    }

    async fn run_llm_iteration(
        &self,
        task: &RuntimeTask,
        _input: &TaskInput,
        agent_config: &ResolvedAgentConfig,
        session_messages: &[Message],
        tool_registry: Arc<ToolRegistry>,
        event_sender: &EventSender,
    ) -> Result<StreamIterationOutput, String> {
        let runner = crate::llm::ai_services::stream_runner::StreamRunner::new(
            self.provider_registry.clone(),
            self.api_key_manager.clone(),
        );
        let llm_messages =
            Self::build_llm_messages(session_messages, agent_config.system_prompt.as_deref());
        let tool_definitions = self
            .build_llm_tool_definitions(tool_registry, &agent_config.available_tools)
            .await?;

        let iteration_output = Arc::new(std::sync::Mutex::new(StreamIterationOutput::default()));
        let session_id = task.session_id.clone();
        let task_id = task.id.clone();
        let event_sender = event_sender.clone();
        let iteration_output_ref = iteration_output.clone();

        runner
            .stream(
                crate::llm::types::StreamTextRequest {
                    model: agent_config.model.clone(),
                    fallback_models: None,
                    messages: llm_messages,
                    tools: (!tool_definitions.is_empty()).then_some(tool_definitions),
                    stream: Some(true),
                    temperature: Some(0.7),
                    max_tokens: None,
                    top_p: None,
                    top_k: None,
                    provider_options: None,
                    request_id: Some(task.id.clone()),
                    conversation_mode: Some(ConversationMode::Stateless),
                    input_mode: Some(InputMode::FullHistory),
                    previous_response_id: None,
                    transport_session_id: None,
                    allow_transport_fallback: Some(true),
                    continuation_context: None,
                    trace_context: Some(Self::create_trace_context(&task.id, 1)),
                },
                std::time::Duration::from_secs(300),
                move |event| match event {
                    StreamEvent::TextDelta { text } => {
                        let mut state = iteration_output_ref.lock().expect("iteration output lock");
                        state.assistant_text.push_str(&text);
                        drop(state);
                        let _ = event_sender.send(RuntimeEvent::Token {
                            session_id: session_id.clone(),
                            token: text,
                        });
                    }
                    StreamEvent::ToolCall {
                        tool_call_id,
                        tool_name,
                        input,
                        provider_metadata,
                    } => {
                        let mut state = iteration_output_ref.lock().expect("iteration output lock");
                        state.tool_calls.push(ToolRequest {
                            tool_call_id,
                            name: tool_name,
                            input,
                            provider_metadata,
                        });
                    }
                    StreamEvent::ReasoningStart { id, .. } => {
                        let _ = event_sender.send(RuntimeEvent::ReasoningStart {
                            session_id: session_id.clone(),
                            id,
                        });
                    }
                    StreamEvent::ReasoningDelta { id, text, .. } => {
                        let _ = event_sender.send(RuntimeEvent::ReasoningDelta {
                            session_id: session_id.clone(),
                            id,
                            text,
                        });
                    }
                    StreamEvent::ReasoningEnd { id } => {
                        let _ = event_sender.send(RuntimeEvent::ReasoningEnd {
                            session_id: session_id.clone(),
                            id,
                        });
                    }
                    StreamEvent::Usage {
                        input_tokens,
                        output_tokens,
                        total_tokens,
                        cached_input_tokens,
                        cache_creation_input_tokens,
                    } => {
                        let _ = event_sender.send(RuntimeEvent::Usage {
                            session_id: session_id.clone(),
                            input_tokens,
                            output_tokens,
                            total_tokens,
                            cached_input_tokens,
                            cache_creation_input_tokens,
                        });
                    }
                    StreamEvent::Done { finish_reason } => {
                        let finish_reason_clone = finish_reason.clone();
                        let mut state = iteration_output_ref.lock().expect("iteration output lock");
                        state.finish_reason = finish_reason_clone.clone();
                        drop(state);
                        let _ = event_sender.send(RuntimeEvent::Done {
                            session_id: session_id.clone(),
                            finish_reason: finish_reason_clone,
                        });
                    }
                    StreamEvent::ResponseMetadata {
                        response_id,
                        transport,
                        provider,
                        continuation_accepted,
                        transport_session_id,
                    } => {
                        let mut state = iteration_output_ref.lock().expect("iteration output lock");
                        state.response_id = Some(response_id.clone());
                        state.response_transport = Some(transport);
                        state.response_provider = Some(provider);
                        state.continuation_accepted = continuation_accepted;
                        state.transport_session_id = transport_session_id;
                    }
                    StreamEvent::TransportFallback { to, .. } => {
                        let mut state = iteration_output_ref.lock().expect("iteration output lock");
                        state.transport_fallback_target = Some(to);
                    }
                    StreamEvent::Error { message } => {
                        let mut state = iteration_output_ref.lock().expect("iteration output lock");
                        state.finish_reason = Some("error".to_string());
                        drop(state);
                        let _ = event_sender.send(RuntimeEvent::Error {
                            task_id: Some(task_id.clone()),
                            session_id: Some(session_id.clone()),
                            message,
                        });
                    }
                    StreamEvent::TextStart => {}
                    StreamEvent::Raw { raw_value } => {
                        let mut state = iteration_output_ref.lock().expect("iteration output lock");
                        state.raw_chunks.push(raw_value);
                    }
                },
            )
            .await?;

        let output = {
            let state = iteration_output.lock().expect("iteration output lock");
            state.clone()
        };
        Ok(output)
    }

    fn build_llm_messages(messages: &[Message], system_prompt: Option<&str>) -> Vec<LlmMessage> {
        let mut llm_messages = Vec::new();

        if let Some(system_prompt) = system_prompt.filter(|prompt| !prompt.trim().is_empty()) {
            llm_messages.push(LlmMessage::System {
                content: system_prompt.to_string(),
                provider_options: None,
            });
        }

        for message in messages {
            // Nested sub-agent messages are persisted for UI/threading, but they
            // must not be replayed into the parent agent's next LLM iteration.
            if message.parent_id.is_some() {
                continue;
            }
            match (&message.role, &message.content) {
                (MessageRole::System, MessageContent::Text { text }) => {
                    llm_messages.push(LlmMessage::System {
                        content: text.clone(),
                        provider_options: None,
                    });
                }
                (MessageRole::User, MessageContent::Text { text }) => {
                    llm_messages.push(LlmMessage::User {
                        content: LlmMessageContent::Text(text.clone()),
                        provider_options: None,
                    });
                }
                (MessageRole::Assistant, MessageContent::Text { text }) => {
                    llm_messages.push(LlmMessage::Assistant {
                        content: LlmMessageContent::Text(text.clone()),
                        provider_options: None,
                    });
                }
                (MessageRole::Assistant, MessageContent::ToolCalls { calls }) => {
                    llm_messages.push(LlmMessage::Assistant {
                        content: LlmMessageContent::Parts(
                            calls
                                .iter()
                                .map(|call| ContentPart::ToolCall {
                                    tool_call_id: call.id.clone(),
                                    tool_name: call.name.clone(),
                                    input: call.input.clone(),
                                    provider_metadata: None,
                                })
                                .collect(),
                        ),
                        provider_options: None,
                    });
                }
                (MessageRole::Tool, MessageContent::ToolResult { result }) => {
                    llm_messages.push(LlmMessage::Tool {
                        content: vec![ContentPart::ToolResult {
                            tool_call_id: result.tool_call_id.clone(),
                            tool_name: result.tool_name.clone(),
                            output: result.output.clone().unwrap_or(serde_json::Value::Null),
                        }],
                        provider_options: None,
                    });
                }
                _ => {}
            }
        }

        llm_messages
    }

    async fn build_llm_tool_definitions(
        &self,
        tool_registry: Arc<ToolRegistry>,
        available_tools: &[String],
    ) -> Result<Vec<crate::llm::types::ToolDefinition>, String> {
        let allowed = available_tools
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let definitions = tool_registry
            .list_tools()
            .await
            .into_iter()
            .filter(|definition| allowed.contains(&definition.name))
            .map(|definition| crate::llm::types::ToolDefinition {
                tool_type: "function".to_string(),
                name: definition.name,
                description: Some(definition.description),
                parameters: definition.parameters,
                strict: false,
            })
            .collect();

        Ok(definitions)
    }

    async fn persist_text_message(
        &self,
        session_id: &str,
        role: MessageRole,
        text: String,
        tool_call_id: Option<String>,
        parent_id: Option<String>,
        event_sender: &EventSender,
    ) -> Result<(), String> {
        let message = Message {
            id: format!("msg_{}", uuid::Uuid::new_v4()),
            session_id: session_id.to_string(),
            role,
            content: MessageContent::Text { text },
            created_at: chrono::Utc::now().timestamp(),
            tool_call_id,
            parent_id,
        };

        self.session_manager.add_message(message.clone()).await?;
        let _ = event_sender.send(RuntimeEvent::MessageCreated {
            session_id: session_id.to_string(),
            message,
        });
        Ok(())
    }

    async fn persist_tool_calls_message(
        &self,
        session_id: &str,
        tool_calls: &[ToolRequest],
        event_sender: &EventSender,
    ) -> Result<(), String> {
        self.persist_tool_calls_message_with_parent(session_id, tool_calls, None, event_sender)
            .await
    }

    async fn persist_tool_calls_message_with_parent(
        &self,
        session_id: &str,
        tool_calls: &[ToolRequest],
        parent_id: Option<String>,
        event_sender: &EventSender,
    ) -> Result<(), String> {
        let message = Message {
            id: format!("msg_{}", uuid::Uuid::new_v4()),
            session_id: session_id.to_string(),
            role: MessageRole::Assistant,
            content: MessageContent::ToolCalls {
                calls: tool_calls
                    .iter()
                    .map(|request| ToolCall {
                        id: request.tool_call_id.clone(),
                        name: request.name.clone(),
                        input: request.input.clone(),
                    })
                    .collect(),
            },
            created_at: chrono::Utc::now().timestamp(),
            tool_call_id: None,
            parent_id,
        };

        self.session_manager.add_message(message.clone()).await?;
        let _ = event_sender.send(RuntimeEvent::MessageCreated {
            session_id: session_id.to_string(),
            message,
        });
        Ok(())
    }

    async fn persist_tool_result_message(
        &self,
        session_id: &str,
        request: &ToolRequest,
        result: &ToolResult,
        event_sender: &EventSender,
    ) -> Result<(), String> {
        self.persist_tool_result_message_with_parent(
            session_id,
            request,
            result,
            None,
            event_sender,
        )
        .await
    }

    async fn persist_tool_result_message_with_parent(
        &self,
        session_id: &str,
        request: &ToolRequest,
        result: &ToolResult,
        parent_id: Option<String>,
        event_sender: &EventSender,
    ) -> Result<(), String> {
        let message = Message {
            id: format!("msg_{}", uuid::Uuid::new_v4()),
            session_id: session_id.to_string(),
            role: MessageRole::Tool,
            content: MessageContent::ToolResult {
                result: StoredToolResult {
                    tool_call_id: request.tool_call_id.clone(),
                    tool_name: request.name.clone(),
                    input: Some(request.input.clone()),
                    output: Some(result.output.clone()),
                    status: if result.success {
                        ToolResultStatus::Success
                    } else {
                        ToolResultStatus::Error
                    },
                    error_message: result.error.clone(),
                },
            },
            created_at: chrono::Utc::now().timestamp(),
            tool_call_id: Some(request.tool_call_id.clone()),
            parent_id,
        };

        self.session_manager.add_message(message.clone()).await?;
        self.persist_tool_result_attachments(session_id, &message.id, result)
            .await?;
        let _ = event_sender.send(RuntimeEvent::MessageCreated {
            session_id: session_id.to_string(),
            message,
        });
        Ok(())
    }

    async fn persist_tool_result_attachments(
        &self,
        session_id: &str,
        message_id: &str,
        result: &ToolResult,
    ) -> Result<(), String> {
        for attachment in Self::extract_tool_result_attachments(&result.output) {
            self._storage
                .attachments
                .create_attachment_reference(&Attachment {
                    id: attachment.id,
                    session_id: session_id.to_string(),
                    message_id: Some(message_id.to_string()),
                    filename: attachment.filename,
                    mime_type: attachment.mime_type,
                    size: attachment.size,
                    path: attachment.file_path,
                    created_at: chrono::Utc::now().timestamp(),
                    origin: AttachmentOrigin::ToolOutput,
                })
                .await?;
        }

        Ok(())
    }

    fn extract_tool_result_attachments(output: &serde_json::Value) -> Vec<ToolMessageAttachment> {
        let Some(record) = output.as_object() else {
            return Vec::new();
        };
        let attachments_value = record
            .get("attachments")
            .or_else(|| record.get("_attachments"));
        let Some(attachments) = attachments_value.and_then(|value| value.as_array()) else {
            return Vec::new();
        };

        attachments
            .iter()
            .filter_map(|item| {
                let attachment = item.as_object()?;
                let attachment_type = attachment.get("type")?.as_str()?;
                if !matches!(attachment_type, "image" | "video" | "file" | "code") {
                    return None;
                }

                Some(ToolMessageAttachment {
                    id: attachment
                        .get("id")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("att_{}", uuid::Uuid::new_v4())),
                    filename: attachment.get("filename")?.as_str()?.to_string(),
                    file_path: attachment.get("filePath")?.as_str()?.to_string(),
                    mime_type: attachment.get("mimeType")?.as_str()?.to_string(),
                    size: attachment.get("size")?.as_i64()?,
                })
            })
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_tool_request(
        &self,
        dispatcher: Arc<ToolDispatcher>,
        request: ToolRequest,
        context: ToolContext,
        settings: TaskSettings,
        action_rx: Arc<Mutex<mpsc::UnboundedReceiver<TaskAction>>>,
        task_state: Arc<RwLock<RuntimeTaskState>>,
        session_manager: Arc<SessionManager>,
        event_sender: EventSender,
        task_id: RuntimeTaskId,
    ) -> BoxFuture<'_, Result<ToolExecutionEnvelope, TaskTermination>> {
        Box::pin(async move {
            let _ = event_sender.send(RuntimeEvent::ToolCallStarted {
                task_id: task_id.clone(),
                request: request.clone(),
            });
            let span_id = self.start_tool_span(&task_id, &request, &context);

            if normalize_tool_name(&request.name) == "callAgent" {
                let result = self
                    .execute_call_agent_tool(
                        request.clone(),
                        context.clone(),
                        settings,
                        action_rx,
                        task_state,
                        session_manager,
                        event_sender.clone(),
                        task_id.clone(),
                    )
                    .await?;
                self.finish_tool_span(span_id, &request, Ok(&result));
                let _ = event_sender.send(RuntimeEvent::ToolCallCompleted {
                    task_id,
                    result: result.clone(),
                });
                return Ok(ToolExecutionEnvelope {
                    result,
                    additional_context: Vec::new(),
                });
            }

            let result = Self::dispatch_tool_request(
                dispatcher,
                request.clone(),
                context,
                settings,
                action_rx,
                task_state,
                session_manager,
                event_sender,
                task_id.clone(),
            )
            .await;
            let span_result = match result.as_ref() {
                Ok(envelope) => Ok(&envelope.result),
                Err(error) => Err(error),
            };
            self.finish_tool_span(span_id, &request, span_result);
            result
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute_call_agent_tool(
        &self,
        request: ToolRequest,
        parent_context: ToolContext,
        settings: TaskSettings,
        action_rx: Arc<Mutex<mpsc::UnboundedReceiver<TaskAction>>>,
        task_state: Arc<RwLock<RuntimeTaskState>>,
        session_manager: Arc<SessionManager>,
        event_sender: EventSender,
        task_id: RuntimeTaskId,
    ) -> Result<ToolResult, TaskTermination> {
        let agent_id = request
            .input
            .get("agentId")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        let delegated_task = request
            .input
            .get("task")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        let delegated_context = request
            .input
            .get("context")
            .and_then(|value| value.as_str())
            .map(str::to_string);

        let Some(agent_id) = agent_id else {
            return Ok(ToolResult {
                tool_call_id: request.tool_call_id,
                name: Some(request.name),
                success: false,
                output: serde_json::Value::Null,
                error: Some("callAgent missing required field 'agentId'".to_string()),
            });
        };
        let Some(delegated_task) = delegated_task else {
            return Ok(ToolResult {
                tool_call_id: request.tool_call_id,
                name: Some(request.name),
                success: false,
                output: serde_json::Value::Null,
                error: Some("callAgent missing required field 'task'".to_string()),
            });
        };

        let agent = if let Some(agent) = self
            ._storage
            .agents
            .get_agent(&agent_id)
            .await
            .map_err(TaskTermination::Failed)?
        {
            Some(agent)
        } else {
            self._storage
                .agents
                .get_agent_by_name(&agent_id)
                .await
                .map_err(TaskTermination::Failed)?
        };

        let Some(agent) = agent else {
            return Ok(ToolResult {
                tool_call_id: request.tool_call_id,
                name: Some(request.name),
                success: false,
                output: serde_json::json!({
                    "task": delegated_task,
                    "success": false,
                    "message": format!("Agent not found: {}", agent_id),
                    "task_result": ""
                }),
                error: Some(format!("Agent not found: {}", agent_id)),
            });
        };

        let preferred_model = Some(agent.model.clone()).filter(|model| !model.trim().is_empty());
        let model = resolve_model_identifier(
            &self.api_key_manager,
            &self.provider_registry,
            preferred_model,
            FallbackStrategy::AnyAvailable,
        )
        .await
        .map_err(TaskTermination::Failed)?;

        let subagent_config = ResolvedAgentConfig {
            model,
            system_prompt: agent.system_prompt.clone(),
            available_tools: if agent.tools.is_empty() {
                crate::core::tool_definitions::get_tool_definitions()
                    .into_iter()
                    .map(|(definition, _)| definition.name)
                    .collect()
            } else {
                agent.tools.clone()
            },
        };

        let prompt = if let Some(context_text) = delegated_context
            .clone()
            .filter(|value| !value.trim().is_empty())
        {
            format!(
                "## Task\n{}\n\n## Context\n{}",
                delegated_task, context_text
            )
        } else {
            format!("## Task\n{}", delegated_task)
        };

        let subagent_task = RuntimeTask {
            id: format!("{}_{}", task_id, request.tool_call_id),
            session_id: parent_context.session_id.clone(),
            agent_id: Some(agent.id.clone()),
            state: RuntimeTaskState::Running,
            created_at: chrono::Utc::now().timestamp(),
            started_at: None,
            completed_at: None,
            error_message: None,
            metadata: HashMap::new(),
        };

        let mut messages = vec![Message {
            id: format!("msg_{}", uuid::Uuid::new_v4()),
            session_id: parent_context.session_id.clone(),
            role: MessageRole::User,
            content: MessageContent::Text { text: prompt },
            created_at: chrono::Utc::now().timestamp(),
            tool_call_id: None,
            parent_id: None,
        }];

        let tool_registry = Arc::new(ToolRegistry::create_default().await);
        let tool_dispatcher = Arc::new(ToolDispatcher::new(tool_registry.clone()));
        let tool_executor = ToolExecutor::new();
        let mut loop_manager =
            CompletionLoopManager::new(CompletionLoopConfig::default_for_task(true));
        let (nested_event_sender, _nested_event_rx) = mpsc::unbounded_channel();
        let mut final_text = String::new();
        let mut auto_continue_count = 0u32;
        let mut unknown_finish_reason_count = 0u32;

        let subagent_result = loop {
            loop_manager.increment_iteration();

            let iteration_output = match self
                .run_llm_iteration(
                    &subagent_task,
                    &TaskInput {
                        session_id: parent_context.session_id.clone(),
                        agent_id: Some(agent.id.clone()),
                        project_id: None,
                        initial_message: delegated_task.clone(),
                        settings: Some(settings.clone()),
                        workspace: Some(WorkspaceInfo {
                            root_path: parent_context.workspace_root.clone(),
                            worktree_path: parent_context.worktree_path.clone(),
                            repository_url: None,
                            branch: None,
                        }),
                    },
                    &subagent_config,
                    &messages,
                    tool_registry.clone(),
                    &nested_event_sender,
                )
                .await
            {
                Ok(output) => output,
                Err(error) => break Err(TaskTermination::Failed(error)),
            };

            let has_tool_calls = !iteration_output.tool_calls.is_empty();
            let finish_reason = iteration_output.finish_reason.as_deref();

            if !has_tool_calls && is_truncation_finish_reason(finish_reason) {
                auto_continue_count += 1;
                if auto_continue_count <= MAX_AUTO_CONTINUE_ATTEMPTS {
                    if !iteration_output.assistant_text.trim().is_empty() {
                        if !final_text.is_empty() {
                            final_text.push_str("\n\n");
                        }
                        final_text.push_str(iteration_output.assistant_text.trim());
                        self.persist_text_message(
                            &parent_context.session_id,
                            MessageRole::Assistant,
                            iteration_output.assistant_text.clone(),
                            None,
                            Some(request.tool_call_id.clone()),
                            &event_sender,
                        )
                        .await
                        .map_err(TaskTermination::Failed)?;
                        messages.push(Message {
                            id: format!("msg_{}", uuid::Uuid::new_v4()),
                            session_id: parent_context.session_id.clone(),
                            role: MessageRole::Assistant,
                            content: MessageContent::Text {
                                text: iteration_output.assistant_text.clone(),
                            },
                            created_at: chrono::Utc::now().timestamp(),
                            tool_call_id: None,
                            parent_id: None,
                        });
                    }
                    messages.push(Self::create_transient_user_message(
                        &parent_context.session_id,
                        "Continue from where you left off.",
                    ));
                    continue;
                }
            } else {
                auto_continue_count = 0;
            }

            let is_unknown_finish_reason = !has_tool_calls
                && !is_normal_finish_reason(finish_reason)
                && !is_truncation_finish_reason(finish_reason);
            if is_unknown_finish_reason {
                unknown_finish_reason_count += 1;
                if unknown_finish_reason_count <= MAX_UNKNOWN_FINISH_REASON_RETRIES {
                    continue;
                }
                break Err(TaskTermination::Failed(format!(
                    "Subagent loop failed after {} unknown finish reason retries",
                    MAX_UNKNOWN_FINISH_REASON_RETRIES
                )));
            }
            unknown_finish_reason_count = 0;

            if !iteration_output.assistant_text.trim().is_empty() {
                if !final_text.is_empty() {
                    final_text.push_str("\n\n");
                }
                final_text.push_str(iteration_output.assistant_text.trim());
                self.persist_text_message(
                    &parent_context.session_id,
                    MessageRole::Assistant,
                    iteration_output.assistant_text.clone(),
                    None,
                    Some(request.tool_call_id.clone()),
                    &event_sender,
                )
                .await
                .map_err(TaskTermination::Failed)?;
                messages.push(Message {
                    id: format!("msg_{}", uuid::Uuid::new_v4()),
                    session_id: parent_context.session_id.clone(),
                    role: MessageRole::Assistant,
                    content: MessageContent::Text {
                        text: iteration_output.assistant_text.clone(),
                    },
                    created_at: chrono::Utc::now().timestamp(),
                    tool_call_id: None,
                    parent_id: None,
                });
            }

            if has_tool_calls {
                self.persist_tool_calls_message_with_parent(
                    &parent_context.session_id,
                    &iteration_output.tool_calls,
                    Some(request.tool_call_id.clone()),
                    &event_sender,
                )
                .await
                .map_err(TaskTermination::Failed)?;
                messages.push(Message {
                    id: format!("msg_{}", uuid::Uuid::new_v4()),
                    session_id: parent_context.session_id.clone(),
                    role: MessageRole::Assistant,
                    content: MessageContent::ToolCalls {
                        calls: iteration_output
                            .tool_calls
                            .iter()
                            .map(|tool_call| ToolCall {
                                id: tool_call.tool_call_id.clone(),
                                name: tool_call.name.clone(),
                                input: tool_call.input.clone(),
                            })
                            .collect(),
                    },
                    created_at: chrono::Utc::now().timestamp(),
                    tool_call_id: None,
                    parent_id: None,
                });

                let nested_context = ToolContext {
                    session_id: parent_context.session_id.clone(),
                    task_id: parent_context.task_id.clone(),
                    workspace_root: parent_context.workspace_root.clone(),
                    worktree_path: parent_context.worktree_path.clone(),
                    settings: settings.clone(),
                    subagent_id: Some(request.tool_call_id.clone()),
                    db: parent_context.db.clone(),
                };

                let termination = Arc::new(Mutex::new(None::<TaskTermination>));
                let nested_results = tool_executor
                    .execute_with_smart_concurrency(iteration_output.tool_calls.clone(), {
                        let runtime = self.clone();
                        let dispatcher = tool_dispatcher.clone();
                        let action_rx = action_rx.clone();
                        let task_state = task_state.clone();
                        let session_manager = session_manager.clone();
                        let event_sender = event_sender.clone();
                        let task_id = task_id.clone();
                        let settings = settings.clone();
                        let termination = termination.clone();
                        move |nested_request| {
                            let runtime = runtime.clone();
                            let dispatcher = dispatcher.clone();
                            let action_rx = action_rx.clone();
                            let task_state = task_state.clone();
                            let session_manager = session_manager.clone();
                            let event_sender = event_sender.clone();
                            let task_id = task_id.clone();
                            let settings = settings.clone();
                            let context = nested_context.clone();
                            let termination = termination.clone();
                            async move {
                                match runtime
                                    .execute_tool_request(
                                        dispatcher,
                                        nested_request.clone(),
                                        context,
                                        settings,
                                        action_rx,
                                        task_state,
                                        session_manager,
                                        event_sender,
                                        task_id,
                                    )
                                    .await
                                {
                                    Ok(result) => result,
                                    Err(task_termination) => {
                                        let error_message = match &task_termination {
                                            TaskTermination::Cancelled(message)
                                            | TaskTermination::Failed(message) => message.clone(),
                                        };
                                        let mut slot = termination.lock().await;
                                        if slot.is_none() {
                                            *slot = Some(task_termination);
                                        }
                                        ToolExecutionEnvelope {
                                            result: ToolResult {
                                                tool_call_id: nested_request.tool_call_id,
                                                name: Some(nested_request.name),
                                                success: false,
                                                output: serde_json::Value::Null,
                                                error: Some(error_message),
                                            },
                                            additional_context: Vec::new(),
                                        }
                                    }
                                }
                            }
                        }
                    })
                    .await;

                if let Some(termination) = termination.lock().await.take() {
                    break Err(termination);
                }

                for (nested_request, nested_result) in nested_results {
                    self.persist_tool_result_message_with_parent(
                        &parent_context.session_id,
                        &nested_request,
                        &nested_result.result,
                        Some(request.tool_call_id.clone()),
                        &event_sender,
                    )
                    .await
                    .map_err(TaskTermination::Failed)?;
                    messages.push(Message {
                        id: format!("msg_{}", uuid::Uuid::new_v4()),
                        session_id: parent_context.session_id.clone(),
                        role: MessageRole::Tool,
                        content: MessageContent::ToolResult {
                            result: StoredToolResult {
                                tool_call_id: nested_request.tool_call_id.clone(),
                                tool_name: nested_request.name.clone(),
                                input: Some(nested_request.input.clone()),
                                output: Some(nested_result.result.output.clone()),
                                status: if nested_result.result.success {
                                    ToolResultStatus::Success
                                } else {
                                    ToolResultStatus::Error
                                },
                                error_message: nested_result.result.error.clone(),
                            },
                        },
                        created_at: chrono::Utc::now().timestamp(),
                        tool_call_id: Some(nested_request.tool_call_id.clone()),
                        parent_id: None,
                    });
                    if !nested_result.additional_context.is_empty() {
                        messages.push(Self::create_transient_system_message(
                            &parent_context.session_id,
                            nested_result.additional_context.join("\n"),
                        ));
                    }
                }
            }

            let loop_state = CompletionLoopState {
                last_finish_reason: iteration_output.finish_reason.clone(),
            };
            let decision = loop_manager.should_continue(&loop_state, has_tool_calls, false);

            if !decision.should_continue {
                if let Some(reason) = decision.stop_reason {
                    loop_manager.record_stop_reason(reason);
                    match reason {
                        CompletionStopReason::Completion => break Ok(()),
                        CompletionStopReason::MaxIterations => {
                            break Err(TaskTermination::Failed(
                                "Subagent loop reached the iteration limit".to_string(),
                            ))
                        }
                        CompletionStopReason::UserStop => {
                            break Err(TaskTermination::Cancelled(
                                "Subagent cancelled by user".to_string(),
                            ))
                        }
                        CompletionStopReason::Error => {
                            break Err(TaskTermination::Failed(
                                "Subagent loop stopped after an error finish reason".to_string(),
                            ))
                        }
                    }
                }
            }
        };

        Ok(match subagent_result {
            Ok(()) => ToolResult {
                tool_call_id: request.tool_call_id,
                name: Some(request.name),
                success: true,
                output: serde_json::json!({
                    "task": delegated_task,
                    "success": true,
                    "task_result": final_text,
                }),
                error: None,
            },
            Err(TaskTermination::Cancelled(message)) | Err(TaskTermination::Failed(message)) => {
                ToolResult {
                    tool_call_id: request.tool_call_id,
                    name: Some(request.name),
                    success: false,
                    output: serde_json::json!({
                        "task": delegated_task,
                        "success": false,
                        "message": message,
                        "task_result": final_text,
                    }),
                    error: Some(message),
                }
            }
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn dispatch_tool_request(
        dispatcher: Arc<ToolDispatcher>,
        request: ToolRequest,
        context: ToolContext,
        settings: TaskSettings,
        action_rx: Arc<Mutex<mpsc::UnboundedReceiver<TaskAction>>>,
        task_state: Arc<RwLock<RuntimeTaskState>>,
        session_manager: Arc<SessionManager>,
        event_sender: EventSender,
        task_id: RuntimeTaskId,
    ) -> Result<ToolExecutionEnvelope, TaskTermination> {
        let auto_approve = Self::should_auto_approve(&request.name, &settings);
        let session_id = context.session_id.clone();

        match dispatcher
            .dispatch(request.clone(), context.clone(), auto_approve)
            .await
            .map_err(TaskTermination::Failed)?
        {
            ToolDispatchResult::Completed(outcome) => {
                let _ = event_sender.send(RuntimeEvent::ToolCallCompleted {
                    task_id,
                    result: outcome.result.clone(),
                });
                Ok(ToolExecutionEnvelope {
                    result: outcome.result,
                    additional_context: outcome.additional_context,
                })
            }
            ToolDispatchResult::PendingApproval(pending_request) => {
                *task_state.write().await = RuntimeTaskState::WaitingForUser;
                session_manager
                    .update_session_status(&session_id, SessionStatus::WaitingForAction, None)
                    .await
                    .map_err(TaskTermination::Failed)?;
                let _ = event_sender.send(RuntimeEvent::ToolCallRequested {
                    task_id: task_id.clone(),
                    request: pending_request.request.clone(),
                });

                let approved =
                    Self::await_tool_approval(&pending_request.request.tool_call_id, action_rx)
                        .await?;

                *task_state.write().await = RuntimeTaskState::Running;
                session_manager
                    .update_session_status(&session_id, SessionStatus::Running, None)
                    .await
                    .map_err(TaskTermination::Failed)?;

                let outcome =
                    match approved {
                        ToolApproval::Approve => dispatcher
                            .execute_approved(pending_request.clone(), context)
                            .await
                            .map_err(TaskTermination::Failed)?,
                        ToolApproval::Reject(reason) => ToolDispatchOutcome {
                            result: ToolResult {
                                tool_call_id: pending_request.request.tool_call_id.clone(),
                                name: Some(pending_request.request.name.clone()),
                                success: false,
                                output: serde_json::Value::Null,
                                error: Some(reason.unwrap_or_else(|| {
                                    "Tool execution rejected by user".to_string()
                                })),
                            },
                            additional_context: pending_request.additional_context,
                        },
                        ToolApproval::ProvidedResult(output) => dispatcher
                            .finalize_external_result(pending_request, context, output)
                            .await
                            .map_err(TaskTermination::Failed)?,
                    };

                let _ = event_sender.send(RuntimeEvent::ToolCallCompleted {
                    task_id,
                    result: outcome.result.clone(),
                });
                Ok(ToolExecutionEnvelope {
                    result: outcome.result,
                    additional_context: outcome.additional_context,
                })
            }
            ToolDispatchResult::PendingUserInput(pending_request) => {
                *task_state.write().await = RuntimeTaskState::WaitingForUser;
                session_manager
                    .update_session_status(&session_id, SessionStatus::WaitingForAction, None)
                    .await
                    .map_err(TaskTermination::Failed)?;
                let _ = event_sender.send(RuntimeEvent::ToolCallRequested {
                    task_id: task_id.clone(),
                    request: pending_request.request.clone(),
                });

                let response =
                    Self::await_tool_result(&pending_request.request.tool_call_id, action_rx)
                        .await?;

                *task_state.write().await = RuntimeTaskState::Running;
                session_manager
                    .update_session_status(&session_id, SessionStatus::Running, None)
                    .await
                    .map_err(TaskTermination::Failed)?;

                let outcome = match response {
                    ToolApproval::ProvidedResult(output) => dispatcher
                        .finalize_external_result(pending_request, context, output)
                        .await
                        .map_err(TaskTermination::Failed)?,
                    ToolApproval::Reject(reason) => ToolDispatchOutcome {
                        result: ToolResult {
                            tool_call_id: pending_request.request.tool_call_id.clone(),
                            name: Some(pending_request.request.name.clone()),
                            success: false,
                            output: serde_json::Value::Null,
                            error: Some(reason.unwrap_or_else(|| {
                                "User declined to answer questions".to_string()
                            })),
                        },
                        additional_context: pending_request.additional_context,
                    },
                    ToolApproval::Approve => ToolDispatchOutcome {
                        result: ToolResult {
                            tool_call_id: pending_request.request.tool_call_id.clone(),
                            name: Some(pending_request.request.name.clone()),
                            success: false,
                            output: serde_json::Value::Null,
                            error: Some("Structured user response was required".to_string()),
                        },
                        additional_context: pending_request.additional_context,
                    },
                };

                let _ = event_sender.send(RuntimeEvent::ToolCallCompleted {
                    task_id,
                    result: outcome.result.clone(),
                });
                Ok(ToolExecutionEnvelope {
                    result: outcome.result,
                    additional_context: outcome.additional_context,
                })
            }
        }
    }

    async fn await_tool_approval(
        tool_call_id: &str,
        action_rx: Arc<Mutex<mpsc::UnboundedReceiver<TaskAction>>>,
    ) -> Result<ToolApproval, TaskTermination> {
        let mut receiver = action_rx.lock().await;
        while let Some(action) = receiver.recv().await {
            match action {
                TaskAction::Approve {
                    tool_call_id: action_id,
                } if action_id == tool_call_id => {
                    return Ok(ToolApproval::Approve);
                }
                TaskAction::Reject {
                    tool_call_id: action_id,
                    reason,
                } if action_id == tool_call_id => {
                    return Ok(ToolApproval::Reject(reason));
                }
                TaskAction::ToolResult {
                    tool_call_id: action_id,
                    result,
                } if action_id == tool_call_id => {
                    return Ok(ToolApproval::ProvidedResult(result));
                }
                TaskAction::Cancel => {
                    return Err(TaskTermination::Cancelled(
                        "Task cancelled by user".to_string(),
                    ));
                }
                _ => {}
            }
        }

        Err(TaskTermination::Failed(
            "Task action channel closed while waiting for approval".to_string(),
        ))
    }

    async fn await_tool_result(
        tool_call_id: &str,
        action_rx: Arc<Mutex<mpsc::UnboundedReceiver<TaskAction>>>,
    ) -> Result<ToolApproval, TaskTermination> {
        let mut receiver = action_rx.lock().await;
        while let Some(action) = receiver.recv().await {
            match action {
                TaskAction::ToolResult {
                    tool_call_id: action_id,
                    result,
                } if action_id == tool_call_id => {
                    return Ok(ToolApproval::ProvidedResult(result));
                }
                TaskAction::Reject {
                    tool_call_id: action_id,
                    reason,
                } if action_id == tool_call_id => {
                    return Ok(ToolApproval::Reject(reason));
                }
                TaskAction::Cancel => {
                    return Err(TaskTermination::Cancelled(
                        "Task cancelled by user".to_string(),
                    ));
                }
                _ => {}
            }
        }

        Err(TaskTermination::Failed(
            "Task action channel closed while waiting for tool result".to_string(),
        ))
    }

    fn should_auto_approve(tool_name: &str, settings: &TaskSettings) -> bool {
        matches!(
            tool_name,
            "writeFile" | "editFile" | "write_file" | "edit_file"
        ) && settings.auto_approve_edits.unwrap_or(false)
            || matches!(tool_name, "exitPlanMode" | "exit_plan_mode")
                && settings.auto_approve_plan.unwrap_or(false)
    }

    /// Complete a task and emit events
    async fn complete_task(
        &self,
        task: &RuntimeTask,
        final_state: RuntimeTaskState,
        error: Option<String>,
        event_sender: &EventSender,
    ) {
        let previous_state = match self.tasks.read().await.get(&task.id) {
            Some(handle) => *handle.state.read().await,
            None => RuntimeTaskState::Running,
        };

        if let Some(handle) = self.tasks.read().await.get(&task.id).cloned() {
            *handle.state.write().await = final_state;
        }

        // Update session status
        let session_status = match final_state {
            RuntimeTaskState::Completed => SessionStatus::Completed,
            RuntimeTaskState::Failed => SessionStatus::Error,
            RuntimeTaskState::Cancelled => SessionStatus::Cancelled,
            _ => SessionStatus::Running,
        };

        let _ = self
            .session_manager
            .update_session_status(&task.session_id, session_status, None)
            .await;

        if let Some(err) = error.clone() {
            log::error!("[Runtime] Task {} failed: {}", task.id, err);
            let _ = event_sender.send(RuntimeEvent::Error {
                task_id: Some(task.id.clone()),
                session_id: Some(task.session_id.clone()),
                message: err,
            });
        }

        // Emit completion event
        let _ = event_sender.send(RuntimeEvent::TaskStateChanged {
            task_id: task.id.clone(),
            state: final_state,
            previous_state,
        });

        let _ = event_sender.send(RuntimeEvent::TaskCompleted {
            task_id: task.id.clone(),
            session_id: task.session_id.clone(),
        });
    }

    /// Find existing session for a task input
    fn find_session_for_task(&self, input: &TaskInput) -> Option<SessionId> {
        // If session_id is explicitly provided in input, use that
        Some(input.session_id.clone())
    }

    async fn should_persist_initial_message(
        &self,
        session_id: &str,
        initial_message: &str,
    ) -> bool {
        if initial_message.trim().is_empty() {
            return false;
        }

        match self
            .session_manager
            .get_messages(session_id, None, None)
            .await
        {
            Ok(messages) => match messages.last() {
                Some(Message {
                    role: MessageRole::User,
                    content: MessageContent::Text { text },
                    ..
                }) => text != initial_message,
                _ => true,
            },
            Err(_) => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::tools::ToolContext;
    use crate::llm::testing::fixtures::{build_sse_body, RecordedSseEvent};
    use crate::llm::types::MessageContent as LlmContent;
    use crate::llm::types::{
        AuthType, CustomProviderConfig, CustomProviderType, CustomProvidersConfiguration,
        ModelConfig, ModelsConfiguration, ProtocolType, ProviderConfig,
    };
    use crate::storage::Agent;
    use crate::storage::{StoredToolResult, ToolResultStatus};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc as StdArc, Mutex as StdMutex};
    use std::thread;
    use std::time::Duration;
    use tempfile::TempDir;

    async fn create_test_runtime_with_registry(
        provider_registry: ProviderRegistry,
    ) -> (CoreRuntime, TempDir, mpsc::UnboundedReceiver<RuntimeEvent>) {
        let temp_dir = TempDir::new().unwrap();
        let storage = Storage::new(
            temp_dir.path().to_path_buf(),
            temp_dir.path().join("attachments"),
        )
        .await
        .expect("Failed to create storage");

        let (tx, rx) = mpsc::unbounded_channel();
        let db = storage.settings.get_db();
        let api_key_manager = ApiKeyManager::new(db, temp_dir.path().to_path_buf());
        let runtime = CoreRuntime::new(storage, tx, provider_registry, api_key_manager)
            .await
            .expect("Failed to create runtime");

        (runtime, temp_dir, rx)
    }

    #[tokio::test]
    async fn test_start_task_creates_missing_session_with_input_session_id() {
        let provider_registry = ProviderRegistry::new(Vec::new());
        let (runtime, _temp, _rx) = create_test_runtime_with_registry(provider_registry).await;

        let input_session_id = "task_frontend_bridge".to_string();
        let handle = runtime
            .start_task(TaskInput {
                session_id: input_session_id.clone(),
                agent_id: None,
                project_id: Some("default".to_string()),
                initial_message: "hello".to_string(),
                settings: None,
                workspace: None,
            })
            .await
            .expect("task should start even when the session does not exist yet");

        assert_eq!(handle.session_id, input_session_id);

        let session = runtime
            .session_manager()
            .get_session(&handle.session_id)
            .await
            .expect("session lookup should succeed");
        assert!(
            session.is_some(),
            "runtime should create the missing session"
        );
    }

    #[tokio::test]
    async fn test_start_task_does_not_duplicate_existing_initial_user_message() {
        let (runtime, _temp, _rx) = create_test_runtime().await;
        let session = runtime
            .session_manager()
            .create_session(None, None, None)
            .await
            .expect("session should be created");

        runtime
            .session_manager()
            .add_message(Message {
                id: "msg_existing_user".to_string(),
                session_id: session.id.clone(),
                role: MessageRole::User,
                content: MessageContent::Text {
                    text: "same prompt".to_string(),
                },
                created_at: chrono::Utc::now().timestamp(),
                tool_call_id: None,
                parent_id: None,
            })
            .await
            .expect("existing message should persist");

        let should_persist = runtime
            .should_persist_initial_message(&session.id, "same prompt")
            .await;
        assert!(!should_persist);

        let handle = runtime
            .start_task(TaskInput {
                session_id: session.id.clone(),
                agent_id: None,
                project_id: None,
                initial_message: "same prompt".to_string(),
                settings: None,
                workspace: None,
            })
            .await
            .expect("task should start");

        runtime
            .cancel_task(&handle.task_id)
            .await
            .expect("task should cancel");
        wait_for_terminal_state(&handle).await;

        let stored_messages = runtime
            .session_manager()
            .get_messages(&session.id, None, None)
            .await
            .expect("messages should load");
        let matching_messages = stored_messages
            .iter()
            .filter(|message| {
                matches!(
                    &message.content,
                    MessageContent::Text { text } if message.role == MessageRole::User && text == "same prompt"
                )
            })
            .count();

        assert_eq!(
            matching_messages, 1,
            "runtime should not duplicate the existing prompt"
        );
    }

    async fn create_test_runtime() -> (CoreRuntime, TempDir, mpsc::UnboundedReceiver<RuntimeEvent>)
    {
        create_test_runtime_with_registry(ProviderRegistry::default()).await
    }

    fn test_tool_context(runtime: &CoreRuntime, session_id: &str, task_id: &str) -> ToolContext {
        ToolContext {
            session_id: session_id.to_string(),
            task_id: task_id.to_string(),
            workspace_root: ".".to_string(),
            worktree_path: None,
            settings: TaskSettings::default(),
            subagent_id: None,
            db: runtime._storage.settings.get_db(),
        }
    }

    struct SequentialMockSseServer {
        base_url: String,
        requests: StdArc<StdMutex<Vec<serde_json::Value>>>,
        running: StdArc<AtomicBool>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl SequentialMockSseServer {
        fn start(responses: Vec<Vec<RecordedSseEvent>>) -> Result<Self, String> {
            let listener = TcpListener::bind("127.0.0.1:0")
                .map_err(|e| format!("Failed to bind mock server: {}", e))?;
            let addr = listener
                .local_addr()
                .map_err(|e| format!("Failed to read mock server address: {}", e))?;
            let server = tiny_http::Server::from_listener(listener, None)
                .map_err(|e| format!("Failed to start mock server: {}", e))?;

            let requests = StdArc::new(StdMutex::new(Vec::new()));
            let running = StdArc::new(AtomicBool::new(true));
            let next_response = StdArc::new(AtomicUsize::new(0));
            let request_log = requests.clone();
            let running_flag = running.clone();
            let response_sets = StdArc::new(responses);
            let response_sets_ref = response_sets.clone();
            let response_index = next_response.clone();

            let handle = thread::spawn(move || {
                while running_flag.load(Ordering::SeqCst) {
                    match server.recv_timeout(Duration::from_millis(50)) {
                        Ok(Some(mut request)) => {
                            let mut body = String::new();
                            if let Err(error) = request.as_reader().read_to_string(&mut body) {
                                let response = tiny_http::Response::from_string(format!(
                                    "Failed to read request body: {}",
                                    error
                                ))
                                .with_status_code(500);
                                let _ = request.respond(response);
                                continue;
                            }

                            let parsed = serde_json::from_str::<serde_json::Value>(&body)
                                .unwrap_or_else(|_| serde_json::json!({ "rawBody": body }));
                            request_log.lock().unwrap().push(parsed);

                            let index = response_index.fetch_add(1, Ordering::SeqCst);
                            let Some(events) = response_sets_ref.get(index) else {
                                let response =
                                    tiny_http::Response::from_string("No more mock responses")
                                        .with_status_code(500);
                                let _ = request.respond(response);
                                continue;
                            };

                            let response = tiny_http::Response::from_string(build_sse_body(events))
                                .with_status_code(200)
                                .with_header(
                                    tiny_http::Header::from_bytes(
                                        "content-type",
                                        "text/event-stream",
                                    )
                                    .expect("valid header"),
                                );
                            let _ = request.respond(response);
                        }
                        Ok(None) => {}
                        Err(error) => {
                            log::error!("Sequential mock server recv error: {}", error);
                        }
                    }
                }
            });

            Ok(Self {
                base_url: format!("http://{}", addr),
                requests,
                running,
                handle: Some(handle),
            })
        }

        fn base_url(&self) -> &str {
            &self.base_url
        }

        fn recorded_requests(&self) -> Vec<serde_json::Value> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl Drop for SequentialMockSseServer {
        fn drop(&mut self) {
            self.running.store(false, Ordering::SeqCst);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    async fn configure_mock_provider_and_model(
        runtime: &CoreRuntime,
        base_url: &str,
    ) -> Result<(), String> {
        runtime
            .api_key_manager
            .save_custom_providers(&CustomProvidersConfiguration {
                version: "test".to_string(),
                providers: HashMap::from([(
                    "mock-openai".to_string(),
                    CustomProviderConfig {
                        id: "mock-openai".to_string(),
                        name: "Mock OpenAI".to_string(),
                        provider_type: CustomProviderType::OpenAiCompatible,
                        base_url: base_url.to_string(),
                        api_key: "test-key".to_string(),
                        enabled: true,
                        description: Some("Sequential mock provider for runtime tests".to_string()),
                    },
                )]),
            })
            .await?;

        runtime
            .api_key_manager
            .set_setting(
                "models_config_json",
                &serde_json::to_string(&ModelsConfiguration {
                    version: "test".to_string(),
                    models: HashMap::from([(
                        "mock-model".to_string(),
                        ModelConfig {
                            name: "Mock Model".to_string(),
                            image_input: false,
                            image_output: false,
                            audio_input: false,
                            video_input: false,
                            interleaved: false,
                            providers: vec!["mock-openai".to_string()],
                            provider_mappings: None,
                            pricing: None,
                            context_length: Some(128_000),
                        },
                    )]),
                })
                .expect("models config should serialize"),
            )
            .await
    }

    async fn wait_for_terminal_state(handle: &TaskHandle) {
        for _ in 0..100 {
            if handle.state.read().await.is_terminal() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("task did not reach terminal state in time");
    }

    #[tokio::test]
    async fn test_create_runtime() {
        let (_runtime, _temp, _rx) = create_test_runtime().await;
        // Runtime created successfully
    }

    #[tokio::test]
    async fn test_settings_validation() {
        let validator = SettingsValidator::new();

        let valid_settings = TaskSettings::default();
        let result = validator.validate(&valid_settings);
        assert!(result.valid);
        assert!(result.warnings.is_empty());

        let risky_settings = TaskSettings {
            auto_approve_edits: Some(true),
            auto_approve_plan: Some(true),
            auto_code_review: None,
            extra: HashMap::new(),
        };
        let result = validator.validate(&risky_settings);
        assert!(result.valid); // Still valid, just warnings
        assert_eq!(result.warnings.len(), 2);
    }

    #[test]
    fn test_build_llm_messages_preserves_tool_shapes() {
        let session_id = "sess_test".to_string();
        let messages = vec![
            Message {
                id: "msg_user".to_string(),
                session_id: session_id.clone(),
                role: MessageRole::User,
                content: MessageContent::Text {
                    text: "Inspect the project".to_string(),
                },
                created_at: 1,
                tool_call_id: None,
                parent_id: None,
            },
            Message {
                id: "msg_calls".to_string(),
                session_id: session_id.clone(),
                role: MessageRole::Assistant,
                content: MessageContent::ToolCalls {
                    calls: vec![ToolCall {
                        id: "call_1".to_string(),
                        name: "readFile".to_string(),
                        input: serde_json::json!({"file_path": "/tmp/demo.rs"}),
                    }],
                },
                created_at: 2,
                tool_call_id: None,
                parent_id: None,
            },
            Message {
                id: "msg_result".to_string(),
                session_id,
                role: MessageRole::Tool,
                content: MessageContent::ToolResult {
                    result: StoredToolResult {
                        tool_call_id: "call_1".to_string(),
                        tool_name: "readFile".to_string(),
                        input: Some(serde_json::json!({"file_path": "/tmp/demo.rs"})),
                        output: Some(serde_json::json!({"content": "fn main() {}"})),
                        status: ToolResultStatus::Success,
                        error_message: None,
                    },
                },
                created_at: 3,
                tool_call_id: Some("call_1".to_string()),
                parent_id: None,
            },
        ];

        let llm_messages = CoreRuntime::build_llm_messages(&messages, Some("System prompt"));

        assert_eq!(llm_messages.len(), 4);
        assert!(matches!(
            &llm_messages[0],
            LlmMessage::System { content, .. } if content == "System prompt"
        ));
        assert!(matches!(
            &llm_messages[1],
            LlmMessage::User {
                content: LlmContent::Text(text),
                ..
            } if text == "Inspect the project"
        ));
        assert!(matches!(
            &llm_messages[2],
            LlmMessage::Assistant {
                content: LlmContent::Parts(parts),
                ..
            } if matches!(
                parts.as_slice(),
                [ContentPart::ToolCall {
                    tool_call_id,
                    tool_name,
                    input,
                    ..
                }] if tool_call_id == "call_1"
                    && tool_name == "readFile"
                    && input == &serde_json::json!({"file_path": "/tmp/demo.rs"})
            )
        ));
        assert!(matches!(
            &llm_messages[3],
            LlmMessage::Tool { content, .. } if matches!(
                content.as_slice(),
                [ContentPart::ToolResult {
                    tool_call_id,
                    tool_name,
                    output,
                }] if tool_call_id == "call_1"
                    && tool_name == "readFile"
                    && output == &serde_json::json!({"content": "fn main() {}"})
            )
        ));
    }

    #[test]
    fn test_build_llm_messages_ignores_parented_nested_messages() {
        let messages = vec![
            Message {
                id: "msg_user".to_string(),
                session_id: "sess_test".to_string(),
                role: MessageRole::User,
                content: MessageContent::Text {
                    text: "Top level task".to_string(),
                },
                created_at: 1,
                tool_call_id: None,
                parent_id: None,
            },
            Message {
                id: "msg_nested".to_string(),
                session_id: "sess_test".to_string(),
                role: MessageRole::Assistant,
                content: MessageContent::Text {
                    text: "Nested assistant status".to_string(),
                },
                created_at: 2,
                tool_call_id: None,
                parent_id: Some("call_agent_1".to_string()),
            },
        ];

        let llm_messages = CoreRuntime::build_llm_messages(&messages, None);

        assert_eq!(llm_messages.len(), 1);
        assert!(matches!(
            &llm_messages[0],
            LlmMessage::User {
                content: LlmContent::Text(text),
                ..
            } if text == "Top level task"
        ));
    }

    #[test]
    fn test_should_auto_approve_respects_task_settings() {
        let edit_settings = TaskSettings {
            auto_approve_edits: Some(true),
            auto_approve_plan: Some(false),
            auto_code_review: None,
            extra: HashMap::new(),
        };
        let plan_settings = TaskSettings {
            auto_approve_edits: Some(false),
            auto_approve_plan: Some(true),
            auto_code_review: None,
            extra: HashMap::new(),
        };

        assert!(CoreRuntime::should_auto_approve(
            "writeFile",
            &edit_settings
        ));
        assert!(CoreRuntime::should_auto_approve(
            "edit_file",
            &edit_settings
        ));
        assert!(!CoreRuntime::should_auto_approve(
            "readFile",
            &edit_settings
        ));
        assert!(CoreRuntime::should_auto_approve(
            "exitPlanMode",
            &plan_settings
        ));
        assert!(!CoreRuntime::should_auto_approve(
            "exitPlanMode",
            &edit_settings
        ));
    }

    #[tokio::test]
    async fn test_await_tool_approval_skips_unrelated_actions() {
        let (tx, rx) = mpsc::unbounded_channel();
        let receiver = Arc::new(Mutex::new(rx));

        tx.send(TaskAction::Approve {
            tool_call_id: "other_call".to_string(),
        })
        .unwrap();
        tx.send(TaskAction::ToolResult {
            tool_call_id: "target_call".to_string(),
            result: serde_json::json!({"approved": true}),
        })
        .unwrap();

        let approval = CoreRuntime::await_tool_approval("target_call", receiver)
            .await
            .expect("approval should resolve");

        match approval {
            ToolApproval::ProvidedResult(result) => {
                assert_eq!(result, serde_json::json!({"approved": true}));
            }
            other => panic!("unexpected approval result: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_await_tool_result_skips_unrelated_actions() {
        let (tx, rx) = mpsc::unbounded_channel();
        let receiver = Arc::new(Mutex::new(rx));

        tx.send(TaskAction::Approve {
            tool_call_id: "other_call".to_string(),
        })
        .unwrap();
        tx.send(TaskAction::ToolResult {
            tool_call_id: "target_call".to_string(),
            result: serde_json::json!({"selection": ["recommended"]}),
        })
        .unwrap();

        let response = CoreRuntime::await_tool_result("target_call", receiver)
            .await
            .expect("tool result should resolve");

        match response {
            ToolApproval::ProvidedResult(result) => {
                assert_eq!(result, serde_json::json!({"selection": ["recommended"]}));
            }
            other => panic!("unexpected tool result: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_persist_tool_messages_use_expected_storage_shapes() {
        let (runtime, _temp, mut rx) = create_test_runtime().await;
        let session = runtime
            .session_manager()
            .create_session(None, None, None)
            .await
            .expect("session should be created");

        let request = ToolRequest {
            tool_call_id: "call_1".to_string(),
            name: "readFile".to_string(),
            input: serde_json::json!({"file_path": "/tmp/demo.rs"}),
            provider_metadata: None,
        };
        let result = ToolResult {
            tool_call_id: "call_1".to_string(),
            name: Some("readFile".to_string()),
            success: true,
            output: serde_json::json!({"content": "fn main() {}"}),
            error: None,
        };

        runtime
            .persist_tool_calls_message(
                &session.id,
                std::slice::from_ref(&request),
                &runtime.event_sender,
            )
            .await
            .expect("tool call message should persist");
        runtime
            .persist_tool_result_message(&session.id, &request, &result, &runtime.event_sender)
            .await
            .expect("tool result message should persist");

        let stored_messages = runtime
            .session_manager()
            .get_messages(&session.id, None, None)
            .await
            .expect("messages should load");

        assert_eq!(stored_messages.len(), 2);
        assert!(stored_messages.iter().any(|message| {
            matches!(
                &message.content,
                MessageContent::ToolCalls { calls } if matches!(
                    calls.as_slice(),
                    [ToolCall { id, name, input }] if id == "call_1"
                        && name == "readFile"
                        && input == &serde_json::json!({"file_path": "/tmp/demo.rs"})
                )
            )
        }));
        assert!(stored_messages.iter().any(|message| {
            matches!(
                &message.content,
                MessageContent::ToolResult { result } if result.tool_call_id == "call_1"
                    && result.tool_name == "readFile"
                    && result.output == Some(serde_json::json!({"content": "fn main() {}"}))
                    && matches!(result.status, ToolResultStatus::Success)
            )
        }));

        let emitted_events = vec![rx.recv().await.unwrap(), rx.recv().await.unwrap()];
        assert!(emitted_events.iter().any(|event| {
            matches!(
                event,
                RuntimeEvent::MessageCreated { message, .. }
                    if matches!(message.content, MessageContent::ToolCalls { .. })
            )
        }));
        assert!(emitted_events.iter().any(|event| {
            matches!(
                event,
                RuntimeEvent::MessageCreated { message, .. }
                    if matches!(message.content, MessageContent::ToolResult { .. })
            )
        }));
    }

    #[tokio::test]
    async fn test_persist_nested_tool_messages_store_parent_id() {
        let (runtime, _temp, _rx) = create_test_runtime().await;
        let session = runtime
            .session_manager()
            .create_session(None, None, None)
            .await
            .expect("session should be created");

        let request = ToolRequest {
            tool_call_id: "nested_call".to_string(),
            name: "readFile".to_string(),
            input: serde_json::json!({"file_path": "/tmp/nested.rs"}),
            provider_metadata: None,
        };
        let result = ToolResult {
            tool_call_id: "nested_call".to_string(),
            name: Some("readFile".to_string()),
            success: true,
            output: serde_json::json!({"content": "nested"}),
            error: None,
        };

        runtime
            .persist_tool_calls_message_with_parent(
                &session.id,
                std::slice::from_ref(&request),
                Some("call_agent_parent".to_string()),
                &runtime.event_sender,
            )
            .await
            .expect("nested tool calls should persist");
        runtime
            .persist_tool_result_message_with_parent(
                &session.id,
                &request,
                &result,
                Some("call_agent_parent".to_string()),
                &runtime.event_sender,
            )
            .await
            .expect("nested tool result should persist");

        let stored_messages = runtime
            .session_manager()
            .get_messages(&session.id, None, None)
            .await
            .expect("messages should load");

        assert!(stored_messages.iter().any(|message| {
            message.parent_id.as_deref() == Some("call_agent_parent")
                && matches!(message.content, MessageContent::ToolCalls { .. })
        }));
        assert!(stored_messages.iter().any(|message| {
            message.parent_id.as_deref() == Some("call_agent_parent")
                && matches!(message.content, MessageContent::ToolResult { .. })
        }));
    }

    #[test]
    fn test_extract_tool_result_attachments_ignores_invalid_items() {
        let attachments = CoreRuntime::extract_tool_result_attachments(&serde_json::json!({
            "_attachments": [
                {
                    "id": "attach-1",
                    "type": "image",
                    "filename": "generated.png",
                    "filePath": "/tmp/generated.png",
                    "mimeType": "image/png",
                    "size": 123
                },
                {
                    "type": "unknown",
                    "filename": "skip.bin",
                    "filePath": "/tmp/skip.bin",
                    "mimeType": "application/octet-stream",
                    "size": 10
                },
                {
                    "id": "broken"
                }
            ]
        }));

        assert_eq!(
            attachments,
            vec![ToolMessageAttachment {
                id: "attach-1".to_string(),
                filename: "generated.png".to_string(),
                file_path: "/tmp/generated.png".to_string(),
                mime_type: "image/png".to_string(),
                size: 123,
            }]
        );
    }

    #[tokio::test]
    async fn test_persist_tool_result_message_stores_attachment_references() {
        let (runtime, _temp, _rx) = create_test_runtime().await;
        let session = runtime
            .session_manager()
            .create_session(None, None, None)
            .await
            .expect("session should be created");

        let request = ToolRequest {
            tool_call_id: "image_call_1".to_string(),
            name: "imageGeneration".to_string(),
            input: serde_json::json!({"prompt": "sunset"}),
            provider_metadata: None,
        };
        let result = ToolResult {
            tool_call_id: "image_call_1".to_string(),
            name: Some("imageGeneration".to_string()),
            success: true,
            output: serde_json::json!({
                "success": true,
                "attachments": [{
                    "id": "attach-1",
                    "type": "image",
                    "filename": "generated-1.png",
                    "filePath": "/tmp/generated-1.png",
                    "mimeType": "image/png",
                    "size": 123
                }]
            }),
            error: None,
        };

        runtime
            .persist_tool_result_message(&session.id, &request, &result, &runtime.event_sender)
            .await
            .expect("tool result with attachments should persist");

        let stored_messages = runtime
            .session_manager()
            .get_messages(&session.id, None, None)
            .await
            .expect("messages should load");
        let tool_result_message = stored_messages
            .iter()
            .find(|message| message.tool_call_id.as_deref() == Some("image_call_1"))
            .expect("tool result message should be stored");

        let attachments = runtime
            ._storage
            .attachments
            .list_attachments(&session.id, None)
            .await
            .expect("attachments should load");
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].id, "attach-1");
        assert_eq!(
            attachments[0].message_id.as_deref(),
            Some(tool_result_message.id.as_str())
        );
        assert_eq!(attachments[0].filename, "generated-1.png");
        assert_eq!(attachments[0].path, "/tmp/generated-1.png");
        assert_eq!(attachments[0].mime_type, "image/png");
        assert_eq!(attachments[0].size, 123);
    }

    #[tokio::test]
    async fn test_call_agent_returns_structured_error_when_agent_missing() {
        let (runtime, _temp, _rx) = create_test_runtime().await;
        let session = runtime
            .session_manager()
            .create_session(None, None, None)
            .await
            .expect("session should be created");
        let (action_tx, action_rx) = mpsc::unbounded_channel();
        drop(action_tx);

        let result = runtime
            .execute_call_agent_tool(
                ToolRequest {
                    tool_call_id: "call_agent_1".to_string(),
                    name: "callAgent".to_string(),
                    input: serde_json::json!({
                        "agentId": "missing-agent",
                        "task": "Inspect nested runtime flow",
                    }),
                    provider_metadata: None,
                },
                test_tool_context(&runtime, &session.id, "task_parent"),
                TaskSettings::default(),
                Arc::new(Mutex::new(action_rx)),
                Arc::new(RwLock::new(RuntimeTaskState::Running)),
                runtime.session_manager(),
                runtime.event_sender.clone(),
                "task_parent".to_string(),
            )
            .await
            .expect("missing agent should return tool result");

        assert!(!result.success);
        assert_eq!(
            result.error.as_deref(),
            Some("Agent not found: missing-agent")
        );
        assert_eq!(
            result.output,
            serde_json::json!({
                "task": "Inspect nested runtime flow",
                "success": false,
                "message": "Agent not found: missing-agent",
                "task_result": ""
            })
        );
    }

    #[tokio::test]
    async fn test_execute_tool_request_emits_start_event_and_persists_trace_span() {
        let (runtime, _temp, mut rx) = create_test_runtime().await;
        let session = runtime
            .session_manager()
            .create_session(None, None, None)
            .await
            .expect("session should be created");
        let (_action_tx, action_rx) = mpsc::unbounded_channel();
        let registry = Arc::new(ToolRegistry::create_default().await);
        let dispatcher = Arc::new(ToolDispatcher::new(registry));

        let result = runtime
            .execute_tool_request(
                dispatcher,
                ToolRequest {
                    tool_call_id: "trace_todo_1".to_string(),
                    name: "todoWrite".to_string(),
                    input: serde_json::json!({
                        "todos": [
                            {
                                "id": "todo-1",
                                "content": "Trace runtime tool execution",
                                "status": "pending"
                            }
                        ]
                    }),
                    provider_metadata: None,
                },
                test_tool_context(&runtime, &session.id, "task_trace"),
                TaskSettings::default(),
                Arc::new(Mutex::new(action_rx)),
                Arc::new(RwLock::new(RuntimeTaskState::Running)),
                runtime.session_manager(),
                runtime.event_sender.clone(),
                "task_trace".to_string(),
            )
            .await
            .expect("tool should execute");

        assert!(result.result.success);

        let mut saw_started = false;
        let mut saw_completed = false;
        while let Ok(event) = rx.try_recv() {
            match event {
                RuntimeEvent::ToolCallStarted { request, .. } => {
                    if request.tool_call_id == "trace_todo_1" && request.name == "todoWrite" {
                        saw_started = true;
                    }
                }
                RuntimeEvent::ToolCallCompleted { result, .. } => {
                    if result.tool_call_id == "trace_todo_1" && result.success {
                        saw_completed = true;
                    }
                }
                _ => {}
            }
        }
        assert!(saw_started);
        assert!(saw_completed);

        runtime.trace_writer.request_flush();
        tokio::time::sleep(Duration::from_millis(30)).await;

        let spans = runtime
            ._storage
            .settings
            .get_db()
            .query(
                "SELECT id, name, attributes FROM spans WHERE trace_id = ?",
                vec![serde_json::json!("task_trace")],
            )
            .await
            .expect("spans should be queryable");
        let tool_span = spans
            .rows
            .iter()
            .find(|row| row.get("name") == Some(&serde_json::json!("tool.todoWrite")))
            .expect("tool span should be written");
        let span_id = tool_span
            .get("id")
            .and_then(|value| value.as_str())
            .expect("span id should be present")
            .to_string();
        let attributes: serde_json::Value = serde_json::from_str(
            tool_span
                .get("attributes")
                .and_then(|value| value.as_str())
                .expect("attributes should be stringified json"),
        )
        .expect("attributes should parse");
        assert_eq!(
            attributes.get("toolCallId"),
            Some(&serde_json::json!("trace_todo_1"))
        );
        assert_eq!(
            attributes.get("normalizedToolName"),
            Some(&serde_json::json!("todoWrite"))
        );

        let span_events = runtime
            ._storage
            .settings
            .get_db()
            .query(
                "SELECT event_type, payload FROM span_events WHERE span_id = ?",
                vec![serde_json::json!(span_id)],
            )
            .await
            .expect("span events should be queryable");
        assert!(span_events.rows.iter().any(|row| {
            row.get("event_type") == Some(&serde_json::json!("tool.result"))
                && row
                    .get("payload")
                    .and_then(|value| value.as_str())
                    .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
                    .is_some_and(|payload| {
                        payload.get("success") == Some(&serde_json::json!(true))
                            && payload.get("toolCallId") == Some(&serde_json::json!("trace_todo_1"))
                    })
        }));
    }

    #[tokio::test]
    async fn test_execute_tool_request_collects_hook_additional_context() {
        let (runtime, temp_dir, _rx) = create_test_runtime().await;
        runtime
            ._storage
            .settings
            .set_setting("hooks_enabled", &serde_json::json!(true))
            .await
            .expect("hooks should be enabled");
        tokio::fs::create_dir_all(temp_dir.path().join(".talkcody"))
            .await
            .expect("hooks dir should exist");
        tokio::fs::write(
            temp_dir.path().join(".talkcody/settings.json"),
            serde_json::json!({
                "hooks": {
                    "PostToolUse": [{
                        "matcher": "todoWrite",
                        "hooks": [{
                            "type": "command",
                            "command": "printf '{\"additionalContext\":\"post hook context\"}'"
                        }]
                    }]
                }
            })
            .to_string(),
        )
        .await
        .expect("hook config should persist");

        let session = runtime
            .session_manager()
            .create_session(None, None, None)
            .await
            .expect("session should be created");
        let (_action_tx, action_rx) = mpsc::unbounded_channel();
        let registry = Arc::new(ToolRegistry::create_default().await);
        let dispatcher = Arc::new(ToolDispatcher::new(registry));

        let result = runtime
            .execute_tool_request(
                dispatcher,
                ToolRequest {
                    tool_call_id: "hook_todo_1".to_string(),
                    name: "todoWrite".to_string(),
                    input: serde_json::json!({
                        "todos": [{
                            "id": "todo-1",
                            "content": "Capture hook context",
                            "status": "pending"
                        }]
                    }),
                    provider_metadata: None,
                },
                ToolContext {
                    session_id: session.id.clone(),
                    task_id: "task_hook_ctx".to_string(),
                    workspace_root: temp_dir.path().to_string_lossy().to_string(),
                    worktree_path: None,
                    settings: TaskSettings::default(),
                    subagent_id: None,
                    db: runtime._storage.settings.get_db(),
                },
                TaskSettings::default(),
                Arc::new(Mutex::new(action_rx)),
                Arc::new(RwLock::new(RuntimeTaskState::Running)),
                runtime.session_manager(),
                runtime.event_sender.clone(),
                "task_hook_ctx".to_string(),
            )
            .await
            .expect("tool should execute");

        assert!(result.result.success);
        assert_eq!(
            result.additional_context,
            vec!["post hook context".to_string()]
        );
    }

    #[tokio::test]
    async fn test_call_agent_executes_nested_tool_and_continues_next_iteration() {
        let server = SequentialMockSseServer::start(vec![
            vec![
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "delta": {
                                "tool_calls": [{
                                    "index": 0,
                                    "id": "nested_todo_1",
                                    "function": {
                                        "name": "todoWrite",
                                        "arguments": "{\"todos\":[{\"id\":\"todo-1\",\"content\":\"Draft nested migration checklist\",\"status\":\"in_progress\"}]}"
                                    }
                                }]
                            }
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "finish_reason": "tool_calls",
                            "delta": {}
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: "[DONE]".to_string(),
                },
            ],
            vec![
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "delta": {
                                "content": "Nested todo recorded."
                            }
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "finish_reason": "stop",
                            "delta": {}
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: "[DONE]".to_string(),
                },
            ],
        ])
        .expect("mock server should start");

        let mut provider_registry = ProviderRegistry::default();
        provider_registry.register_provider(ProviderConfig {
            id: "mock-openai".to_string(),
            name: "Mock OpenAI".to_string(),
            protocol: ProtocolType::OpenAiCompatible,
            base_url: server.base_url().to_string(),
            api_key_name: "MOCK_OPENAI_KEY".to_string(),
            supports_oauth: false,
            supports_coding_plan: false,
            supports_international: false,
            coding_plan_base_url: None,
            international_base_url: None,
            headers: None,
            extra_body: None,
            auth_type: AuthType::Bearer,
        });

        let (runtime, _temp, mut rx) = create_test_runtime_with_registry(provider_registry).await;
        configure_mock_provider_and_model(&runtime, server.base_url())
            .await
            .expect("mock provider should be configured");

        let now = chrono::Utc::now().timestamp();
        runtime
            ._storage
            .agents
            .create_agent(&Agent {
                id: "subagent_1".to_string(),
                name: "Nested Planner".to_string(),
                model: "mock-model@mock-openai".to_string(),
                system_prompt: Some("You are a nested planner.".to_string()),
                tools: vec!["todoWrite".to_string()],
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("agent should be created");

        let session = runtime
            .session_manager()
            .create_session(None, None, None)
            .await
            .expect("session should be created");
        let (action_tx, action_rx) = mpsc::unbounded_channel();
        drop(action_tx);

        let result = runtime
            .execute_call_agent_tool(
                ToolRequest {
                    tool_call_id: "call_agent_parent".to_string(),
                    name: "callAgent".to_string(),
                    input: serde_json::json!({
                        "agentId": "subagent_1",
                        "task": "Prepare the migration checklist",
                    }),
                    provider_metadata: None,
                },
                test_tool_context(&runtime, &session.id, "task_parent"),
                TaskSettings::default(),
                Arc::new(Mutex::new(action_rx)),
                Arc::new(RwLock::new(RuntimeTaskState::Running)),
                runtime.session_manager(),
                runtime.event_sender.clone(),
                "task_parent".to_string(),
            )
            .await
            .expect("callAgent should succeed");

        assert!(result.success);
        assert_eq!(
            result.output,
            serde_json::json!({
                "task": "Prepare the migration checklist",
                "success": true,
                "task_result": "Nested todo recorded.",
            })
        );

        let requests = server.recorded_requests();
        assert_eq!(requests.len(), 2);

        let first_messages = requests[0]
            .get("messages")
            .and_then(|value| value.as_array())
            .expect("first request should contain messages");
        assert_eq!(first_messages.len(), 2);
        assert_eq!(
            first_messages[0].get("role"),
            Some(&serde_json::json!("system"))
        );
        assert_eq!(
            first_messages[1].get("content"),
            Some(&serde_json::json!(
                "## Task\nPrepare the migration checklist"
            ))
        );

        let second_messages = requests[1]
            .get("messages")
            .and_then(|value| value.as_array())
            .expect("second request should contain messages");
        assert_eq!(second_messages.len(), 4);
        assert!(second_messages.iter().any(|message| {
            message.get("role") == Some(&serde_json::json!("assistant"))
                && matches!(
                    message.get("tool_calls").and_then(|value| value.as_array()),
                    Some(tool_calls)
                        if matches!(
                            tool_calls.as_slice(),
                            [tool_call]
                                if tool_call.get("id") == Some(&serde_json::json!("nested_todo_1"))
                                    && tool_call.get("function").and_then(|value| value.get("name"))
                                        == Some(&serde_json::json!("todoWrite"))
                        )
                )
        }));
        assert!(second_messages.iter().any(|message| {
            message.get("role") == Some(&serde_json::json!("tool"))
                && message.get("tool_call_id") == Some(&serde_json::json!("nested_todo_1"))
                && message
                    .get("content")
                    .and_then(|value| value.as_str())
                    .is_some_and(|content| content.contains("Draft nested migration checklist"))
        }));

        let todo_file_path = std::path::Path::new(runtime._storage.settings.get_db().db_path())
            .parent()
            .expect("db path should have parent")
            .join("todos")
            .join("call_agent_parent.json");
        let persisted_todos =
            std::fs::read_to_string(todo_file_path).expect("nested todos should be persisted");
        let persisted_todos: serde_json::Value =
            serde_json::from_str(&persisted_todos).expect("todo payload should parse");
        assert_eq!(
            persisted_todos.get("taskId"),
            Some(&serde_json::json!("call_agent_parent"))
        );

        let stored_messages = runtime
            .session_manager()
            .get_messages(&session.id, None, None)
            .await
            .expect("messages should load");
        assert!(stored_messages.iter().any(|message| {
            message.parent_id.as_deref() == Some("call_agent_parent")
                && matches!(message.content, MessageContent::ToolCalls { .. })
        }));
        assert!(stored_messages.iter().any(|message| {
            message.parent_id.as_deref() == Some("call_agent_parent")
                && matches!(message.content, MessageContent::ToolResult { .. })
        }));
        assert!(stored_messages.iter().any(|message| {
            message.parent_id.as_deref() == Some("call_agent_parent")
                && matches!(
                    &message.content,
                    MessageContent::Text { text } if text == "Nested todo recorded."
                )
        }));

        let mut message_created_events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let RuntimeEvent::MessageCreated { message, .. } = event {
                message_created_events.push(message);
            }
        }
        assert!(message_created_events.iter().any(|message| {
            message.parent_id.as_deref() == Some("call_agent_parent")
                && matches!(message.content, MessageContent::ToolCalls { .. })
        }));
        assert!(message_created_events.iter().any(|message| {
            message.parent_id.as_deref() == Some("call_agent_parent")
                && matches!(message.content, MessageContent::ToolResult { .. })
        }));
        assert!(message_created_events.iter().any(|message| {
            message.parent_id.as_deref() == Some("call_agent_parent")
                && matches!(
                    &message.content,
                    MessageContent::Text { text } if text == "Nested todo recorded."
                )
        }));
    }

    #[tokio::test]
    async fn test_runtime_auto_continues_truncated_completion() {
        let server = SequentialMockSseServer::start(vec![
            vec![
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "delta": { "content": "Part 1" }
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "finish_reason": "length",
                            "delta": {}
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: "[DONE]".to_string(),
                },
            ],
            vec![
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "delta": { "content": "Part 2" }
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "finish_reason": "stop",
                            "delta": {}
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: "[DONE]".to_string(),
                },
            ],
        ])
        .expect("mock server should start");

        let mut provider_registry = ProviderRegistry::default();
        provider_registry.register_provider(ProviderConfig {
            id: "mock-openai".to_string(),
            name: "Mock OpenAI".to_string(),
            protocol: ProtocolType::OpenAiCompatible,
            base_url: server.base_url().to_string(),
            api_key_name: "MOCK_OPENAI_KEY".to_string(),
            supports_oauth: false,
            supports_coding_plan: false,
            supports_international: false,
            coding_plan_base_url: None,
            international_base_url: None,
            headers: None,
            extra_body: None,
            auth_type: AuthType::Bearer,
        });

        let (runtime, _temp, _rx) = create_test_runtime_with_registry(provider_registry).await;
        configure_mock_provider_and_model(&runtime, server.base_url())
            .await
            .expect("mock provider should be configured");

        let session = runtime
            .session_manager()
            .create_session(None, None, None)
            .await
            .expect("session should be created");

        let handle = runtime
            .start_task(TaskInput {
                session_id: session.id.clone(),
                agent_id: None,
                project_id: None,
                initial_message: "Write the migration summary".to_string(),
                settings: Some(TaskSettings {
                    auto_approve_edits: None,
                    auto_approve_plan: None,
                    auto_code_review: None,
                    extra: HashMap::from([(
                        "model".to_string(),
                        serde_json::json!("mock-model@mock-openai"),
                    )]),
                }),
                workspace: None,
            })
            .await
            .expect("task should start");

        wait_for_terminal_state(&handle).await;
        assert_eq!(*handle.state.read().await, RuntimeTaskState::Completed);

        let requests = server.recorded_requests();
        assert_eq!(requests.len(), 2);
        let second_messages = requests[1]
            .get("messages")
            .and_then(|value| value.as_array())
            .expect("second request should contain messages");
        assert!(second_messages.iter().any(|message| {
            message.get("role") == Some(&serde_json::json!("user"))
                && message.get("content")
                    == Some(&serde_json::json!("Continue from where you left off."))
        }));

        let stored_messages = runtime
            .session_manager()
            .get_messages(&session.id, None, None)
            .await
            .expect("messages should load");
        assert!(stored_messages.iter().any(|message| {
            matches!(
                &message.content,
                MessageContent::Text { text } if text == "Part 1"
            )
        }));
        assert!(stored_messages.iter().any(|message| {
            matches!(
                &message.content,
                MessageContent::Text { text } if text == "Part 2"
            )
        }));
    }

    #[tokio::test]
    async fn test_runtime_retries_unknown_finish_reason_without_persisting_partial_output() {
        let server = SequentialMockSseServer::start(vec![
            vec![
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "delta": { "content": "Transient partial" }
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "finish_reason": "other",
                            "delta": {}
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: "[DONE]".to_string(),
                },
            ],
            vec![
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "delta": { "content": "Recovered answer" }
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "finish_reason": "stop",
                            "delta": {}
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: "[DONE]".to_string(),
                },
            ],
        ])
        .expect("mock server should start");

        let mut provider_registry = ProviderRegistry::default();
        provider_registry.register_provider(ProviderConfig {
            id: "mock-openai".to_string(),
            name: "Mock OpenAI".to_string(),
            protocol: ProtocolType::OpenAiCompatible,
            base_url: server.base_url().to_string(),
            api_key_name: "MOCK_OPENAI_KEY".to_string(),
            supports_oauth: false,
            supports_coding_plan: false,
            supports_international: false,
            coding_plan_base_url: None,
            international_base_url: None,
            headers: None,
            extra_body: None,
            auth_type: AuthType::Bearer,
        });

        let (runtime, _temp, _rx) = create_test_runtime_with_registry(provider_registry).await;
        configure_mock_provider_and_model(&runtime, server.base_url())
            .await
            .expect("mock provider should be configured");

        let session = runtime
            .session_manager()
            .create_session(None, None, None)
            .await
            .expect("session should be created");

        let handle = runtime
            .start_task(TaskInput {
                session_id: session.id.clone(),
                agent_id: None,
                project_id: None,
                initial_message: "Retry until the provider settles".to_string(),
                settings: Some(TaskSettings {
                    auto_approve_edits: None,
                    auto_approve_plan: None,
                    auto_code_review: None,
                    extra: HashMap::from([(
                        "model".to_string(),
                        serde_json::json!("mock-model@mock-openai"),
                    )]),
                }),
                workspace: None,
            })
            .await
            .expect("task should start");

        wait_for_terminal_state(&handle).await;
        assert_eq!(*handle.state.read().await, RuntimeTaskState::Completed);

        let requests = server.recorded_requests();
        assert_eq!(requests.len(), 2);
        let second_messages = requests[1]
            .get("messages")
            .and_then(|value| value.as_array())
            .expect("second request should contain messages");
        assert!(!second_messages.iter().any(|message| {
            message.get("role") == Some(&serde_json::json!("assistant"))
                && message.get("content") == Some(&serde_json::json!("Transient partial"))
        }));

        let stored_messages = runtime
            .session_manager()
            .get_messages(&session.id, None, None)
            .await
            .expect("messages should load");
        assert!(!stored_messages.iter().any(|message| {
            matches!(
                &message.content,
                MessageContent::Text { text } if text == "Transient partial"
            )
        }));
        assert!(stored_messages.iter().any(|message| {
            matches!(
                &message.content,
                MessageContent::Text { text } if text == "Recovered answer"
            )
        }));
    }

    #[tokio::test]
    async fn test_runtime_completion_hook_iterates_with_transient_context_message() {
        let server = SequentialMockSseServer::start(vec![
            vec![
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "delta": { "content": "I need to inspect more files." }
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "finish_reason": "stop",
                            "delta": {}
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: "[DONE]".to_string(),
                },
            ],
            vec![
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "delta": { "content": "Finished analysis." }
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: serde_json::json!({
                        "choices": [{
                            "finish_reason": "stop",
                            "delta": {}
                        }]
                    })
                    .to_string(),
                },
                RecordedSseEvent {
                    event: None,
                    data: "[DONE]".to_string(),
                },
            ],
        ])
        .expect("mock server should start");

        let mut provider_registry = ProviderRegistry::default();
        provider_registry.register_provider(ProviderConfig {
            id: "mock-openai".to_string(),
            name: "Mock OpenAI".to_string(),
            protocol: ProtocolType::OpenAiCompatible,
            base_url: server.base_url().to_string(),
            api_key_name: "MOCK_OPENAI_KEY".to_string(),
            supports_oauth: false,
            supports_coding_plan: false,
            supports_international: false,
            coding_plan_base_url: None,
            international_base_url: None,
            headers: None,
            extra_body: None,
            auth_type: AuthType::Bearer,
        });

        let (runtime, _temp, _rx) = create_test_runtime_with_registry(provider_registry).await;
        configure_mock_provider_and_model(&runtime, server.base_url())
            .await
            .expect("mock provider should be configured");

        let session = runtime
            .session_manager()
            .create_session(None, None, None)
            .await
            .expect("session should be created");

        let handle = runtime
            .start_task(TaskInput {
                session_id: session.id.clone(),
                agent_id: None,
                project_id: None,
                initial_message: "Finish the migration review".to_string(),
                settings: Some(TaskSettings {
                    auto_approve_edits: None,
                    auto_approve_plan: None,
                    auto_code_review: None,
                    extra: HashMap::from([
                        (
                            "model".to_string(),
                            serde_json::json!("mock-model@mock-openai"),
                        ),
                        ("ralphLoopEnabled".to_string(), serde_json::json!(true)),
                    ]),
                }),
                workspace: None,
            })
            .await
            .expect("task should start");

        wait_for_terminal_state(&handle).await;
        assert_eq!(*handle.state.read().await, RuntimeTaskState::Completed);

        let requests = server.recorded_requests();
        assert_eq!(requests.len(), 2);
        let second_messages = requests[1]
            .get("messages")
            .and_then(|value| value.as_array())
            .expect("second request should contain messages");
        assert!(second_messages.iter().any(|message| {
            message.get("role") == Some(&serde_json::json!("user"))
                && message.get("content")
                    == Some(&serde_json::json!(
                        "Task appears incomplete, continuing with next steps"
                    ))
        }));
    }

    #[tokio::test]
    async fn test_runtime_session_start_hook_injects_system_context() {
        let server = SequentialMockSseServer::start(vec![vec![
            RecordedSseEvent {
                event: None,
                data: serde_json::json!({
                    "choices": [{
                        "delta": { "content": "Done." }
                    }]
                })
                .to_string(),
            },
            RecordedSseEvent {
                event: None,
                data: serde_json::json!({
                    "choices": [{
                        "finish_reason": "stop",
                        "delta": {}
                    }]
                })
                .to_string(),
            },
            RecordedSseEvent {
                event: None,
                data: "[DONE]".to_string(),
            },
        ]])
        .expect("mock server should start");

        let mut provider_registry = ProviderRegistry::default();
        provider_registry.register_provider(ProviderConfig {
            id: "mock-openai".to_string(),
            name: "Mock OpenAI".to_string(),
            protocol: ProtocolType::OpenAiCompatible,
            base_url: server.base_url().to_string(),
            api_key_name: "MOCK_OPENAI_KEY".to_string(),
            supports_oauth: false,
            supports_coding_plan: false,
            supports_international: false,
            coding_plan_base_url: None,
            international_base_url: None,
            headers: None,
            extra_body: None,
            auth_type: AuthType::Bearer,
        });

        let (runtime, temp_dir, _rx) = create_test_runtime_with_registry(provider_registry).await;
        configure_mock_provider_and_model(&runtime, server.base_url())
            .await
            .expect("mock provider should be configured");
        runtime
            ._storage
            .settings
            .set_setting("hooks_enabled", &serde_json::json!(true))
            .await
            .expect("hooks should be enabled");
        tokio::fs::create_dir_all(temp_dir.path().join(".talkcody"))
            .await
            .expect("hooks dir should exist");
        tokio::fs::write(
            temp_dir.path().join(".talkcody/settings.json"),
            serde_json::json!({
                "hooks": {
                    "SessionStart": [{
                        "hooks": [{
                            "type": "command",
                            "command": "printf '{\"additionalContext\":\"session start context\"}'"
                        }]
                    }]
                }
            })
            .to_string(),
        )
        .await
        .expect("hook config should persist");

        let session = runtime
            .session_manager()
            .create_session(None, None, None)
            .await
            .expect("session should be created");

        let handle = runtime
            .start_task(TaskInput {
                session_id: session.id.clone(),
                agent_id: None,
                project_id: None,
                initial_message: "Start with hook context".to_string(),
                settings: Some(TaskSettings {
                    auto_approve_edits: None,
                    auto_approve_plan: None,
                    auto_code_review: None,
                    extra: HashMap::from([(
                        "model".to_string(),
                        serde_json::json!("mock-model@mock-openai"),
                    )]),
                }),
                workspace: Some(WorkspaceInfo {
                    root_path: temp_dir.path().to_string_lossy().to_string(),
                    worktree_path: None,
                    repository_url: None,
                    branch: None,
                }),
            })
            .await
            .expect("task should start");

        wait_for_terminal_state(&handle).await;
        assert_eq!(*handle.state.read().await, RuntimeTaskState::Completed);

        let requests = server.recorded_requests();
        assert_eq!(requests.len(), 1);
        let first_messages = requests[0]
            .get("messages")
            .and_then(|value| value.as_array())
            .expect("first request should contain messages");
        assert!(first_messages.iter().any(|message| {
            message.get("role") == Some(&serde_json::json!("system"))
                && message.get("content") == Some(&serde_json::json!("session start context"))
        }));
    }
}
