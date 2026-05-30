import type { Message as ModelMessage, ProviderOptions } from '@/services/llm/types';
import type { ToolSummary } from './completion-hooks';
import type { ModelType } from './model-types';
import type { OutputFormatType } from './output-format';
import type { ToolInput, ToolOutput, ToolWithUI } from './tool';

export interface ResponsesChainState {
  enabled: boolean;
  provider: 'openai-subscription';
  transportPreference: 'auto' | 'websocket' | 'http';
  transportSessionId?: string;
  lastResponseId?: string;
  baselineMessageCount: number;
  fallbackCount: number;
  broken: boolean;
  brokenReason?: string;
  lastTransport?: 'http-sse' | 'websocket';
  lastContinuationAccepted?: boolean;
  needsFreshWebsocketBaseline?: boolean;
}

/**
 * Custom tool set type that accepts our ToolWithUI objects.
 * This is used for AgentDefinition.tools which stores ToolWithUI instances.
 * When passed to the AI SDK, these are converted appropriately.
 */
export type AgentToolSet = Record<string, ToolWithUI>;

export interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ToolMessageContent[];
  timestamp: Date;
  isStreaming?: boolean;
  assistantId?: string;
  reasoningContent?: string;
  isReasoningStreaming?: boolean;
  attachments?: MessageAttachment[];
  toolCallId?: string;
  toolName?: string;
  parentToolCallId?: string; // For nested tool messages - indicates this message belongs to a parent tool
  nestedTools?: UIMessage[]; // For parent tools - stores nested tool messages
  renderDoingUI?: boolean; // For tool-call messages - indicates whether UI should render "doing" state
  taskId?: string; // Task ID for tools that need to identify their execution context (e.g., exitPlanMode)
  outputFormat?: OutputFormatType; // Selected output format for assistant messages
}

export interface ToolMessageContent {
  type: 'tool-call' | 'tool-result';
  toolCallId: string;
  toolName: string;
  input?: ToolInput;
  output?: ToolOutput;
  providerMetadata?: ProviderOptions;
}

export interface MessageAttachment {
  id: string;
  type: 'image' | 'video' | 'file' | 'code';
  filename: string;
  content?: string;
  filePath: string;
  mimeType: string;
  size: number;
}

export interface ConvertMessagesOptions {
  rootPath?: string;
  systemPrompt?: string;
  model?: string;
  providerId?: string;
}

export interface AgentLoopOptions {
  messages: UIMessage[];
  model: string;
  fallbackModels?: string[];
  systemPrompt?: string;
  tools?: AgentToolSet;
  isThink?: boolean;
  isSubagent?: boolean;
  subagentId?: string;
  suppressReasoning?: boolean;
  maxIterations?: number;
  compression?: Partial<CompressionConfig>;
  agentId?: string; // Agent identifier for special handling (e.g., image-generator)
  freshContext?: boolean; // Skip cached compaction and compression for fresh-context loops
  rootPath?: string; // Frozen execution root so tools keep using the assigned worktree during the loop
}

export interface AgentLoopState {
  messages: ModelMessage[];
  currentIteration: number;
  isComplete: boolean;
  lastFinishReason?: string;
  lastRequestTokens: number; // Total tokens from the last AI request (not cumulative)
  unknownFinishReasonCount?: number; // Counter for unknown finish reasons to prevent infinite loops
  autoContinueCount?: number; // Counter for auto-continuation after truncation (finish_reason: "length"/"max_tokens")
  rawChunks?: unknown[]; // Raw chunks from provider for debugging
  hasSkillScripts?: boolean; // Flag to track if skills with scripts have been loaded
  responsesChain?: ResponsesChainState;
  /** Tool summaries collected during the current iteration for completion hooks.
   *  Moved here from LLMService instance field to ensure per-iteration isolation
   *  and avoid race conditions in parallel task execution. */
  toolSummaries: ToolSummary[];
}

export interface AgentLoopCallbacks {
  onChunk: (chunk: string) => void;
  onComplete?: (fullText: string) => void;
  onError?: (error: Error) => void;
  onStatus?: (status: string) => void;
  onToolMessage?: (message: UIMessage) => void;
  onAssistantMessageStart?: () => void;
  onAssistantReasoning?: (reasoningContent?: string) => void;
  onReasoningUpdate?: (payload: { reasoningContent: string; isStreaming: boolean }) => void;
  onAttachment?: (attachment: MessageAttachment) => void;
  onStepFinish?: (result: AgentLoopState) => void | Promise<void>;
  onToolCall?: (toolName: string, args: ToolInput) => void | Promise<void>;
  onToolResult?: (toolName: string, result: ToolOutput) => void | Promise<void>;
}

// Message compression types
export interface CompressionConfig {
  enabled: boolean;
  preserveRecentMessages: number;
  compressionModel: string;
  compressionFallbackModels?: string[];
  compressionThreshold: number; // 0.0 to 1.0, percentage of context window
  /** Strategy selection mode. Default 'auto' uses progressive hybrid. */
  strategyMode?:
    | 'auto'
    | 'progressive'
    | 'filter_only'
    | 'code_summarization'
    | 'selective_removal'
    | 'ai_only';
  /** Max strategy escalation steps in progressive mode. Default 3. */
  maxStrategyEscalations?: number;
  /** Target compression ratio (0-1). Stop escalating when reached. Default 0.4. */
  targetCompressionRatio?: number;
}

