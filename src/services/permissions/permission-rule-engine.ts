/**
 * Permission rule engine for tool execution gating.
 * Implements a layered deny/allow/ask approach inspired by cc-haha's permission system.
 *
 * The permission pipeline evaluates rules in strict order:
 * 1. Deny rules (block entire tools or tool+input patterns)
 * 2. Allow rules (auto-approve entire tools or tool+input patterns)
 * 3. Ask rules (require user interaction)
 * 4. Tool-specific checkPermissions() (per-tool logic)
 * 5. Hook system (pre-tool-use hooks can deny/allow/modify)
 * 6. Default: ask (require user confirmation for unknown tools)
 *
 * Rules are loaded from:
 * - User settings (~/.talkcody/settings.json)
 * - Project settings (.talkcody/settings.json)
 * - Agent-specific rules
 */

import { logger } from '@/lib/logger';
import type { PermissionCheckResult, ToolExecuteContext, ToolInput } from '@/types/tool';

// === Rule Types ===

export type PermissionRuleAction = 'deny' | 'allow' | 'ask';

export interface PermissionRule {
  /** Which tool this rule applies to. '*' matches all tools. */
  toolName: string;
  /** Optional pattern for tool-specific input matching (e.g., file path glob, command pattern) */
  ruleContent?: string;
  /** The action to take */
  action: PermissionRuleAction;
  /** Where this rule came from (for debugging/audit) */
  source: 'userSettings' | 'projectSettings' | 'agentSettings' | 'systemDefaults';
  /** Optional reason for the rule (shown to user) */
  reason?: string;
}

export interface PermissionRuleConfig {
  deny: PermissionRule[];
  allow: PermissionRule[];
  ask: PermissionRule[];
}

// === Denial Tracking with Circuit Breaker ===

interface DenialTrackingState {
  /** Number of consecutive permission denials */
  consecutiveDenials: number;
  /** Number of successful tool executions since last denial */
  successCount: number;
  /** Timestamp of last denial */
  lastDenialTime: number;
  /** Circuit breaker is open (auto-approve disabled due to too many denials) */
  circuitBreakerOpen: boolean;
}

const CIRCUIT_BREAKER_THRESHOLD = 3; // Open circuit after 3 consecutive denials
const CIRCUIT_BREAKER_RESET_MS = 60000; // Reset circuit after 1 minute

// === Safety Path Checks ===

/**
 * Paths that are protected from AI editing even in auto-approve mode.
 * These are critical system/config files where corruption could cause
 * serious issues.
 */
const PROTECTED_PATH_PATTERNS = [
  /^\.git\//, // Git internals
  /^\.git$/, // Git directory itself
  /^\.talkcody\/settings\.json$/, // TalkCody settings
  /^\.vscode\/settings\.json$/, // VS Code workspace settings
  /^\.vscode$/, // VS Code config directory
  /\.bashrc$/, // Shell config
  /\.zshrc$/, // Shell config
  /\.profile$/, // Shell config
  /\.ssh\//, // SSH keys
  /\.env$/, // Environment variables
  /\.env\./, // Environment variable files (.env.local, .env.production)
];

/**
 * Check if a path is protected from AI editing.
 * Returns true if the path should require explicit user approval
 * even in auto-approve mode.
 */
