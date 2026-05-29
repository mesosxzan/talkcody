/* biome-ignore lint/suspicious/noExplicitAny: Tool parameters are dynamic based on input schema */
import type { ReactElement } from 'react';
import type { z } from 'zod';
import { timedMethod } from '@/lib/timer';
import type {
  InterruptBehavior,
  PermissionCheckResult,
  ToolExecuteContext,
  ToolRenderContext,
  ToolWithUI,
} from '@/types/tool';

/**
 * Fail-closed defaults for tool safety declarations.
 * All new tools must EXPLICITLY override these to enable capabilities.
 * This follows the cc-haha buildTool() philosophy:
 * - Concurrency safety defaults to false (tools cannot run in parallel unless declared safe)
 * - Permission check defaults to allow (defer to the general permission system)
 * - Interrupt behavior defaults to cancel (stop on user interrupt for safety)
 */
const TOOL_SAFETY_DEFAULTS = {
  isConcurrencySafe: false,
  isReadOnly: false,
  isDestructive: false,
  maxResultSizeChars: Infinity,
  interruptBehavior: 'cancel' as InterruptBehavior,
};

interface CreateToolOptions {
  name: string;
  description: string;
  inputSchema: z.ZodSchema;
  /* biome-ignore lint/suspicious/noExplicitAny: Tool parameters are dynamic based on input schema */
  execute: (params: any, context: ToolExecuteContext) => Promise<any>;
  /* biome-ignore lint/suspicious/noExplicitAny: Tool parameters are dynamic based on input schema */
  renderToolDoing: (params: any, context?: ToolRenderContext) => ReactElement | null;
  /* biome-ignore lint/suspicious/noExplicitAny: Tool parameters are dynamic based on input schema */
  renderToolResult: (result: any, params: any, context?: ToolRenderContext) => ReactElement | null;

  // === Safety declarations (override defaults) ===

  /** Whether this tool can safely run concurrently (default: false) */
  canConcurrent?: boolean; // Legacy alias for isConcurrencySafe
  isConcurrencySafe?: boolean;
  /** Whether this tool only reads without modifying (default: false) */
  isReadOnly?: boolean;
  /** Whether this tool performs destructive operations (default: false) */
  isDestructive?: boolean;
  /** Per-tool permission check (default: allow) */
  checkPermissions?: (params: any, context: ToolExecuteContext) => Promise<PermissionCheckResult>;
  /** Max result size in chars before persistence (default: Infinity) */
  maxResultSizeChars?: number;
  /** Interrupt behavior (default: cancel) */
  interruptBehavior?: InterruptBehavior;

  // === UI options ===
  hidden?: boolean;
  showResultUIAlways?: boolean;
}

/**
 * Creates a tool with fail-closed safety defaults.
 *
 * This factory function ensures that every tool starts with safe defaults
 * and must explicitly declare any capabilities that relax safety constraints.
 * This is inspired by cc-haha's buildTool() pattern.
 */
export function createTool(options: CreateToolOptions): ToolWithUI {
  const {
    name,
    description,
    inputSchema,
    execute,
    renderToolDoing,
    renderToolResult,
    hidden,
    showResultUIAlways,
  } = options;

  // Resolve legacy canConcurrent -> isConcurrencySafe
  const isConcurrencySafe =
    options.isConcurrencySafe ?? options.canConcurrent ?? TOOL_SAFETY_DEFAULTS.isConcurrencySafe;

  // Apply fail-closed defaults for all safety declarations
  const isReadOnly = options.isReadOnly ?? TOOL_SAFETY_DEFAULTS.isReadOnly;
  const isDestructive = options.isDestructive ?? TOOL_SAFETY_DEFAULTS.isDestructive;
  const maxResultSizeChars = options.maxResultSizeChars ?? TOOL_SAFETY_DEFAULTS.maxResultSizeChars;
  const interruptBehavior = options.interruptBehavior ?? TOOL_SAFETY_DEFAULTS.interruptBehavior;

  // Default permission check: defer to general system (allow)
  const defaultCheckPermissions = async (
    input: unknown,
    _context: ToolExecuteContext
  ): Promise<PermissionCheckResult> => ({
    behavior: 'allow',
    updatedInput: input as Record<string, unknown>,
  });
  const checkPermissions = options.checkPermissions ?? defaultCheckPermissions;

  // Wrap execute with timing decorator
  const executeDescriptor: TypedPropertyDescriptor<CreateToolOptions['execute']> = {
    value: execute,
  };
  const decoratedDescriptor =
    timedMethod(`${name}.execute`)(options, 'execute', executeDescriptor) ?? executeDescriptor;
  const timedExecute = decoratedDescriptor.value ?? execute;

  /* biome-ignore lint/suspicious/noExplicitAny: Tool types are dynamically defined */
  const tool: ToolWithUI = {
    name,
    description,
    /* biome-ignore lint/suspicious/noExplicitAny: Tool types are dynamically defined */
    inputSchema: inputSchema as any,
    execute: timedExecute,
    renderToolDoing,
    renderToolResult,
    isConcurrencySafe,
    isReadOnly,
    isDestructive,
    checkPermissions,
    maxResultSizeChars,
    interruptBehavior,
    hidden,
    showResultUIAlways,
  };
  return tool;
}
