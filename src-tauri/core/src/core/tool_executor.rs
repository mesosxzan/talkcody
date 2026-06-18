//! Tool Executor
//!
//! Executes tool calls with smart dependency-aware concurrency.
//! Ported from TypeScript `src/services/agents/tool-executor.ts`.

use crate::core::tool_definitions::{get_tool_definitions, ToolMetadata};
use crate::core::tool_dependency_analyzer::{
    ExecutionGroup, ExecutionPlan, ExecutionStage, ToolDependencyAnalyzer,
};
use crate::core::types::{ToolRequest, ToolResult};
use futures_util::future::join_all;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

/// Executes tool calls using the Rust dependency analyzer.
pub struct ToolExecutor {
    dependency_analyzer: ToolDependencyAnalyzer,
    tool_metadata: HashMap<String, ToolMetadata>,
}

impl ToolExecutor {
    const MAX_JSON_PARSE_DEPTH: usize = 10;

    pub fn new() -> Self {
        let tool_metadata = get_tool_definitions()
            .into_iter()
            .map(|(definition, metadata)| (definition.name, metadata))
            .collect();

        Self {
            dependency_analyzer: ToolDependencyAnalyzer::new(),
            tool_metadata,
        }
    }

    /// Execute tool calls using the analyzer-generated execution plan.
    pub async fn execute_with_smart_concurrency<F, Fut>(
        &self,
        tool_calls: Vec<ToolRequest>,
        execute_tool: F,
    ) -> Vec<(ToolRequest, ToolResult)>
    where
        F: Fn(ToolRequest) -> Fut + Send + Sync,
        Fut: Future<Output = ToolResult> + Send,
    {
        let execute_tool = Arc::new(execute_tool);
        let normalized_calls = tool_calls
            .into_iter()
            .map(|tool_call| self.normalize_tool_request(tool_call))
            .collect::<Vec<_>>();
        let plan = self
            .dependency_analyzer
            .analyze(normalized_calls, &self.tool_metadata);

        self.execute_plan(plan, execute_tool).await
    }

    async fn execute_plan<F, Fut>(
        &self,
        plan: ExecutionPlan,
        execute_tool: Arc<F>,
    ) -> Vec<(ToolRequest, ToolResult)>
    where
        F: Fn(ToolRequest) -> Fut + Send + Sync,
        Fut: Future<Output = ToolResult> + Send,
    {
        let mut all_results = Vec::new();

        for stage in plan.stages {
            let stage_results = self.execute_stage(stage, execute_tool.clone()).await;
            all_results.extend(stage_results);
        }

        all_results
    }

    async fn execute_stage<F, Fut>(
        &self,
        stage: ExecutionStage,
        execute_tool: Arc<F>,
    ) -> Vec<(ToolRequest, ToolResult)>
    where
        F: Fn(ToolRequest) -> Fut + Send + Sync,
        Fut: Future<Output = ToolResult> + Send,
    {
        let mut results = Vec::new();

        for group in stage.groups {
            let group_results = self.execute_group(group, execute_tool.clone()).await;
            results.extend(group_results);
        }

        results
    }

    async fn execute_group<F, Fut>(
        &self,
        group: ExecutionGroup,
        execute_tool: Arc<F>,
    ) -> Vec<(ToolRequest, ToolResult)>
    where
        F: Fn(ToolRequest) -> Fut + Send + Sync,
        Fut: Future<Output = ToolResult> + Send,
    {
        if group.concurrent && group.tools.len() > 1 {
            self.execute_concurrent(group.tools, group.max_concurrency, execute_tool)
                .await
        } else {
            self.execute_sequential(group.tools, execute_tool).await
        }
    }

    async fn execute_concurrent<F, Fut>(
        &self,
        tool_calls: Vec<ToolRequest>,
        max_concurrency: Option<usize>,
        execute_tool: Arc<F>,
    ) -> Vec<(ToolRequest, ToolResult)>
    where
        F: Fn(ToolRequest) -> Fut + Send + Sync,
        Fut: Future<Output = ToolResult> + Send,
    {
        let mut results = Vec::new();
        let limit = max_concurrency
            .filter(|value| *value > 0)
            .unwrap_or(tool_calls.len())
            .min(tool_calls.len().max(1));

        for batch in tool_calls.chunks(limit) {
            let futures = batch.iter().map(|tool_call| {
                let executor = execute_tool.clone();
                let tool_call = tool_call.clone();
                async move {
                    let result = executor(tool_call.clone()).await;
                    (tool_call, result)
                }
            });
            results.extend(join_all(futures).await);
        }

        results
    }

    async fn execute_sequential<F, Fut>(
        &self,
        tool_calls: Vec<ToolRequest>,
        execute_tool: Arc<F>,
    ) -> Vec<(ToolRequest, ToolResult)>
    where
        F: Fn(ToolRequest) -> Fut + Send + Sync,
        Fut: Future<Output = ToolResult> + Send,
    {
        let mut results = Vec::new();

        for tool_call in tool_calls {
            let result = execute_tool(tool_call.clone()).await;
            results.push((tool_call, result));
        }

        results
    }

    fn normalize_tool_request(&self, mut tool_call: ToolRequest) -> ToolRequest {
        if tool_call.input.is_object() {
            tool_call.input = self.parse_nested_json_strings(tool_call.input, 0);
        }
        tool_call
    }