export function isProtectedPath(filePath: string): boolean {
  // Normalize to relative path (strip leading / or ./)
  const normalized = filePath.replace(/^\/+/, '').replace(/^\.\//, '');

  for (const pattern of PROTECTED_PATH_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  return false;
}

/**
 * Get the reason a path is protected.
 */
export function getProtectedPathReason(filePath: string): string | undefined {
  const normalized = filePath.replace(/^\/+/, '').replace(/^\.\//, '');

  for (const pattern of PROTECTED_PATH_PATTERNS) {
    if (pattern.test(normalized)) {
      if (/^\.git/.test(normalized)) return 'Git internal files should not be modified by AI';
      if (/\.talkcody/.test(normalized))
        return 'TalkCody configuration should only be modified with explicit user consent';
      if (/\.vscode/.test(normalized))
        return 'VS Code settings should only be modified with explicit user consent';
      if (/\.bashrc|\.zshrc|\.profile/.test(normalized))
        return 'Shell configuration files should only be modified with explicit user consent';
      if (/\.ssh/.test(normalized)) return 'SSH keys should never be modified by AI';
      if (/\.env/.test(normalized)) return 'Environment variable files may contain secrets';
      return 'This file is protected for safety reasons';
    }
  }

  return undefined;
}

// === Default System Rules ===

const SYSTEM_DEFAULT_RULES: PermissionRuleConfig = {
  deny: [
    // Block tools that should never be auto-executed without explicit approval
    {
      toolName: 'writeFile',
      ruleContent: '.ssh/**',
      action: 'deny',
      source: 'systemDefaults',
      reason: 'SSH directory should never be written by AI',
    },
    {
      toolName: 'writeFile',
      ruleContent: '.env',
      action: 'deny',
      source: 'systemDefaults',
      reason: 'Environment files may contain secrets',
    },
    {
      toolName: 'editFile',
      ruleContent: '.ssh/**',
      action: 'deny',
      source: 'systemDefaults',
      reason: 'SSH directory should never be modified by AI',
    },
  ],
  allow: [
    // Read-only tools are always allowed
    { toolName: 'readFile', action: 'allow', source: 'systemDefaults' },
    { toolName: 'listFiles', action: 'allow', source: 'systemDefaults' },
    { toolName: 'glob', action: 'allow', source: 'systemDefaults' },
    { toolName: 'codeSearch', action: 'allow', source: 'systemDefaults' },
    { toolName: 'getCurrentDatetime', action: 'allow', source: 'systemDefaults' },
  ],
  ask: [
    // Destructive tools always require confirmation
    {
      toolName: 'bash',
      action: 'ask',
      source: 'systemDefaults',
      reason: 'Shell commands require user review',
    },
    {
      toolName: 'writeFile',
      action: 'ask',
      source: 'systemDefaults',
      reason: 'File writes require user review',
    },
    {
      toolName: 'editFile',
      action: 'ask',
      source: 'systemDefaults',
      reason: 'File edits require user review',
    },
  ],
};

// === Permission Rule Engine ===

export class PermissionRuleEngine {
  private userRules: PermissionRuleConfig = { deny: [], allow: [], ask: [] };
  private projectRules: PermissionRuleConfig = { deny: [], allow: [], ask: [] };
  private agentRules: PermissionRuleConfig = { deny: [], allow: [], ask: [] };
  private denialTracking = new Map<string, DenialTrackingState>();

  /**
   * Load user-level permission rules from settings
   */
  loadUserRules(rules: PermissionRuleConfig): void {
    this.userRules = rules;
  }

  /**
   * Load project-level permission rules
   */
  loadProjectRules(rules: PermissionRuleConfig): void {
    this.projectRules = rules;
  }

  /**
   * Load agent-specific permission rules
   */
  loadAgentRules(rules: PermissionRuleConfig): void {
    this.agentRules = rules;
  }

  /**
   * Check permissions for a tool call using the layered pipeline.
   *
   * Evaluation order (first match wins):
   * 1. System default deny rules
   * 2. Agent deny rules
   * 3. Project deny rules
   * 4. User deny rules
   * 5. Protected path check (for file-editing tools)
   * 6. Tool-specific checkPermissions()
   * 7. System default allow rules
   * 8. Agent allow rules
   * 9. Project allow rules
   * 10. User allow rules
   * 11. Ask rules
   * 12. Default: ask
   */
  async checkPermission(
    toolName: string,
    toolInput: ToolInput,
    toolCheckPermissions?: (
      input: ToolInput,
      context: ToolExecuteContext
    ) => Promise<PermissionCheckResult>,
    context?: ToolExecuteContext
  ): Promise<PermissionCheckResult> {
    const taskId = context?.taskId ?? 'default';

    // Check circuit breaker - if open, auto-approve is disabled
    if (this.isCircuitBreakerOpen(taskId)) {
      logger.info(
        `Permission circuit breaker is open for task ${taskId}, requiring explicit approval`
      );
    }

    // Step 1: Check deny rules (ordered by priority)
    const denyResult = this.findMatchingRule(
      toolName,
      toolInput,
      [
        SYSTEM_DEFAULT_RULES.deny,
        this.agentRules.deny,
        this.projectRules.deny,
        this.userRules.deny,
      ],
      'deny'
    );

    if (denyResult) {
      this.recordDenial(taskId);
      return {
        behavior: 'deny',
        reason: denyResult.reason || `Tool ${toolName} is blocked by ${denyResult.source} rule`,
      };
    }

    // Step 2: Protected path check for file-modifying tools
    if (toolName === 'writeFile' || toolName === 'editFile') {
      const filePath = (toolInput as Record<string, unknown>)?.file_path as string | undefined;
      if (filePath && isProtectedPath(filePath)) {
        const reason = getProtectedPathReason(filePath);
        this.recordDenial(taskId);
        return {
          behavior: 'ask',
          reason: reason || `File ${filePath} is protected and requires explicit approval`,
        };
      }
    }

    // Step 3: Tool-specific permission check
    if (toolCheckPermissions) {
      const toolResult = await toolCheckPermissions(
        toolInput,
        context ?? {
          taskId: 'default',
          toolId: '',
        }
      );
      if (toolResult.behavior === 'deny') {
        this.recordDenial(taskId);
        return toolResult;
      }
      if (toolResult.behavior === 'ask') {
        return toolResult;
      }
      // 'allow' from tool check - continue to check higher-level rules
    }

    // Step 4: Check allow rules (ordered by priority)
    const allowResult = this.findMatchingRule(
      toolName,
      toolInput,
      [
        SYSTEM_DEFAULT_RULES.allow,
        this.agentRules.allow,
        this.projectRules.allow,
        this.userRules.allow,
      ],
      'allow'
    );

    if (allowResult) {
      // Circuit breaker overrides allow rules for destructive tools
      if (this.isCircuitBreakerOpen(taskId) && !this.isReadOnlyTool(toolName)) {
        return {
          behavior: 'ask',
          reason:
            'Auto-approve is temporarily disabled due to recent permission denials. Please approve manually.',
        };
      }

      this.recordSuccess(taskId);
      return {
        behavior: 'allow',
        reason: `Tool ${toolName} is allowed by ${allowResult.source} rule`,
      };
    }

    // Step 5: Check ask rules
    const askResult = this.findMatchingRule(
      toolName,
      toolInput,
      [SYSTEM_DEFAULT_RULES.ask, this.agentRules.ask, this.projectRules.ask, this.userRules.ask],
      'ask'
    );

    if (askResult) {
      return {
        behavior: 'ask',
        reason: askResult.reason || `Tool ${toolName} requires user confirmation`,
      };
    }

    // Default: ask (fail-safe - unknown tools require confirmation)
    return {
      behavior: 'ask',
      reason: `Tool ${toolName} requires user confirmation (no matching rule found)`,
    };
  }

  /**
   * Find the first matching rule from a list of rule sources.
   */
  private findMatchingRule(
    toolName: string,
    toolInput: ToolInput,
    ruleSources: PermissionRule[][],
    _actionType: PermissionRuleAction
  ): PermissionRule | null {
    for (const source of ruleSources) {
      for (const rule of source) {
        // Check tool name match
        if (rule.toolName !== '*' && rule.toolName !== toolName) {
          continue;
        }

        // If no ruleContent, this is a blanket rule for the entire tool
        if (!rule.ruleContent) {
          return rule;
        }

        // If ruleContent exists, check against tool input
        if (this.matchesRuleContent(rule.ruleContent, toolName, toolInput)) {
          return rule;
        }
      }
    }

    return null;
  }

  /**
   * Check if a ruleContent pattern matches the tool input.
   * Supports glob patterns for file paths and command patterns for Bash.
   */
  private matchesRuleContent(ruleContent: string, toolName: string, toolInput: ToolInput): boolean {
    const input = toolInput as Record<string, unknown>;

    // For file tools, match against the file_path
    if (toolName === 'writeFile' || toolName === 'editFile' || toolName === 'readFile') {
      const filePath = input.file_path as string | undefined;
      if (!filePath) return false;

      // Simple glob matching
      return this.matchGlob(ruleContent, filePath);
    }

    // For bash, match against the command
    if (toolName === 'bash') {
      const command = input.command as string | undefined;
      if (!command) return false;

      // Pattern like "Bash(git *)" matches git commands
      return command.startsWith(ruleContent.replace(/\*$/, '').trim());
    }

    // Generic: try matching ruleContent as substring of any string input value
    for (const value of Object.values(input)) {
      if (typeof value === 'string' && this.matchGlob(ruleContent, value)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Simple glob pattern matching.
   * Supports:
   * - * (matches any sequence)
   * - ** (matches any sequence including /)
   * - Exact match
   */
  private matchGlob(pattern: string, path: string): boolean {
    // Normalize both to relative paths
    const normalizedPattern = pattern.replace(/^\/+/, '');
    const normalizedPath = path.replace(/^\/+/, '').replace(/^\.\//, '');

    // Convert glob to regex
    const regexStr = normalizedPattern
      .replace(/\*\*/g, '.*') // ** matches anything including /
      .replace(/\*/g, '[^/]*') // * matches anything except /
      .replace(/\?/g, '[^/]') // ? matches single char
      .replace(/\./g, '\\.'); // Escape dots

    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(normalizedPath);
  }

  /**
   * Record a permission denial for circuit breaker tracking.
   */
  private recordDenial(taskId: string): void {
    const state = this.getTrackingState(taskId);
    state.consecutiveDenials++;
    state.successCount = 0;
    state.lastDenialTime = Date.now();

    if (state.consecutiveDenials >= CIRCUIT_BREAKER_THRESHOLD) {
      state.circuitBreakerOpen = true;
      logger.warn(
        `Permission circuit breaker opened for task ${taskId} after ${state.consecutiveDenials} consecutive denials`
      );
    }
  }

  /**
   * Record a successful tool execution for circuit breaker tracking.
   */
  private recordSuccess(taskId: string): void {
    const state = this.getTrackingState(taskId);
    state.successCount++;
    state.consecutiveDenials = 0;
    // Close circuit breaker after success
    if (state.circuitBreakerOpen) {
      state.circuitBreakerOpen = false;
      logger.info(`Permission circuit breaker closed for task ${taskId}`);
    }
  }

  /**
   * Check if the circuit breaker is open for a task.
   */
  private isCircuitBreakerOpen(taskId: string): boolean {
    const state = this.getTrackingState(taskId);

    // Auto-reset circuit breaker after timeout
    if (state.circuitBreakerOpen && Date.now() - state.lastDenialTime > CIRCUIT_BREAKER_RESET_MS) {
      state.circuitBreakerOpen = false;
      state.consecutiveDenials = 0;
      logger.info(`Permission circuit breaker auto-reset for task ${taskId}`);
    }

    return state.circuitBreakerOpen;
  }

  /**
   * Get or create tracking state for a task.
   */
  private getTrackingState(taskId: string): DenialTrackingState {
    let state = this.denialTracking.get(taskId);
    if (!state) {
      state = {
        consecutiveDenials: 0,
        successCount: 0,
        lastDenialTime: 0,
        circuitBreakerOpen: false,
      };
      this.denialTracking.set(taskId, state);
    }
    return state;
  }

  /**
   * Check if a tool is read-only based on its name.
   */
  private isReadOnlyTool(toolName: string): boolean {
    const readOnlyTools = ['readFile', 'listFiles', 'glob', 'codeSearch', 'getCurrentDatetime'];
    return readOnlyTools.includes(toolName);
  }

  /**
   * Clear tracking state for a task (e.g., when a conversation ends).
   */
  clearTaskTracking(taskId: string): void {
    this.denialTracking.delete(taskId);
  }

  /**
   * Get all merged rules for debugging/display.
   */
  getAllRules(): PermissionRuleConfig {
    return {
      deny: [
        ...SYSTEM_DEFAULT_RULES.deny,
        ...this.agentRules.deny,
        ...this.projectRules.deny,
        ...this.userRules.deny,
      ],
      allow: [
        ...SYSTEM_DEFAULT_RULES.allow,
        ...this.agentRules.allow,
        ...this.projectRules.allow,
        ...this.userRules.allow,
      ],
      ask: [
        ...SYSTEM_DEFAULT_RULES.ask,
        ...this.agentRules.ask,
        ...this.projectRules.ask,
        ...this.userRules.ask,
      ],
    };
  }
}

/**
 * Singleton instance of the permission rule engine.
 */
export const permissionRuleEngine = new PermissionRuleEngine();
