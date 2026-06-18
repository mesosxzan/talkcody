//! Completion Loop Manager
//!
//! Handles iteration control for the Rust agent loop runtime.
//! Ported from TypeScript `src/services/agents/completion-loop.ts`.

/// Configuration for the completion loop manager.
#[derive(Debug, Clone)]
pub struct CompletionLoopConfig {
    /// Maximum number of iterations before forcing stop.
    pub max_iterations: u32,
    /// Whether the loop can extend its iteration budget once it reaches the limit.
    pub allow_iteration_extension: bool,
    /// Number of iterations to add when extending the limit.
    pub iteration_extension_count: u32,
    /// Whether this loop is running as a constrained sub-agent.
    pub is_subagent: bool,
}

impl CompletionLoopConfig {
    pub fn default_for_task(is_subagent: bool) -> Self {
        Self {
            max_iterations: if is_subagent { 25 } else { 50 },
            allow_iteration_extension: !is_subagent,
            iteration_extension_count: 10,
            is_subagent,
        }
    }
}

/// Result of a completion loop continuation decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionLoopResult {
    pub should_continue: bool,
    pub stop_reason: Option<CompletionStopReason>,
    pub extended: bool,
    pub iteration: u32,
}

/// Stop reason for the loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionStopReason {
    MaxIterations,
    UserStop,
    Error,
    Completion,
}

/// Minimal loop state needed to make continuation decisions.
#[derive(Debug, Clone, Default)]
pub struct CompletionLoopState {
    pub last_finish_reason: Option<String>,
}

/// Completion loop state manager.
#[derive(Debug, Clone)]
pub struct CompletionLoopManager {
    config: CompletionLoopConfig,
    current_iteration: u32,
    last_stop_reason: Option<CompletionStopReason>,
}

impl CompletionLoopManager {
    pub fn new(config: CompletionLoopConfig) -> Self {
        Self {
            config,
            current_iteration: 0,
            last_stop_reason: None,
        }
    }

    pub fn iteration(&self) -> u32 {
        self.current_iteration
    }

    pub fn increment_iteration(&mut self) {
        self.current_iteration += 1;
    }

    pub fn should_continue(
        &mut self,
        loop_state: &CompletionLoopState,
        has_tool_calls: bool,
        is_aborted: bool,
    ) -> CompletionLoopResult {
        if is_aborted {
            return CompletionLoopResult {
                should_continue: false,
                stop_reason: Some(CompletionStopReason::UserStop),
                extended: false,
                iteration: self.current_iteration,
            };
        }

        if loop_state.last_finish_reason.as_deref() == Some("error") {
            return CompletionLoopResult {
                should_continue: false,
                stop_reason: Some(CompletionStopReason::Error),
                extended: false,
                iteration: self.current_iteration,
            };
        }

        if !has_tool_calls {
            return CompletionLoopResult {
                should_continue: false,
                stop_reason: Some(CompletionStopReason::Completion),
                extended: false,
                iteration: self.current_iteration,
            };
        }

        if self.current_iteration >= self.config.max_iterations {
            if self.config.allow_iteration_extension {
                self.config.max_iterations += self.config.iteration_extension_count;
                log::info!(
                    "[CompletionLoop] Extended iteration limit to {}",
                    self.config.max_iterations
                );
                return CompletionLoopResult {
                    should_continue: true,
                    stop_reason: None,
                    extended: true,
                    iteration: self.current_iteration,
                };
            }

            return CompletionLoopResult {
                should_continue: false,
                stop_reason: Some(CompletionStopReason::MaxIterations),
                extended: false,
                iteration: self.current_iteration,
            };
        }

        CompletionLoopResult {
            should_continue: true,
            stop_reason: None,
            extended: false,
            iteration: self.current_iteration,
        }
    }

    pub fn record_stop_reason(&mut self, reason: CompletionStopReason) {
        self.last_stop_reason = Some(reason);
    }

    pub fn reset(&mut self) {
        self.current_iteration = 0;
        self.last_stop_reason = None;
    }

    pub fn state_summary(&self) -> CompletionLoopSummary {
        CompletionLoopSummary {
            iteration: self.current_iteration,
            max_iterations: self.config.max_iterations,
            is_subagent: self.config.is_subagent,
            last_stop_reason: self.last_stop_reason,
        }
    }
}

/// Summary used for logging and debugging.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionLoopSummary {
    pub iteration: u32,
    pub max_iterations: u32,
    pub is_subagent: bool,
    pub last_stop_reason: Option<CompletionStopReason>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stops_when_user_aborts() {
        let mut manager = CompletionLoopManager::new(CompletionLoopConfig::default_for_task(false));
        manager.increment_iteration();

        let result = manager.should_continue(&CompletionLoopState::default(), true, true);

        assert!(!result.should_continue);
        assert_eq!(result.stop_reason, Some(CompletionStopReason::UserStop));
    }

    #[test]
    fn stops_when_no_tool_calls_are_returned() {
        let mut manager = CompletionLoopManager::new(CompletionLoopConfig::default_for_task(false));
        manager.increment_iteration();

        let result = manager.should_continue(&CompletionLoopState::default(), false, false);

        assert!(!result.should_continue);
        assert_eq!(result.stop_reason, Some(CompletionStopReason::Completion));
    }

    #[test]
    fn extends_iteration_budget_for_primary_agents() {
        let mut manager = CompletionLoopManager::new(CompletionLoopConfig {
            max_iterations: 1,
            allow_iteration_extension: true,
            iteration_extension_count: 3,
            is_subagent: false,
        });
        manager.increment_iteration();

        let result = manager.should_continue(&CompletionLoopState::default(), true, false);

        assert!(result.should_continue);
        assert!(result.extended);
        assert_eq!(manager.state_summary().max_iterations, 4);
    }

    #[test]
    fn stops_at_budget_for_subagents() {
        let mut manager = CompletionLoopManager::new(CompletionLoopConfig {
            max_iterations: 1,
            allow_iteration_extension: false,
            iteration_extension_count: 3,
            is_subagent: true,
        });
        manager.increment_iteration();

        let result = manager.should_continue(&CompletionLoopState::default(), true, false);

        assert!(!result.should_continue);
        assert_eq!(
            result.stop_reason,
            Some(CompletionStopReason::MaxIterations)
        );
    }
}
