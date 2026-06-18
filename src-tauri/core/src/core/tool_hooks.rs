use crate::core::tools::ToolContext;
use crate::core::types::{ToolRequest, ToolResult};
use crate::shell_utils::new_async_command;
use crate::storage::TaskSettings;
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;

const DEFAULT_TIMEOUT_SEC: u64 = 60;
const HOOK_BLOCK_EXIT_CODE: i32 = 2;
const HOOKS_SETTINGS_FILE: &str = "settings.json";
const TALKCODY_DIR: &str = ".talkcody";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HookRunSummary {
    pub blocked: bool,
    pub block_reason: Option<String>,
    pub permission_decision: Option<String>,
    pub permission_decision_reason: Option<String>,
    pub updated_input: Option<serde_json::Value>,
    pub additional_context: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct HooksConfigFile {
    #[serde(default)]
    hooks: std::collections::HashMap<String, Vec<HookRule>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct HookRule {
    matcher: Option<String>,
    #[serde(default)]
    hooks: Vec<HookCommand>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct HookCommand {
    #[serde(rename = "type")]
    command_type: String,
    command: String,
    timeout: Option<u64>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct HookOutputCommon {
    decision: Option<String>,
    reason: Option<String>,
    #[serde(rename = "additionalContext")]
    additional_context: Option<String>,
    #[serde(rename = "updatedInput")]
    updated_input: Option<serde_json::Value>,
    #[serde(rename = "hookSpecificOutput")]
    hook_specific_output: Option<HookSpecificOutput>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct HookSpecificOutput {
    #[serde(rename = "additionalContext")]
    additional_context: Option<String>,
    #[serde(rename = "updatedInput")]
    updated_input: Option<serde_json::Value>,
    #[serde(rename = "permissionDecision")]
    permission_decision: Option<String>,
    #[serde(rename = "permissionDecisionReason")]
    permission_decision_reason: Option<String>,
}

#[derive(Debug, Clone)]
struct HookCommandResult {
    output: Option<HookOutputCommon>,
    raw_stdout: String,
    raw_stderr: String,
    exit_code: i32,
}

#[derive(Debug, Clone, Default)]
pub struct HookRunner;

impl HookRunner {
    pub fn new() -> Self {
        Self
    }

    pub async fn run_pre_tool_use(
        &self,
        request: &ToolRequest,
        context: &ToolContext,
    ) -> Result<HookRunSummary, String> {
        let input = serde_json::json!({
            "session_id": context.session_id,
            "cwd": Self::hook_cwd(context),
            "permission_mode": "default",
            "hook_event_name": "PreToolUse",
            "tool_name": request.name,
            "tool_input": request.input,
            "tool_use_id": request.tool_call_id,
        });
        self.run_hooks("PreToolUse", &request.name, input, context)
            .await
    }

    pub async fn run_post_tool_use(
        &self,
        request: &ToolRequest,
        context: &ToolContext,
        result: &ToolResult,
    ) -> Result<HookRunSummary, String> {
        let tool_response = if result.success {
            result.output.clone()
        } else {
            serde_json::json!({
                "success": false,
                "output": result.output,
                "error": result.error,
            })
        };
        let input = serde_json::json!({
            "session_id": context.session_id,
            "cwd": Self::hook_cwd(context),
            "permission_mode": "default",
            "hook_event_name": "PostToolUse",
            "tool_name": request.name,
            "tool_input": request.input,
            "tool_response": tool_response,
            "tool_use_id": request.tool_call_id,
        });
        self.run_hooks("PostToolUse", &request.name, input, context)
            .await
    }

    pub async fn run_session_start(
        &self,
        session_id: &str,
        cwd: &str,
        settings: &TaskSettings,
        db: std::sync::Arc<crate::database::Database>,
        source: &str,
    ) -> Result<HookRunSummary, String> {
        let context = ToolContext {
            session_id: session_id.to_string(),
            task_id: format!("session_start_{}", session_id),
            workspace_root: cwd.to_string(),
            worktree_path: None,
            settings: settings.clone(),
            subagent_id: None,
            db,
        };
        let input = serde_json::json!({
            "session_id": session_id,
            "cwd": cwd,
            "permission_mode": "default",
            "hook_event_name": "SessionStart",
            "source": source,
        });
        self.run_hooks("SessionStart", "", input, &context).await
    }

    async fn run_hooks(
        &self,
        event: &str,
        matcher_value: &str,
        input: serde_json::Value,
        context: &ToolContext,
    ) -> Result<HookRunSummary, String> {
        if !Self::hooks_enabled(context).await? {
            return Ok(HookRunSummary::default());
        }

        let hooks = self
            .load_matching_hooks(event, matcher_value, context)
            .await?;
        if hooks.is_empty() {
            return Ok(HookRunSummary::default());
        }

        let results = join_all(hooks.iter().map(|hook| {
            let input = input.clone();
            async move { self.execute_hook_command(hook, &input, context).await }
        }))
        .await;

        let mut summary = HookRunSummary::default();
        for result in results {
            let result = match result {
                Ok(result) => result,
                Err(_error) => HookCommandResult {
                    output: None,
                    raw_stdout: String::new(),
                    raw_stderr: String::new(),
                    exit_code: 1,
                },
            };
            if result.exit_code == HOOK_BLOCK_EXIT_CODE {
                summary.blocked = true;
                summary.block_reason = Some(
                    [result.raw_stdout.as_str(), result.raw_stderr.as_str()]
                        .iter()
                        .filter_map(|value| {
                            let trimmed = value.trim();
                            (!trimmed.is_empty()).then_some(trimmed)
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                        .trim()
                        .to_string(),
                )
                .filter(|value| !value.is_empty())
                .or_else(|| Some("Hook blocked execution.".to_string()));
                continue;
            }

            if result.exit_code == 0 {
                Self::apply_hook_output(&mut summary, result.output);
            }
        }

        Ok(summary)
    }

    async fn hooks_enabled(context: &ToolContext) -> Result<bool, String> {
        if let Some(value) = context.settings.extra.get("hooks_enabled") {
            return Ok(Self::parse_bool_value(value));
        }
        if let Some(value) = context.settings.extra.get("hooksEnabled") {
            return Ok(Self::parse_bool_value(value));
        }

        let result = context
            .db
            .query(
                "SELECT value FROM settings WHERE key = ?",
                vec![serde_json::json!("hooks_enabled")],
            )
            .await?;
        let Some(raw_value) = result
            .rows
            .first()
            .and_then(|row| row.get("value"))
            .and_then(|value| value.as_str())
        else {
            return Ok(false);
        };

        let parsed_value = serde_json::from_str::<serde_json::Value>(raw_value)
            .unwrap_or_else(|_| serde_json::Value::String(raw_value.to_string()));
        Ok(Self::parse_bool_value(&parsed_value))
    }

    fn parse_bool_value(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::Bool(boolean) => *boolean,
            serde_json::Value::String(text) => text.eq_ignore_ascii_case("true"),
            _ => false,
        }
    }

    async fn load_matching_hooks(
        &self,
        event: &str,
        matcher_value: &str,
        context: &ToolContext,
    ) -> Result<Vec<HookCommand>, String> {
        let mut hooks = Vec::new();
        for config in self.load_configs(context).await? {
            let Some(rules) = config.hooks.get(event) else {
                continue;
            };
            for rule in rules {
                if rule.enabled == Some(false) || rule.hooks.is_empty() {
                    continue;
                }
                if !Self::matcher_matches(rule.matcher.as_deref().unwrap_or(""), matcher_value) {
                    continue;
                }
                for hook in &rule.hooks {
                    if hook.enabled == Some(false)
                        || hook.command.trim().is_empty()
                        || hook.command_type != "command"
                    {
                        continue;
                    }
                    hooks.push(hook.clone());
                }
            }
        }
        Ok(hooks)
    }

    async fn load_configs(&self, context: &ToolContext) -> Result<Vec<HooksConfigFile>, String> {
        let mut configs = Vec::new();
        if let Some(user_path) = Self::user_config_path() {
            configs.push(Self::read_config(user_path).await?);
        }
        configs.push(
            Self::read_config(
                PathBuf::from(Self::hook_cwd(context))
                    .join(TALKCODY_DIR)
                    .join(HOOKS_SETTINGS_FILE),
            )
            .await?,
        );
        Ok(configs)
    }

    async fn read_config(path: PathBuf) -> Result<HooksConfigFile, String> {
        match tokio::fs::read_to_string(path).await {
            Ok(raw) => serde_json::from_str(&raw)
                .map_err(|error| format!("Failed to parse hook config JSON: {}", error)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(HooksConfigFile::default()),
            Err(error) => Err(format!("Failed to read hook config: {}", error)),
        }
    }

    fn user_config_path() -> Option<PathBuf> {
        dirs::home_dir().map(|home| home.join(TALKCODY_DIR).join(HOOKS_SETTINGS_FILE))
    }

    fn hook_cwd(context: &ToolContext) -> String {
        context
            .worktree_path
            .clone()
            .unwrap_or_else(|| context.workspace_root.clone())
    }

    fn matcher_matches(matcher: &str, value: &str) -> bool {
        let matcher = matcher.trim();
        if matcher.is_empty() || matcher == "*" || matcher == value {
            return true;
        }
        regex::Regex::new(matcher)
            .map(|regex| regex.is_match(value))
            .unwrap_or(false)
    }

    async fn execute_hook_command(
        &self,
        hook: &HookCommand,
        input: &serde_json::Value,
        context: &ToolContext,
    ) -> Result<HookCommandResult, String> {
        let mut command = if cfg!(windows) {
            let mut cmd = new_async_command("cmd");
            cmd.arg("/C").arg(&hook.command);
            cmd
        } else {
            let mut cmd = new_async_command("sh");
            cmd.arg("-c").arg(&hook.command);
            cmd
        };

        command
            .current_dir(Self::hook_cwd(context))
            .env("TALKCODY_PROJECT_DIR", Self::hook_cwd(context))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|error| format!("Failed to spawn hook command: {}", error))?;
        let payload = serde_json::to_vec(input)
            .map_err(|error| format!("Failed to serialize hook input: {}", error))?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin
                .write_all(&payload)
                .await
                .map_err(|error| format!("Failed to write hook input: {}", error))?;
        }
        let _ = child.stdin.take();

        let timeout = std::time::Duration::from_secs(hook.timeout.unwrap_or(DEFAULT_TIMEOUT_SEC));
        let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(result) => result.map_err(|error| format!("Failed to wait for hook: {}", error))?,
            Err(_) => {
                return Err(format!(
                    "Hook execution timed out after {} seconds",
                    hook.timeout.unwrap_or(DEFAULT_TIMEOUT_SEC)
                ));
            }
        };

        let raw_stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let raw_stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let parsed_output = Self::parse_json_output(&raw_stdout);
        Ok(HookCommandResult {
            output: parsed_output,
            raw_stdout,
            raw_stderr,
            exit_code: output.status.code().unwrap_or(-1),
        })
    }

    fn parse_json_output(stdout: &str) -> Option<HookOutputCommon> {
        let trimmed = stdout.trim();
        if !(trimmed.starts_with('{') && trimmed.ends_with('}')) {
            return None;
        }
        serde_json::from_str(trimmed).ok()
    }

    fn apply_hook_output(summary: &mut HookRunSummary, output: Option<HookOutputCommon>) {
        let Some(output) = output else {
            return;
        };

        if let Some(context) = output
            .additional_context
            .filter(|value| !value.trim().is_empty())
        {
            summary.additional_context.push(context);
        }
        if let Some(updated_input) = output.updated_input {
            summary.updated_input = Some(updated_input);
        }

        if let Some(hook_specific) = output.hook_specific_output {
            if let Some(context) = hook_specific
                .additional_context
                .filter(|value| !value.trim().is_empty())
            {
                summary.additional_context.push(context);
            }
            if let Some(updated_input) = hook_specific.updated_input {
                summary.updated_input = Some(updated_input);
            }
            if let Some(permission_decision) = hook_specific.permission_decision {
                summary.permission_decision = Some(permission_decision);
                summary.permission_decision_reason = hook_specific.permission_decision_reason;
            }
        }

        if matches!(output.decision.as_deref(), Some("block" | "deny")) {
            summary.blocked = true;
            summary.block_reason = output.reason;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;
    use crate::storage::TaskSettings;
    use tempfile::TempDir;

    async fn create_test_context() -> (ToolContext, TempDir) {
        let temp_dir = TempDir::new().expect("temp dir");
        let storage = Storage::new(
            temp_dir.path().to_path_buf(),
            temp_dir.path().join("attachments"),
        )
        .await
        .expect("storage should be created");
        storage
            .settings
            .set_setting("hooks_enabled", &serde_json::json!(true))
            .await
            .expect("hooks setting should persist");

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
    async fn pre_tool_hook_updates_input_and_adds_context() {
        let (context, temp_dir) = create_test_context().await;
        let hooks_dir = temp_dir.path().join(".talkcody");
        tokio::fs::create_dir_all(&hooks_dir)
            .await
            .expect("hooks dir should exist");
        tokio::fs::write(
            hooks_dir.join("settings.json"),
            serde_json::json!({
                "hooks": {
                    "PreToolUse": [{
                        "matcher": "writeFile",
                        "hooks": [{
                            "type": "command",
                            "command": "python3 -c \"import json,sys; data=json.load(sys.stdin); data['hookSpecificOutput']={'updatedInput': {'file_path': data['tool_input']['file_path'], 'content': 'hooked'}, 'additionalContext':'hook extra'}; print(json.dumps(data))\""
                        }]
                    }]
                }
            })
            .to_string(),
        )
        .await
        .expect("hook config should write");

        let summary = HookRunner::new()
            .run_pre_tool_use(
                &ToolRequest {
                    tool_call_id: "tool_1".to_string(),
                    name: "writeFile".to_string(),
                    input: serde_json::json!({"file_path": "test.txt", "content": "raw"}),
                    provider_metadata: None,
                },
                &context,
            )
            .await
            .expect("pre tool hook should run");

        assert_eq!(summary.additional_context, vec!["hook extra".to_string()]);
        assert_eq!(
            summary.updated_input,
            Some(serde_json::json!({"file_path": "test.txt", "content": "hooked"}))
        );
    }

    #[tokio::test]
    async fn pre_tool_hook_blocks_with_exit_code_two() {
        let (context, temp_dir) = create_test_context().await;
        let hooks_dir = temp_dir.path().join(".talkcody");
        tokio::fs::create_dir_all(&hooks_dir)
            .await
            .expect("hooks dir should exist");
        tokio::fs::write(
            hooks_dir.join("settings.json"),
            serde_json::json!({
                "hooks": {
                    "PreToolUse": [{
                        "matcher": "writeFile",
                        "hooks": [{
                            "type": "command",
                            "command": "echo blocked by hook && exit 2"
                        }]
                    }]
                }
            })
            .to_string(),
        )
        .await
        .expect("hook config should write");

        let summary = HookRunner::new()
            .run_pre_tool_use(
                &ToolRequest {
                    tool_call_id: "tool_1".to_string(),
                    name: "writeFile".to_string(),
                    input: serde_json::json!({"file_path": "test.txt", "content": "raw"}),
                    provider_metadata: None,
                },
                &context,
            )
            .await
            .expect("pre tool hook should run");

        assert!(summary.blocked);
        assert_eq!(summary.block_reason.as_deref(), Some("blocked by hook"));
    }

    #[tokio::test]
    async fn pre_tool_hook_command_failure_does_not_fail_execution() {
        let (context, temp_dir) = create_test_context().await;
        let hooks_dir = temp_dir.path().join(".talkcody");
        tokio::fs::create_dir_all(&hooks_dir)
            .await
            .expect("hooks dir should exist");
        tokio::fs::write(
            hooks_dir.join("settings.json"),
            serde_json::json!({
                "hooks": {
                    "PreToolUse": [{
                        "matcher": "writeFile",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "definitely-not-a-real-hook-command"
                            },
                            {
                                "type": "command",
                                "command": "printf '{\"additionalContext\":\"survived hook failure\"}'"
                            }
                        ]
                    }]
                }
            })
            .to_string(),
        )
        .await
        .expect("hook config should write");

        let summary = HookRunner::new()
            .run_pre_tool_use(
                &ToolRequest {
                    tool_call_id: "tool_1".to_string(),
                    name: "writeFile".to_string(),
                    input: serde_json::json!({"file_path": "test.txt", "content": "raw"}),
                    provider_metadata: None,
                },
                &context,
            )
            .await
            .expect("hook failure should not abort execution");

        assert!(!summary.blocked);
        assert_eq!(
            summary.additional_context,
            vec!["survived hook failure".to_string()]
        );
    }
}