export interface CompressionSection {
  title: string;
  content: string;
}

export interface CompressionResult {
  compressedSummary: string;
  sections: CompressionSection[];
  preservedMessages: ModelMessage[];
  originalMessageCount: number;
  compressedMessageCount: number;
  compressionRatio: number;
  /** Strategy chain executed (in order) when multi-strategy compression is used */
  strategyChain?: CompressionStrategyType[];
  /** Per-strategy metrics when multi-strategy compression is used */
  strategyResults?: CompressionStrategyResult[];
  /** Context analysis that drove strategy selection */
  analysis?: ContextAnalysis;
}

export interface MessageCompactionOptions {
  messages: ModelMessage[];
  config: CompressionConfig;
  systemPrompt?: string;
}

// ── Multi-strategy compression types ────────────────────────

/** Compression strategy identifiers */
export enum CompressionStrategyType {
  FILTER_ONLY = 'filter_only',
  CODE_SUMMARIZATION = 'code_summarization',
  SELECTIVE_REMOVAL = 'selective_removal',
  AI_SUMMARIZATION = 'ai_summarization',
  PROGRESSIVE_HYBRID = 'progressive_hybrid',
}

/** Strategy cost tier (used for escalation ordering) */
export type StrategyCost = 'low' | 'medium' | 'high';

/** Strategy quality tier */
export type StrategyQuality = 'low' | 'medium' | 'high';

/** Distribution of message types in a conversation */
export interface MessageTypeDistribution {
  /** Fraction of messages that are tool calls (0-1) */
  toolCalls: number;
  /** Fraction of messages that are pure user/assistant text (0-1) */
  conversation: number;
  /** Fraction of messages containing large code blocks (0-1) */
  codeBlocks: number;
}

/** A detected exploration chain (e.g. glob→read→glob→read) */
export interface ExplorationChain {
  startIndex: number;
  endIndex: number;
  messageCount: number;
  /** Human-readable summary, e.g. "Explored src/services/context/ directory" */
  summary: string;
}

/** Context analysis result used for strategy selection */
export interface ContextAnalysis {
  totalMessages: number;
  totalTokens: number;
  toolCallCount: number;
  conversationCount: number;
  codeBlockCount: number;
  duplicateToolCallCount: number;
  messageTypes: MessageTypeDistribution;
  explorationChains: ExplorationChain[];
}

/** Result from executing a single compression strategy */
export interface CompressionStrategyResult {
  messages: ModelMessage[];
  tokensBefore: number;
  tokensAfter: number;
  compressionRatio: number;
  strategyType: CompressionStrategyType;
  /** Strategy-specific metrics */
  metadata: Record<string, unknown>;
}

/** Shared input context for all compression strategies */
export interface StrategyContext {
  messages: ModelMessage[];
  targetTokenBudget: number;
  preserveRecentCount: number;
  compressionModel: string;
  compressionFallbackModels?: string[];
  analysis: ContextAnalysis;
}

/** Compression strategy interface */
export interface CompressionStrategy {
  readonly type: CompressionStrategyType;
  readonly cost: StrategyCost;
  readonly quality: StrategyQuality;
  isApplicable(context: StrategyContext): boolean;
  estimateCompressionRatio(context: StrategyContext): number;
  execute(context: StrategyContext): Promise<CompressionStrategyResult>;
}

export type DynamicPromptConfig = {
  enabled: boolean;
  providers: string[];
  variables: Record<string, string>;
  providerSettings?: Record<string, unknown>;
};

/**
 * Agent role classification based on primary function
 */
export type AgentRole =
  | 'read' // Primarily reads and analyzes existing content
  | 'write'; // Primarily creates, edits, or deletes content (includes mixed operations)

/**
 * Execution phase types for better semantic naming
 */
export type ExecutionPhase =
  | 'read-stage' // Information gathering phase
  | 'write-edit-stage'; // Content modification phase

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  modelType: ModelType; // Model type category (main_model, small_model, etc.)
  model?: string; // resolved concrete model identifier for execution
  fallbackModels?: string[]; // ordered fallback chain used by the request layer
  systemPrompt: string | (() => Promise<string>) | (() => string);
  tools?: AgentToolSet;
  hidden?: boolean; // if true, not shown to users
  rules?: string;
  outputFormat?: string;
  isDefault?: boolean; // if true, it's a system default agent (loaded from code, not persisted to database)
  version?: string; // version number for system agents (e.g., "2.1.0")
  dynamicPrompt?: DynamicPromptConfig;
  defaultSkills?: string[]; // array of skill IDs
  isBeta?: boolean; // if true, show beta badge in UI
  role?: AgentRole; // Primary function classification for dependency analysis
  canBeSubagent?: boolean; // if false, cannot be called via callAgent. Default: true
}