    fn parse_nested_json_strings(&self, value: Value, depth: usize) -> Value {
        if depth > Self::MAX_JSON_PARSE_DEPTH {
            return value;
        }

        match value {
            Value::Array(items) => Value::Array(
                items
                    .into_iter()
                    .map(|item| self.parse_nested_json_strings(item, depth + 1))
                    .collect(),
            ),
            Value::Object(map) => {
                let parse_json_fields = [
                    "edits",
                    "file_types",
                    "targets",
                    "todos",
                    "questions",
                    "options",
                    "args",
                    "environment",
                ];

                let normalized = map
                    .into_iter()
                    .map(|(key, raw_value)| {
                        let parsed_value = match raw_value {
                            Value::String(text) if parse_json_fields.contains(&key.as_str()) => {
                                let trimmed = text.trim();
                                if (trimmed.starts_with('[') && trimmed.ends_with(']'))
                                    || (trimmed.starts_with('{') && trimmed.ends_with('}'))
                                {
                                    serde_json::from_str::<Value>(&text)
                                        .unwrap_or(Value::String(text))
                                } else {
                                    Value::String(text)
                                }
                            }
                            other => self.parse_nested_json_strings(other, depth + 1),
                        };
                        (key, parsed_value)
                    })
                    .collect();

                Value::Object(normalized)
            }
            other => other,
        }
    }
}

impl Default for ToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::types::ToolRequest;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Mutex;

    fn read_tool_request(id: &str) -> ToolRequest {
        ToolRequest {
            tool_call_id: id.to_string(),
            name: "readFile".to_string(),
            input: serde_json::json!({ "file_path": format!("/tmp/{}.txt", id) }),
            provider_metadata: None,
        }
    }

    #[tokio::test]
    async fn parses_stringified_nested_fields_before_execution() {
        let executor = ToolExecutor::new();
        let tool_call = ToolRequest {
            tool_call_id: "edit-1".to_string(),
            name: "editFile".to_string(),
            input: serde_json::json!({
                "file_path": "/tmp/demo.txt",
                "edits": "[{\"old_string\":\"a\",\"new_string\":\"b\"}]"
            }),
            provider_metadata: None,
        };

        let captured = Arc::new(Mutex::new(Value::Null));
        let captured_clone = captured.clone();

        let results = executor
            .execute_with_smart_concurrency(vec![tool_call], move |request| {
                let captured = captured_clone.clone();
                async move {
                    *captured.lock().await = request.input.clone();
                    ToolResult {
                        tool_call_id: request.tool_call_id,
                        name: Some(request.name),
                        success: true,
                        output: serde_json::json!({"ok": true}),
                        error: None,
                    }
                }
            })
            .await;

        assert_eq!(results.len(), 1);
        assert!(captured
            .lock()
            .await
            .get("edits")
            .and_then(|value| value.as_array())
            .is_some());
    }

    #[tokio::test]
    async fn executes_read_tools_concurrently() {
        let executor = ToolExecutor::new();
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        let requests = vec![
            read_tool_request("one"),
            read_tool_request("two"),
            read_tool_request("three"),
        ];

        let results = executor
            .execute_with_smart_concurrency(requests, {
                let running = running.clone();
                let peak = peak.clone();
                move |request| {
                    let running = running.clone();
                    let peak = peak.clone();
                    async move {
                        let current = running.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(current, Ordering::SeqCst);
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                        running.fetch_sub(1, Ordering::SeqCst);

                        ToolResult {
                            tool_call_id: request.tool_call_id,
                            name: Some(request.name),
                            success: true,
                            output: serde_json::json!({"ok": true}),
                            error: None,
                        }
                    }
                }
            })
            .await;

        assert_eq!(results.len(), 3);
        assert!(peak.load(Ordering::SeqCst) > 1);
    }

    #[tokio::test]
    async fn executes_write_tools_sequentially() {
        let executor = ToolExecutor::new();
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        let requests = vec![
            ToolRequest {
                tool_call_id: "write-1".to_string(),
                name: "writeFile".to_string(),
                input: serde_json::json!({"file_path": "/tmp/demo.txt", "content": "a"}),
                provider_metadata: None,
            },
            ToolRequest {
                tool_call_id: "write-2".to_string(),
                name: "editFile".to_string(),
                input: serde_json::json!({
                    "file_path": "/tmp/demo.txt",
                    "edits": [{"old_string": "a", "new_string": "b"}]
                }),
                provider_metadata: None,
            },
        ];

        let results = executor
            .execute_with_smart_concurrency(requests, {
                let running = running.clone();
                let peak = peak.clone();
                move |request| {
                    let running = running.clone();
                    let peak = peak.clone();
                    async move {
                        let current = running.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(current, Ordering::SeqCst);
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                        running.fetch_sub(1, Ordering::SeqCst);

                        ToolResult {
                            tool_call_id: request.tool_call_id,
                            name: Some(request.name),
                            success: true,
                            output: serde_json::json!({"ok": true}),
                            error: None,
                        }
                    }
                }
            })
            .await;

        assert_eq!(results.len(), 2);
        assert_eq!(peak.load(Ordering::SeqCst), 1);
    }
}
