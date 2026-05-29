import type { ReactElement } from 'react';
import type { z } from 'zod';

export type ToolInput = Record<string, unknown>;
export type ToolOutput = unknown;

export interface ToolExecuteContext {
  taskId: string;
  toolId: string;
  rootPath?: string;
  subagentId?: string;
}

export interface ToolRenderContext {
  taskId?: string;
  toolName?: string;
}

/**
 * Permission decision returned by a tool's checkPermissions method.
 */
export type PermissionDecision = 'allow' | 'deny' | 'ask';

/**
 * Result of a tool's permission check.
 */
export interface PermissionCheckResult {
  /** The permission decision */
  behavior: PermissionDecision;
  /** Updated tool input (e.g., normalized paths) */
  updatedInput?: ToolInput;
  /** Reason for the decision */
  reason?: string;
}

/**
 * Interrupt behavior declaration for a tool.
 * - 'cancel': Tool should be stopped on user interrupt (e.g., Bash)
 * - 'block': Tool should keep running on user interrupt (e.g., Read)
 */
export type InterruptBehavior = 'cancel' | 'block';

/**
 * Placeholder type for MCP tools that need to be resolved at runtime.
 * These are stored in tool configurations and resolved by multiMCPAdapter.
 */
export interface MCPToolPlaceholder {
  _isMCPTool: true;
  _mcpToolName: string;
}

/**
 * Enhanced tool interface with safety declarations and fail-closed defaults.
 * Inspired by cc-haha's buildTool() pattern where tools must explicitly
 * declare their concurrency safety, read-only/destructive nature, and
 * permission behavior.
 */
export interface ToolWithUI<
  TInput extends ToolInput = ToolInput,
  TOutput extends ToolOutput = ToolOutput,
> {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<TInput>;
  execute: (params: TInput, context: ToolExecuteContext) => Promise<TOutput>;
  renderToolDoing: (params: TInput, context?: ToolRenderContext) => ReactElement | null;
  renderToolResult: (
    result: TOutput,
    params: TInput,
    context?: ToolRenderContext
  ) => ReactElement | null;

  // === Safety Declarations (fail-closed defaults) ===

  /**
   * Whether this tool can safely run concurrently with other tools.
   * Defaults to false - tools must explicitly declare concurrency safety.
   * Example: readFile=true (no side effects), editFile=false (mutates state)
   */
  isConcurrencySafe: boolean;

  /**
   * Whether this tool only reads data without modifying anything.
   * Defaults to false - tools must explicitly declare read-only status.
   * Example: readFile=true, bash=false, editFile=false
   */
  isReadOnly: boolean;

  /**
   * Whether this tool performs destructive operations (deletion, overwriting).
   * Defaults to false - tools must explicitly declare destructive behavior.
   * Example: bash can be destructive, editFile can overwrite content
   */
  isDestructive: boolean;

  /**
   * Per-tool permission check. Returns allow/deny/ask.
   * Defaults to allow - defer to the general permission system.
   * Tools can override to enforce tool-specific permission rules.
   */
  checkPermissions: (input: TInput, context: ToolExecuteContext) => Promise<PermissionCheckResult>;

  /**
   * Maximum result size in characters before the result should be persisted to disk.
   * When a tool result exceeds this threshold, only a preview is sent to the AI
   * and the full result is saved to a file.
   * Defaults to Infinity (no limit) - tools must explicitly set a budget.
   * Example: bash=50000, readFile=100000, webFetch=20000
   */
  maxResultSizeChars: number;

  /**
   * How this tool should behave when the user interrupts the agent loop.
   * - 'cancel': Stop the tool immediately (Bash, webFetch)
   * - 'block': Keep running until completion (Read, search)
   * Defaults to 'cancel' for safety.
   */
  interruptBehavior: InterruptBehavior;

  // === UI Options ===

  /** Whether to hide this tool from the UI tool selector */
  hidden?: boolean;
  /** Whether to always show the tool result UI expanded by default */
  showResultUIAlways?: boolean;
}

/**
 * Union type for tool entries that can be either a regular tool or an MCP placeholder.
 */
export type ToolEntry = ToolWithUI | MCPToolPlaceholder;
