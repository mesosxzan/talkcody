---
title: Frontend ↔ Backend LLM Interaction
description: How TalkCody's React frontend talks to the Rust/Tauri backend around LLM calls — data formats, technology choices, and implementation details
icon: Cable
---

import { Callout } from 'fumadocs-ui/components/callout';

# Frontend ↔ Backend LLM Interaction

This document is for contributors and anyone who needs to understand the LLM kernel of TalkCody. It explains the role split between the React client and the Rust/Tauri backend, the protocol choices, the data contracts, the key code paths, and the failure/retry model.

<Callout type="info">
All references are anchored to real files: `src/services/llm/*`, `src/services/agents/llm-service.ts`, the `llm_stream_text` Tauri command, and everything under `src-tauri/core/src/llm/*`.
</Callout>

---

## 1. Big Picture

```
┌──────────────────────────────────────────────────────────────────┐
│                       React 19 + TypeScript                       │
│  ┌──────────────┐   ┌──────────────────┐   ┌─────────────────┐    │
│  │  UI / Chat   │──►│  Zustand Stores   │──►│ Service Layer   │    │
│  │ Components   │   │  task / provider  │   │ llmClient       │    │
│  └──────────────┘   └──────────────────┘   │ LLMService      │    │
│                                            │ ContextCompactor│    │
│                                            └────────┬────────┘    │
│                                                     │             │
│                                            invoke('llm_stream_text')
│                                                     │             │
│                                            listen('llm-stream-…')│
└─────────────────────────────────────────────────────┼─────────────┘
                                                      │ Tauri IPC
┌─────────────────────────────────────────────────────▼─────────────┐
│                        Tauri 2 + Rust                              │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ llm/commands.rs :: llm_stream_text(window, request)         │    │
│  │  ├─ StreamHandler::stream_completion()                      │    │
│  │  │   └─ StreamRunner (model fallback / transient retry)     │    │
│  │  │       └─ Provider (OpenAI / Claude / GitHub Copilot …)  │    │
│  │  │           └─ Protocol (OpenAI Chat / OpenAI Responses /  │    │
│  │  │                    Claude Messages / OpenAI WS)          │    │
│  │  │              ├─ request_builder: BuiltRequest           │    │
│  │  │              ├─ http SSE: bytes_stream → parse_sse_event │    │
│  │  │              └─ stream_parser: StreamParseState → StreamEvent
│  │  └─ window.emit("llm-stream-{request_id}", StreamEvent)     │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                  │                │
│                                                  ▼                │
│                              OpenAI / Claude / OpenRouter / …     │
└──────────────────────────────────────────────────────────────────┘
```

Key facts:

- The frontend never talks to an LLM provider directly. All HTTP / WebSocket calls go through the Rust backend.
- The Rust side handles auth, protocol adaptation, stream parsing, retries, and pushes the chunks back to the frontend through Tauri's event bus.
- The TypeScript `LlmClient` is a thin wrapper. The real LLM work is `StreamHandler` / `StreamRunner` on the Rust side.
- Streaming uses a **command + event** channel pair: `invoke('llm_stream_text', { request })` returns the `request_id` immediately, and `StreamEvent`s are pushed via `window.emit('llm-stream-<id>', StreamEvent)`.

---

## 2. Technology Choices

### 2.1 Frontend

| Module | Tech | Why |
| --- | --- | --- |
| UI framework | React 19 + TypeScript | Mature ecosystem + static checking for `StreamEvent` discriminated unions |
| Build | Vite 7 | Fast HMR, plays well with Tauri 2 WebView |
| Styling | Tailwind 4 + Shadcn UI | Matches Tauri desktop look, copy-paste components |
| State | Zustand | Lighter than Redux, plays nicely with Tauri renderer process |
| IPC | `@tauri-apps/api/core` `invoke` + `@tauri-apps/api/event` `listen` | Official Tauri bindings; the event bus is a natural fit for SSE-style streams |
| LLM client | In-house `LlmClient` | Needs to wire `request_id` to the Tauri event bus; `Vercel AI SDK` targets pure web apps |
| Tools / MCP | `ToolExecutor` + `@/lib/mcp/*` | Tool side effects (file, bash, lsp) must run on Rust side |

### 2.2 Backend

| Module | Tech | Why |
| --- | --- | --- |
| Shell | Tauri 2 | Smaller than Electron, Rust backend can host the real LLM gateway |
| Async | Tokio | Streaming LLM is long-lived async |
| HTTP | `reqwest` | Native `bytes_stream` support for SSE |
| Protocols | Custom `LlmProtocol` trait + `openai_protocol.rs` / `claude_protocol.rs` / `openai_responses_protocol.rs` | Chat Completions, OpenAI Responses, and Claude Messages are too different to share one request/parser |
| Model routing | `ProviderRegistry` | Built-in OpenAI / Anthropic / OpenRouter / GitHub Copilot / Moonshot / Kimi / TalkCody / custom OpenAI-compatible |
| Persistence | SQLite (libSQL) + `.talkcody/` file tree under Tauri `app_data_dir` | Tasks, compacted messages, session memory sidecar |
| Compaction | `ContextCompactor` + strategies (`ai_summarization`, `filter_only`, `code_summarization`, `selective_removal`) | Trade off cost vs quality; can fall back to local session memory summary when AI fails |

### 2.3 Trade-offs

- **Why not call the LLM directly from the web with Vercel AI SDK?**
  - Tool execution has to happen on Rust (file, bash, lsp, MCP). Letting the renderer talk to the LLM directly would bypass the local execution sandbox.
  - API keys need to be encrypted and stored in OS keyring / SQLite; centralising them in Rust is safer.
  - Some providers (OpenAI Responses WS, Claude `cache_edits`) need finer control than the SDK gives.

- **Why command + event for streaming?**
  - `invoke` is request/response and not suitable for long-lived SSE.
  - Tauri officially recommends pairing `invoke` (register + return `request_id`) with an event channel (push `StreamEvent` keyed by `request_id`).

- **Why split Provider / Protocol?**
  - Provider owns auth, base URL, and special headers (e.g. `Editor-Version` for GitHub Copilot, `HTTP-Referer` for OpenRouter).
  - Protocol owns the request body and SSE parsing — three very different shapes (Chat Completions / OpenAI Responses / Claude Messages).
  - They are combined through `BuiltRequest.transport` and `provider_route()` to decide HTTP SSE vs OpenAI Responses WebSocket.

---

## 3. Frontend Walkthrough

### 3.1 Entry: ChatBox → LLMService

[chat-box.tsx](file:///Users/a1-6/project/talkcody/src/components/chat-box.tsx) appends the user message into `useTaskStore` and triggers `executionService.run()`. The actual loop lives in [llm-service.ts](file:///Users/a1-6/project/talkcody/src/services/agents/llm-service.ts#L271-L290):

```ts
// LLMService.runAgentLoop()
streamResult = await llmClient.streamText(requestPlan.request, abortController?.signal);
```

`requestPlan.request` carries:

- `model`: `model@provider` identifier like `gpt-5.2-codex@openai`
- `messages`: UI messages converted via `toLlmMessages`
- `tools`: `ToolDefinition[]`
- `conversationMode` / `inputMode` / `previousResponseId` / `transportSessionId`: OpenAI Responses chaining
- `continuationContext`: incremental context bookkeeping (baseline / delta / fallbackCount)

### 3.2 LLMClient: invoke + subscribe

[llm-client.ts](file:///Users/a1-6/project/talkcody/src/services/llm/llm-client.ts#L41-L137) does:

1. Generate a `requestId` (16 chars) and subscribe to `llm-stream-<id>` **before** the invoke — otherwise the first chunk can be lost.
2. `invoke<StreamResponse>('llm_stream_text', { request })`.
3. For each incoming event, run `normalizeStreamEvent` (snake_case ↔ camelCase aliases) and push to an internal queue.
4. On `done` / `error` terminal events, automatically close the listener.
5. Return an `AsyncGenerator<StreamEvent>` for the caller to consume with `for await`.

All fields of `StreamTextRequest` / `StreamEvent` are defined in [types.ts](file:///Users/a1-6/project/talkcody/src/services/llm/types.ts); the discriminated union lets consumers statically exhaust cases with `switch`.

### 3.3 Event bus: `llm-event-stream.ts`

[llm-event-stream.ts](file:///Users/a1-6/project/talkcody/src/services/llm/llm-event-stream.ts) provides three things:

- `LlmEventStream`: wraps `listen` / `close` lifecycle
- `normalizeStreamEvent`: aligns backend aliases (`response_id` vs `responseId`, `fallback_reason` vs `reason`)
- `isTerminalEvent`: detects `done` / `error`

### 3.4 State: `useTaskStore`

Streaming output flows into [task-store.ts](file:///Users/a1-6/project/talkcody/src/stores/task-store.ts) through `onChunk` / `onToolMessage` callbacks. `StreamingMessagesCache` is a `Map<taskId, { baseMessages, derivedMessages, streamingContent }>` that avoids cloning the whole message array on every `text-delta`.

### 3.5 Tool Execution Loop

When the LLM streams a `tool-call`:

1. `StreamProcessor` converts it to a `UIMessage` and appends it to the store.
2. `ToolExecutor` (inside `LLMService`) runs the tool with smart concurrency.
3. The tool result (write file, bash, lsp, MCP) is wrapped as `tool-result` and pushed back into the loop.
4. The loop inspects `finishReason`:
   - `stop` / `end_turn` → exit
   - `tool_calls` → append tool result, build the next `StreamTextRequest`, continue
   - `length` / `max_tokens` → auto-continue

---

## 4. Backend Walkthrough (Tauri + Rust)

### 4.1 Tauri Command Entry

[commands.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/commands.rs#L40-L70):

```rust
#[tauri::command]
pub async fn llm_stream_text(
    window: Window,
    request: StreamTextRequest,
    state: State<'_, LlmState>,
) -> Result<StreamResponse, String> {
    let (registry, api_keys) = { /* lock state */ };
    let handler = StreamHandler::new(registry, api_keys);
    let request_id = request.request_id.clone().unwrap_or_else(|| "0".to_string());

    let request_id_clone = request_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = handler
            .stream_completion(window, request, request_id_clone)
            .await { ... }
    });

    Ok(StreamResponse { request_id })
}
```

Key points:

- The command returns `request_id` immediately, it does not wait for the stream to finish.
- The real streaming work runs inside `tauri::async_runtime::spawn`.
- `window: Window` is the channel used to push events back to the frontend.

### 4.2 StreamHandler

[stream_handler.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/streaming/stream_handler.rs) is the orchestrator:

1. Resolve `model` → `model_key`, `provider_id`, `provider_model_name`.
2. `ProviderRegistry::create_provider` → `Provider`.
3. `provider.build_complete_request(ctx)` → `BuiltRequest { url, headers, body, transport, route }`.
4. Transport selection:
   - `transport == Websocket && openai_responses_ws::should_use_websocket_transport` → OpenAI Responses WebSocket.
   - Otherwise → `reqwest` HTTP SSE.
5. `bytes_stream` → `find_sse_delimiter` + `parse_sse_event` → `provider.parse_stream_event_with_context` → `StreamEvent`.
6. Every event is forwarded via `emit_event(window, event_name, &event)` (i.e. `window.emit("llm-stream-<id>", event)`).
7. A `StreamEvent::Done` is force-emitted as a safety net at the end.
8. Error paths emit `StreamEvent::Error` and `return Err`.

`StreamParseState` keeps all the cursors needed for incremental parsing: `tool_calls`, `tool_call_index_map`, `content_block_types`, `response_id`, `openai_reasoning`, etc.

### 4.3 StreamRunner (model fallback + transient retry)

[stream_runner.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/ai_services/stream_runner.rs) wraps a single attempt in retry+fallback:

- `build_attempt_models` merges `request.model` and `request.fallback_models` into an attempt sequence.
- After every `stream_once` it resets `previousResponse_id` and `transport_session_id` so the next fallback model is not poisoned.
- Transient errors (`overloaded`, `processing your request`) on the same model trigger `1s → 2s → 4s` exponential backoff, up to `TRANSIENT_PROVIDER_RETRY_LIMIT` (default 3).
- Any non-transient error jumps to the next fallback model.

### 4.4 Provider / Protocol Abstraction

[provider.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/providers/provider.rs) defines:

```rust
#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn protocol_type(&self) -> ProtocolType;
    fn config(&self) -> &ProviderConfig;
    async fn resolve_base_url(&self, ctx: &ProviderContext<'_>) -> Result<String, String>;
    async fn resolve_endpoint_path(&self, ctx: &ProviderContext<'_>) -> String;
    async fn get_credentials(&self, api_key_manager: &ApiKeyManager) -> Result<ProviderCredentials, String>;
    async fn build_headers(&self, ctx, credentials) -> Result<HashMap<String, String>, String>;
    async fn build_complete_request(&self, ctx) -> Result<BuiltRequest, String>;
    async fn parse_stream_event_with_context(&self, ctx, event, data, state) -> Result<Option<StreamEvent>, String>;
    // closure-based overrides (build_protocol_headers, add_provider_headers, ...)
}
```

`Provider` composes protocol defaults with provider-specific behaviour through closure-style methods. For example `OpenAiProvider` overrides `resolve_endpoint_path` to hit `codex/responses`, while `GithubCopilotProvider` overrides `build_headers` to add `Editor-Version`.

`provider_registry.rs` ships with:

- `TalkCody Free` (Claude protocol)
- `OpenAI` (OpenAI-compatible + OAuth)
- `Anthropic` (Claude protocol)
- `GitHub Copilot` (OpenAI-compatible + custom headers)
- `OpenRouter` (OpenAI-compatible + recommended site headers)
- `Moonshot` / `Kimi Coding` (OpenAI-compatible + regional endpoints)
- `Vercel AI Gateway` (OpenAI-compatible)
- Custom OpenAI-compatible / Anthropic providers

### 4.5 OpenAI Responses WebSocket Path

[openai_responses_ws.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/streaming/openai_responses_ws.rs) is a separate transport:

- Auto-detects ChatGPT Subscription (OAuth) and decides `should_use_websocket_transport`.
- Uses `tungstenite` / `tokio-tungstenite` to keep a WS open and reuses `previous_response_id` / `transport_session_id`.
- On failure it returns `FallbackToHttpSse` and `StreamHandler` switches to HTTP SSE.
- The protocol layer (`openai_responses_protocol.rs`) maps events into the same generic `StreamEvent` shape (`text-delta` / `reasoning-*` / `response-metadata` / `usage` / `done`).

### 4.6 Other AI Service Commands

`llm/commands.rs` also exposes one-shot commands, all running through the Rust adapter layer:

- `llm_transcribe_audio` — audio transcription
- `llm_calculate_cost` — pricing via `ModelPricing`
- `llm_get_completion` — editor inline completion
- `llm_generate_commit_message` — diff → commit message
- `llm_generate_title` — task title
- `llm_compact_context` — context compaction (with 503 retry and budget-based shrink)
- `llm_enhance_prompt` — prompt enhancement
- `llm_generate_image` / `llm_download_image` — image generation

These commands are `request → result` synchronous; the frontend calls them through `llmClient.xxx()`.

### 4.7 OAuth Flows

`llm_claude_oauth_start` / `llm_claude_oauth_complete` / `llm_claude_oauth_refresh` and the OpenAI / GitHub Copilot counterparts implement PKCE-based auth. The TS side ([openai-oauth-service.ts](file:///Users/a1-6/project/talkcody/src/providers/oauth/openai-oauth-service.ts)) only bootstraps PKCE/state and hands the parameters to Rust.

---

## 5. Data Formats

### 5.1 `StreamTextRequest` (frontend → backend)

```ts
type StreamTextRequest = {
  model: string;                                // "gpt-5.2-codex@openai"
  fallbackModels?: string[] | null;             // ["claude-3-5-sonnet@anthropic", …]
  messages: Message[];
  tools?: ToolDefinition[] | null;              // { type:'function', name, description, parameters, strict: true }
  stream?: boolean | null;                      // default true
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  topK?: number | null;
  providerOptions?: ProviderOptions;            // passed through to provider_options
  requestId?: string | null;                    // frontend-generated 16-char id
  traceContext?: TraceContext | null;           // passed through to TraceWriter
  conversationMode?: 'stateless' | 'responses-chained' | null;
  inputMode?: 'full-history' | 'incremental' | null;
  previousResponseId?: string | null;           // OpenAI Responses chaining
  transportSessionId?: string | null;           // WS session id
  allowTransportFallback?: boolean | null;
  continuationContext?: ContinuationContext | null; // { iteration, baselineMessageCount, deltaMessageCount, fallbackCount }
  contextManagement?: ContextManagementConfig | null; // Anthropic cache_edits
};
```

The Rust counterpart in [types.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/types.rs) uses `#[serde(rename_all = "camelCase")]` plus targeted `rename = "..."` to stay compatible with TS.

### 5.2 `Message`

```ts
type Message =
  | { role: 'system'; content: string; providerOptions?: ProviderOptions }
  | { role: 'user'; content: MessageContent; providerOptions?: ProviderOptions }
  | { role: 'assistant'; content: MessageContent; providerOptions?: ProviderOptions }
  | { role: 'tool'; content: ContentPart[]; providerOptions?: ProviderOptions };

type MessageContent = string | ContentPart[];

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string }                    // url or base64
  | { type: 'video'; video: string; mimeType?: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; providerMetadata?: ProviderOptions }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'reasoning'; text: string; providerOptions?: ProviderOptions };
```

Rust serialises it as `#[serde(tag = "role", rename_all = "lowercase")]` so the wire format is `{"role":"user","content":...}` — close to the OpenAI/Claude common shape, so the protocol layer can map with minimal translation.

### 5.3 `StreamEvent` (backend → frontend)

```ts
type StreamEvent =
  | { type: 'text-start' }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; providerMetadata?: ProviderOptions }
  | { type: 'reasoning-start'; id: string; providerMetadata?: ProviderOptions }
  | { type: 'reasoning-delta'; id: string; text: string; providerMetadata?: ProviderOptions }
  | { type: 'reasoning-end'; id: string }
  | { type: 'response-metadata'; responseId: string; transport: 'http-sse'|'websocket'; provider: 'openai-subscription'|'openai-api'; continuationAccepted?: boolean; transportSessionId?: string }
  | { type: 'transport-fallback'; reason: string; from: 'websocket'|'responses-chained'; to: 'http-sse'|'stateless'|'fresh-websocket-baseline' }
  | { type: 'usage'; input_tokens: number; output_tokens: number; total_tokens?: number|null; cached_input_tokens?: number|null; cache_creation_input_tokens?: number|null }
  | { type: 'done'; finish_reason?: string|null }
  | { type: 'error'; message: string; name?: string }
  | { type: 'raw'; raw_value: string };
```

Highlights:

- Text and reasoning live on separate channels so the UI can render "thinking" content distinctly.
- `response-metadata` is the key for OpenAI Responses chaining — `responseId` and `transportSessionId` are echoed in the next request.
- `transport-fallback` lets the frontend show "WS failed → HTTP SSE fallback" hints.
- `usage` arrives at the end (or at intermediate token points) so the frontend can compute cost using `ModelPricing`.
- `raw` is a debug escape hatch; the renderer doesn't consume it.

### 5.4 `ToolDefinition`

```ts
type ToolDefinition = {
  type: 'function';
  name: string;
  description?: string | null;
  parameters: unknown;     // JSON Schema
  strict: true;
};
```

`toOpenAIToolDefinition` converts project-local `ToolWithUI` into this shape. The protocol layer then maps it into the per-provider `tools` field.

### 5.5 `ProviderConfig` / `AvailableModel`

- `ProviderConfig` (TS) / `ProviderConfig` (Rust, camelCase via serde) — provider metadata
- `AvailableModel` — model catalogue entry with `key / name / provider / imageInput / imageOutput / audioInput / videoInput / inputPricing`
- `ModelConfig` / `ModelPricing` — pricing, context length, provider routing table

### 5.6 Tauri Event Payload

- Event name: `llm-stream-<request_id>` (`format!("llm-stream-{}", request_id)` on the Rust side)
- Payload: `StreamEvent` JSON; serde handles `camelCase` ↔ `snake_case` automatically, and the TS side's `normalizeStreamEvent` aligns the remaining aliases
- Termination: once `done` / `error` arrives, `LlmEventStream` unlistens automatically to avoid leaks

---

## 6. Key Sequences

### 6.1 Normal Conversation Flow (simplified)

```text
User  → ChatBox  → taskStore.appendMessage
     → executionService.run()
     → LLMService.runAgentLoop()
        ├─ resolveCachedMessages()    // load compacted history + new delta
        ├─ planStreamTextRequest()    // stateless / responses-chained / incremental
        ├─ llmClient.streamText()
        │   ├─ listen('llm-stream-<id>')
        │   └─ invoke('llm_stream_text', { request })
        │       └─ Tauri dispatches to a Rust task
        │           └─ StreamHandler::stream_completion
        │               ├─ resolve model/provider
        │               ├─ build request (Provider/Protocol)
        │               ├─ reqwest SSE / OpenAI WS
        │               └─ keep window.emit('llm-stream-<id>', StreamEvent)
        ├─ for await StreamEvent
        │   ├─ text-delta  → onChunk → taskStore.update streamingContent
        │   ├─ tool-call   → ToolExecutor.execute
        │   ├─ reasoning-* → onReasoningUpdate
        │   ├─ usage       → onUsage
        │   └─ done/error  → finish
        └─ loop: tool result → messages.push → planStreamTextRequest again
     → onComplete(fullText)
```

### 6.2 OpenAI Responses Chaining

- First turn: `conversationMode=responses-chained` is honoured.
- Backend returns `response-metadata { responseId, transportSessionId, continuationAccepted }`.
- Next turns use `inputMode=incremental` + `previousResponseId=…` + `transportSessionId=…` to reuse server-side state.
- If WS fails, backend emits `transport-fallback`. The frontend `ResponsesChainManager` marks the chain broken; the next turn degrades to `stateless` and resends the full history.

### 6.3 Compaction Trigger

- `loopState.lastRequestTokens > autoCompactThreshold(currentModel)`.
- `performCompressionIfNeeded` calls `ContextCompactor.compactMessages`:
  - Tries the local session memory compaction first (no LLM call).
  - Falls back to `AISummarizationStrategy` (calls `llm_compact_context`) only if needed.
- After compaction, `CompactionManager.runAutoCompaction`:
  - Rewrites `loopState.messages`.
  - `saveCompactedMessages` persists to `.talkcody/context/<taskId>/compacted-messages.json`.
  - Writes `.talkcody/context/<taskId>/session-memory.json` as a fallback sidecar.
- Next loop entry uses `resolveCachedMessages` to pick up the compacted base.

---

## 7. Failure, Retry, and Resilience

| Scenario | Backend behaviour | Frontend behaviour |
| --- | --- | --- |
| 401/403 auth failure | Pass-through error + emit `StreamEvent::Error` | `LLMService` marks OAuth as invalid and prompts re-auth |
| 429 rate limit | No auto-retry in Rust (compaction uses fallback) | Backoff via `stream-retry-orchestrator.ts` |
| 5xx / 503 overload | `StreamRunner` transient retry up to `TRANSIENT_PROVIDER_RETRY_LIMIT`, exponential backoff; then try fallback model | `stream-retry-orchestrator` on the agent loop side |
| Network drop / idle timeout | `tokio::time::timeout(stream_timeout, stream.next())` triggers `StreamEvent::Error` | Abort + notify user |
| OpenAI Responses WS handshake fail | Emit `transport-fallback` and switch to HTTP SSE | UI is unaware, continues automatically |
| Compaction failure | `CompactionManager` rebuilds from `session-memory.json` sidecar | Seamless recovery |
| 3 consecutive compaction failures | Circuit breaker trips, future compactions skipped | LLMService throttles to manual mode |
| AbortSignal | Rust does not honour abort (relies on reqwest closing the connection) | `LlmClient.stop()` unlistens and finishes the queue |

---

## 8. Code Index

| Topic | Path |
| --- | --- |
| Tauri stream command | `src-tauri/core/src/llm/commands.rs::llm_stream_text` |
| Stream orchestrator | `src-tauri/core/src/llm/streaming/stream_handler.rs` |
| Fallback + transient retry | `src-tauri/core/src/llm/ai_services/stream_runner.rs` |
| OpenAI Responses WebSocket | `src-tauri/core/src/llm/streaming/openai_responses_ws.rs` |
| OpenAI protocol | `src-tauri/core/src/llm/protocols/openai_protocol.rs` |
| OpenAI Responses protocol | `src-tauri/core/src/llm/protocols/openai_responses_protocol.rs` |
| Claude protocol | `src-tauri/core/src/llm/protocols/claude_protocol.rs` |
| Provider registry | `src-tauri/core/src/llm/providers/provider_registry.rs` |
| Provider trait | `src-tauri/core/src/llm/providers/provider.rs` |
| Compaction (TS) | `src/services/context/context-compactor.ts` |
| Compaction (Rust) | `src-tauri/core/src/llm/ai_services/context_compaction_service.rs` |
| Compaction manager | `src/services/agents/compaction-manager.ts` |
| Frontend LLMClient | `src/services/llm/llm-client.ts` |
| Event bus | `src/services/llm/llm-event-stream.ts` |
| TS types | `src/services/llm/types.ts` |
| Agent loop | `src/services/agents/llm-service.ts::runAgentLoop` |
| Task state | `src/stores/task-store.ts` |
| ChatBox | `src/components/chat-box.tsx` |
| OAuth (TS) | `src/providers/oauth/*` |

---

## 9. Contribution Tips

1. **Adding a provider**: register a `ProviderConfig` in `provider_registry.rs::builtin_providers` and supply a `Provider` impl (most cases can use `DefaultProvider` + a `Protocol`).
2. **Adding a protocol**: implement the three traits on `LlmProtocol` — `ProtocolHeaderBuilder`, `ProtocolRequestBuilder`, `ProtocolStreamParser` — and dispatch from `Provider::build_complete_request` / `parse_stream_event_with_context`.
3. **Adding a stream event type**: add a new case in both `StreamEvent` (Rust) and `types.ts` (TS). TS discriminated unions give you automatic narrowing on the consumer side.
4. **Tweaking compaction**: edit `ContextCompactor` / `AISummarizationStrategy` / `session-memory-compaction.ts`. New strategies need to be wired into `CompressionStrategyType`, the UI selectors, and the prompts.
5. **Watch the naming**: Rust uses serde aliases to keep camelCase compatibility with TS. The TS side's `normalizeStreamEvent` aligns the remaining `snake_case` aliases.

---

## 11. Frontend Streaming Rendering

This section explains how stream events become UI in React — `MessageItem` dispatch, the `StreamProcessor` state machine, tool-specific renderers, and rich interaction components like plan review and question forms.

### 11.1 Overall Pipeline

```
Tauri event  →  LlmEventStream.normalizeStreamEvent
            →  LLMService.runAgentLoop  →  StreamProcessor.processXxx()
            →  AgentLoopCallbacks (onChunk / onReasoningUpdate / onToolMessage)
            →  Zustand stores (taskStore / streamingMessagesCache)
            →  React (MessageList → MessageItem → tool-specific components)
```

[llm-service.ts](file:///Users/a1-6/project/talkcody/src/services/agents/llm-service.ts#L271-L290) consumes the `for await StreamEvent` and dispatches by `type`:

- `text-start` → `streamProcessor.processTextStart` → `onAssistantMessageStart` → flips `isAnswering = true`
- `text-delta` → `processTextDelta` → `onChunk(text)` appends to current assistant message's `streamingContent`
- `reasoning-start` / `reasoning-delta` / `reasoning-end` → `processReasoning*` → `onReasoningUpdate({ reasoningContent, isStreaming })`
- `tool-call` → `processToolCall` → `onToolMessage({ role:'tool', content:[tool-call part] })`
- `response-metadata` → records `responseId / transportSessionId` for the next chain turn
- `usage` / `done` / `error` → trigger accounting and cleanup

`StreamProcessor` keeps a [StreamProcessorState](file:///Users/a1-6/project/talkcody/src/services/agents/stream-processor.ts#L43-L65) covering:

- `isAnswering` / `hasReceivedText` — decide if a new assistant message is needed
- `contentOrder: Array<{ type: 'reasoning' | 'text', index }>` — preserve ordering when assembling the final content
- `reasoningBlocks: ReasoningBlock[]` — multiple reasoning segments with deep-merged `signature` / `redactedData`
- `consecutiveToolErrors` — circuit breaker after repeated tool failures
- `fullReset()` / `resetState()` — clear between conversations / iterations

### 11.2 MessageItem Dispatch

[message-item.tsx](file:///Users/a1-6/project/talkcody/src/components/chat/message-item.tsx) is the single UI entry point:

1. Branch by `message.role`:
   - `user` → `UserCircle` avatar + text/attachments
   - `assistant` → `Bot` avatar + reasoning collapse area (auto-expands while streaming, auto-collapses on finish) + Markdown body
   - `tool` → go to step 2
2. For `role:'tool'`, iterate `message.content: ContentPart[]` and branch by `item.type`:
   - `tool-call` → `toolRenderers.renderToolDoing(input, { taskId })`
   - `tool-result` → `toolRenderers.renderToolResult(output, input)`
   - Unregistered tool → fallback [UnifiedToolResult](file:///Users/a1-6/project/talkcody/src/components/tools/unified-tool-result.tsx) (raw JSON)
3. For `callAgent`, filter `message.nestedTools` to those with matching `parentToolCallId` and nest them below the doing card.
4. Every tool node is wrapped in [ToolErrorBoundary](file:///Users/a1-6/project/talkcody/src/components/tools/tool-error-boundary.tsx) so one tool crashing doesn't kill the whole message.

The reasoning collapse logic in [message-item.tsx](file:///Users/a1-6/project/talkcody/src/components/chat/message-item.tsx#L72-L100):

- `useEffect` watches `message.isReasoningStreaming`
- On a new message id, seed `isReasoningExpanded` from current streaming state
- While streaming keep it expanded; on the streaming → idle transition, auto-collapse
- Once the user manually opens it, auto-collapse is disabled

### 11.3 Tool Registry: `tool-adapter.ts`

Tool → React component binding is not hard-coded inside `MessageItem`; it lives in a global `Map` in [tool-adapter.ts](file:///Users/a1-6/project/talkcody/src/lib/tool-adapter.ts):

```ts
const toolUIRegistry = new Map<string, {
  renderToolDoing: (params, context) => ReactElement | null;
  renderToolResult: (result, params) => ReactElement | null;
}>();

registerToolUIRenderers(toolWithUI, keyName);
getToolUIRenderers(toolName) // called from message-item
```

Two registration paths:

- [lib/tools/index.ts](file:///Users/a1-6/project/talkcody/src/lib/tools/index.ts) `loadAllTools()` registers at startup
- [services/agents/agent-registry.ts](file:///Users/a1-6/project/talkcody/src/services/agents/agent-registry.ts) registers when loading agent-specific tools

To add a tool, implement `ToolWithUI` (`renderToolDoing` / `renderToolResult`) and add a row to `TOOL_DEFINITIONS` — no changes to `MessageItem` required.

### 11.4 Built-in Tool Render Matrix

Common tool renderers live under [components/tools/](file:///Users/a1-6/project/talkcody/src/components/tools):

| Tool | renderToolDoing | renderToolResult | Notes |
| --- | --- | --- | --- |
| `bash` | [bash-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/bash-tool-doing.tsx) | [bash-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/bash-tool-result.tsx) | exit code, background-task badge, long output collapse, timeout hint |
| `writeFile` | [write-file-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/write-file-tool-doing.tsx) | [write-file-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/write-file-result.tsx) | Path, permission prompt, error boundary |
| `editFile` | [edit-file-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/edit-file-tool-doing.tsx) | [edit-file-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/edit-file-result.tsx) | Inlined LCS diff with line-level added/removed coloring |
| `readFile` | [generic-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/generic-tool-doing.tsx) | [generic-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/generic-tool-result.tsx) | `renderDoingUI:false` to avoid UI flash |
| `listFiles` | [list-files-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/list-files-doing.tsx) | [list-files-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/list-files-result.tsx) | Tree view, clickable rows to open editor |
| `glob` | [glob-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/glob-doing.tsx) | [glob-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/glob-result.tsx) | Pattern highlight, hit counts |
| `codeSearch` / `webSearch` | [search-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/search-tool-doing.tsx) | [search-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/search-tool-result.tsx) | Grouped results, copy path |
| `webFetch` | same | same | URL preview card + Markdown summary |
| `askUserQuestions` | [ask-user-questions-ui.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/ask-user-questions-ui.tsx) | [ask-user-questions-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/ask-user-questions-result.tsx) | Multi-tab form, single/multi select + free text + required validation |
| `exitPlanMode` | reuse | [plan-review-card.tsx](file:///Users/a1-6/project/talkcody/src/components/plan/plan-review-card.tsx) | Approve / reject / edit + feedback box |
| `callAgent` | [call-agent-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/call-agent-tool-doing.tsx) | [call-agent-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/call-agent-tool-result.tsx) | Auto-detect `plan.md` path and render as Markdown |
| `todoWrite` | [todo-write-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/todo-write-tool-doing.tsx) | [todo-write-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/todo-write-tool-result.tsx) | Highlights the current step |
| `custom tools` | [custom-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/custom-tool-doing.tsx) | [custom-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/custom-tool-result.tsx) | Renderer is supplied by the user in tool config |

Tools with `renderDoingUI: false` (read / glob / listFiles / codeSearch / getCurrentDateTime / todoWrite etc.) skip the "doing" card and jump straight to the result.

### 11.5 Plan Data Rendering

Plan has two entry points:

1. `exitPlanMode` tool result card: [plan-review-card.tsx](file:///Users/a1-6/project/talkcody/src/components/plan/plan-review-card.tsx)
   - Approve / reject / edit buttons at the top
   - `useEffect` watches `autoApprovePlan` task setting; auto-approves when set
   - Edit mode: `Textarea` for inline edits, edited content is passed back on approve
   - Reject flow opens a feedback box that becomes the next `user` message
2. `callAgent` result card: [call-agent-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/call-agent-tool-result.tsx)
   - Regex-extracts a `` `.../plan.md` `` path from the output
   - Uses `@tauri-apps/plugin-fs` `readTextFile` to read the plan file
   - Falls back to raw output on failure; renders Markdown on success

The plan-mode toggle lives at [settings-store.ts](file:///Users/a1-6/project/talkcody/src/stores/settings-store.ts) (`is_plan_mode_enabled`) and is injected into the system prompt as `<plan_mode>TRUE/FALSE</plan_mode>` by [services/prompt/providers/env-provider.ts](file:///Users/a1-6/project/talkcody/src/services/prompt/providers/env-provider.ts).

### 11.6 Bash Output Rendering

[bash-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/bash-tool-result.tsx) carries both "execution state" and "execution result":

- `success / exitCode` choose the primary color (green/red)
- `outputFilePath / errorFilePath` show an i18n hint that the full output was saved to disk
- `idleTimedOut / timedOut` render a background-task card with PID
- `output` is rendered in a monospace, scrollable, wrap-friendly panel that resists layout blowup
- `error` reuses the same panel, governed by `displayOutput = output || error || message`

### 11.7 File Change Rendering

File changes flow through two paths, then converge at [file-changes-summary.tsx](file:///Users/a1-6/project/talkcody/src/components/chat/file-changes-summary.tsx):

1. Live diff (per edit): [edit-file-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/edit-file-result.tsx) inlines an LCS diff (>2000 lines auto-degrades to "too large" notice)
2. Whole-task rollup:
   - `useFileChangesStore` groups `fileChanges` by `taskId`
   - When the same file changes multiple times, keep the first `originalContent` and use `isInitialWrite ? write : edit` to determine the operation
   - Top bar shows new/edited counts; `git commit` button is wired to [useGit](file:///Users/a1-6/project/talkcody/src/hooks/use-git.ts) for AI commit messages
   - In worktree mode, also shows merge progress and conflicted files

### 11.8 Ask-User-Questions Rendering

[ask-user-questions-ui.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/ask-user-questions-ui.tsx) is the LLM-asks-the-user interaction:

- `questions: Question[]` — each question is a multi-tab form: `multiSelect` options + free text
- `multiSelect: true` allows multiple choices; `false` is single-select
- Each question also supports a free-text supplement that co-exists with options
- `useUserQuestionStore.submitAnswers` packs the answers into `AskUserQuestionsOutput` and writes them back into the conversation
- A `submitted` state swaps in a "submitted" card to prevent double submission

The LLM side hook is in [lib/tools/ask-user-questions-tool.tsx](file:///Users/a1-6/project/talkcody/src/lib/tools/ask-user-questions-tool.tsx), triggered by the model via a tool call. The plan-rejection feedback input also rides on this store.

### 11.9 Markdown / Code / Diagrams

[my-markdown.tsx](file:///Users/a1-6/project/talkcody/src/components/chat/my-markdown.tsx) is the final stop for all assistant text:

- `react-markdown` + `remark-gfm` + `rehype-highlight` for GitHub-flavoured Markdown
- Code blocks go through [code-block.tsx](file:///Users/a1-6/project/talkcody/src/components/chat/code-block.tsx) (copy / collapse)
- `mermaid` blocks (``` ```mermaid ``` ```) render SVG on the client via mermaid
- HTML entities are decoded via `decodeObjectHtmlEntities`
- Theme-aware: dark/light mode switches the highlight theme

### 11.10 Agent Steps UI

[ai-elements/task.tsx](file:///Users/a1-6/project/talkcody/src/components/ai-elements/task.tsx) wraps the chat with `use-stick-to-bottom` for "always follow the latest message":

- `Task`: outer container, observes scroll position
- `TaskContent`: inner content area
- `TaskScrollButton`: appears when the user scrolls away from the bottom; click returns to the latest

Step bookkeeping is done in [MessageList](file:///Users/a1-6/project/talkcody/src/components/chat/message-list.tsx) via `derivedMessages`:

- Empty messages (`isEmptyMessage`) are filtered out
- Completed tool calls (`completedToolCalls.has(toolCallId)`) are merged / hidden
- The last assistant message in each turn is marked (so the `Regenerate` button shows in the right place)

### 11.11 Attachments / Images / Video

`MessageAttachment` is injected during streaming via the `onAttachment` callback:

- Image: `<img>` with Tauri's `convertFileSrc` to `asset://`
- Video: `<video>` with controls
- Generic file: attachment card with name + path

These live alongside the Markdown body without colliding with it.

### 11.12 Performance and Consistency

- [StreamingMessagesCache](file:///Users/a1-6/project/talkcody/src/stores/task-store.ts) splits base / derived / streaming so a `text-delta` doesn't clone the whole message array
- [MessageItem](file:///Users/a1-6/project/talkcody/src/components/chat/message-item.tsx) wraps tool nodes with `memo` + `useMemo`
- `computeDerivedMessages` runs once at the top of `MessageList` and feeds the rest of the tree
- During streaming, `use-stick-to-bottom` smooths the auto-scroll while letting the user scroll up freely

---

## 12. Data Structures Returned to the Frontend

This section is the field-level reference for all stream events and message structures. The Rust side in [types.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/types.rs) is the source of truth; the TS side in [types.ts](file:///Users/a1-6/project/talkcody/src/services/llm/types.ts) mirrors it field-for-field.

### 12.1 Naming: snake_case ↔ camelCase

The Rust side uses `#[serde(rename_all = "kebab-case")]` / `#[serde(rename = "...")]` so enum values and field names serialize in a shape that's directly compatible with the TS `camelCase` types:

- Enum values are `kebab-case`: `responses-chained`, `http-sse`, `websocket`, `openai-subscription`, `fresh-websocket-baseline`
- Field names are `camelCase`: `requestId` ↔ `request_id`, `toolCallId` ↔ `tool_call_id`, `finishReason` ↔ `finish_reason`, `inputTokens` ↔ `input_tokens`, `cachedInputTokens` ↔ `cached_input_tokens`
- `ProviderOptions`-style free-form objects are `serde_json::Value` ↔ `unknown` ↔ `Record<string, unknown> | null`

This means the Rust side can call `window.emit("llm-stream-<id>", event)` directly; the TS `normalizeStreamEvent` only needs to fix a handful of legacy aliases.

### 12.2 Top-level Stream Envelope

```ts
// from src/services/llm/llm-client.ts
type StreamResponse = { request_id: string };

// event payload: StreamEvent (discriminated union)
```

- `StreamResponse` is the return value of `invoke<StreamResponse>('llm_stream_text', { request })`; it only carries `requestId`
- The real streaming payload is pushed as `StreamEvent` over the Tauri event `llm-stream-<requestId>`
- Termination: `done` or `error`. `LlmEventStream` unlistens automatically

### 12.3 StreamEvent Discriminated Union (backend → frontend)

Source: [types.ts](file:///Users/a1-6/project/talkcody/src/services/llm/types.ts) `StreamEvent`, mirrors Rust [types.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/types.rs) `StreamEvent` field-for-field.

```ts
type StreamEvent =
  | { type: 'text-start' }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; providerMetadata?: ProviderOptions }
  | { type: 'reasoning-start'; id: string; providerMetadata?: ProviderOptions }
  | { type: 'reasoning-delta'; id: string; text: string; providerMetadata?: ProviderOptions }
  | { type: 'reasoning-end'; id: string }
  | {
      type: 'response-metadata';
      responseId: string;
      transport: 'http-sse' | 'websocket';
      provider: 'openai-subscription' | 'openai-api';
      continuationAccepted?: boolean;
      transportSessionId?: string;
    }
  | {
      type: 'transport-fallback';
      reason: string;
      from: 'websocket' | 'responses-chained';
      to: 'http-sse' | 'stateless' | 'fresh-websocket-baseline';
    }
  | {
      type: 'usage';
      input_tokens: number;
      output_tokens: number;
      total_tokens?: number | null;
      cached_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
    }
  | { type: 'done'; finish_reason?: string | null }
  | { type: 'error'; message: string; name?: string }
  | { type: 'raw'; raw_value: string };
```

Field notes:

| `type` | Required | Optional | Meaning / trigger |
| --- | --- | --- | --- |
| `text-start` | — | — | Marks the assistant text channel start; triggers new assistant message |
| `text-delta` | `text` | — | Text increment. `MessageItem` appends to `streamingContent` via `onChunk` |
| `tool-call` | `toolCallId`, `toolName`, `input` | `providerMetadata` | One tool call. `input` is a free object (file path, command, question, etc.) |
| `reasoning-start` | `id` | `providerMetadata` | Reasoning channel start. `id` is the provider's block id, used to match `reasoning-end` |
| `reasoning-delta` | `id`, `text` | `providerMetadata` | Reasoning text increment. `providerMetadata` may carry Claude `signature`, Anthropic `redactedData` |
| `reasoning-end` | `id` | — | Reasoning channel end |
| `response-metadata` | `responseId`, `transport`, `provider` | `continuationAccepted`, `transportSessionId` | Used for OpenAI Responses chaining. The next request must echo `previousResponseId` / `transportSessionId` |
| `transport-fallback` | `reason`, `from`, `to` | — | WS failed → HTTP SSE / chain failed → stateless. Frontend uses this to inform users and adjust the next `conversationMode` |
| `usage` | `input_tokens`, `output_tokens` | `total_tokens`, `cached_input_tokens`, `cache_creation_input_tokens` | One-shot usage + cache hits. `total_tokens` may be `null`; fall back to `input+output` |
| `done` | — | `finish_reason` | Stream end. `finish_reason` is `stop` / `tool_calls` / `length` / `max_tokens` / `end_turn` |
| `error` | `message` | `name` | Terminal error. `message` is human-readable; frontend surfaces it via `toast.error` |
| `raw` | `raw_value` | — | Debug escape hatch. The raw SSE line; the renderer doesn't consume it |

`providerMetadata` is the multi-provider bag for reasoning, signature, and other non-standard fields:

- `signature`: Claude's reasoning signature, must persist in historical assistant messages
- `redactedData`: Anthropic's encrypted thinking block, must persist in `reasoning` parts
- `openaiCompatible.reasoning_content`: reasoning content from OpenAI-compatible providers (DeepSeek, Moonshot, etc.)
- `openai.safety`: OpenAI's safety scoring

### 12.4 Message and ContentPart (shared by both sides)

Source: [types.ts](file:///Users/a1-6/project/talkcody/src/services/llm/types.ts) `Message` / `ContentPart`, mirrors Rust [types.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/types.rs) `Message` / `ContentPart`.

```ts
type Message =
  | { role: 'system'; content: string; providerOptions?: ProviderOptions }
  | { role: 'user'; content: MessageContent; providerOptions?: ProviderOptions }
  | { role: 'assistant'; content: MessageContent; providerOptions?: ProviderOptions }
  | { role: 'tool'; content: ContentPart[]; providerOptions?: ProviderOptions };

type MessageContent = string | ContentPart[];

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string }                              // url or base64
  | { type: 'video'; video: string; mimeType?: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; providerMetadata?: ProviderOptions }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'reasoning'; text: string; providerOptions?: ProviderOptions };
```

Field notes:

- `role: 'system'`: `content` must be a string (the system prompt)
- `role: 'user'` / `'assistant'`: `content` can be a plain string (simple case) or `ContentPart[]` (multimodal / tool / reasoning mixed)
- `role: 'tool'`: `content` must be `ContentPart[]`; each part is a `tool-call` or `tool-result`
- `providerOptions`: every message can carry provider-private options such as `openaiCompatible.reasoning_content` or `anthropic.thinking.signature`

`ContentPart` types:

- `text`: plain text
- `image`: URL or base64. OpenAI uses `image_url`, Claude uses an `image` block
- `video`: URL or base64, optional `mimeType` (frontend infers if missing)
- `tool-call`: a call declaration. `input` is `serde_json::Value` on Rust, `unknown` on TS — keep it flexible
- `tool-result`: a call result. `output` is `unknown`; the actual shape is up to each tool's schema (text, JSON, image base64, etc.)
- `reasoning`: Claude / OpenAI / DeepSeek's `reasoning_content` and Anthropic's `thinking` text

### 12.5 StreamTextRequest (frontend → backend)

```ts
type StreamTextRequest = {
  model: string;                                  // e.g. "gpt-5.2-codex@openai"
  fallbackModels?: string[] | null;               // ordered fallback model list
  messages: Message[];                            // see 12.4
  tools?: ToolDefinition[] | null;                // tool definitions
  stream?: boolean | null;                        // default true
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  topK?: number | null;
  providerOptions?: ProviderOptions;              // provider-private passthrough
  requestId?: string | null;                      // 16-char id generated by the frontend
  traceContext?: TraceContext | null;             // passed through to TraceWriter
  conversationMode?: 'stateless' | 'responses-chained' | null;
  inputMode?: 'full-history' | 'incremental' | null;
  previousResponseId?: string | null;             // OpenAI Responses chaining
  transportSessionId?: string | null;             // WS session id
  allowTransportFallback?: boolean | null;        // whether to allow WS → HTTP-SSE fallback
  continuationContext?: ContinuationContext | null; // incremental context bookkeeping
  contextManagement?: ContextManagementConfig | null; // Anthropic cache_edits
};
```

Key sub-types:

```ts
type ContinuationContext = {
  iteration: number;              // iteration counter for the same loopState
  baselineMessageCount: number;   // message count after the last compaction
  deltaMessageCount: number;      // new messages since the baseline
  fallbackCount: number;          // number of fallbacks already taken
};

type TraceContext = {
  traceId: string;
  spanName: string;
  parentSpanId: string | null;
  metadata?: Record<string, string>;
};

type ContextManagementConfig = {
  enabled: boolean;
  toolResultIdsToDelete?: string[]; // Anthropic cache_edits
};
```

### 12.6 ToolDefinition

```ts
type ToolDefinition = {
  type: 'function';
  name: string;                  // e.g. "bash" / "readFile" / "exitPlanMode"
  description?: string | null;
  parameters: unknown;           // JSON Schema
  strict: true;
};
```

- The frontend `toOpenAIToolDefinition(name, description, inputSchema, opts)` produces this shape
- Rust `protocols/openai_protocol.rs` and `protocols/claude_protocol.rs` then map it into the per-provider `tools` field
- `strict: true` means "use OpenAI's strict JSON Schema mode"

### 12.7 One-shot AI Service Payloads

These are the `invoke<...>('llm_xxx', { request })` shapes (not stream events):

```ts
// Audio transcription
type TranscriptionRequest = {
  model: string; audioBase64: string; mimeType: string;
  language?: string | null; prompt?: string | null;
  temperature?: number | null; responseFormat?: string | null;
};
type TranscriptionResponse = { text: string; language?: string | null; duration?: number | null };

// Image generation
type ImageGenerationRequest = {
  model: string; prompt: string;
  size?: string | null; quality?: string | null; n?: number | null;
  responseFormat?: string | null;
  providerOptions?: ProviderOptions; requestId?: string | null;
};
type GeneratedImage = { b64Json?: string | null; url?: string | null; mimeType: string; revisedPrompt?: string | null };
type ImageGenerationResponse = { provider: string; images: GeneratedImage[]; requestId?: string | null };

// Image download
type ImageDownloadRequest = { url: string };
type ImageDownloadResponse = { data: number[]; mimeType: string };

// Editor inline completion
type CompletionContext = { fileContent: string; cursorPosition: number; fileName: string; language: string; model?: string | null };
type CompletionRange = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
type CompletionResult = { completion: string; range?: CompletionRange | null };

// Git commit message
type GitMessageContext = { userInput?: string | null; diffText: string; model?: string | null; fallbackModels?: string[] | null; language?: string | null };
type GitMessageResult = { message: string; suggestions?: string[] | null };

// Title generation
type TitleGenerationRequest = { userInput: string; language?: string | null; model?: string | null; fallbackModels?: string[] | null };
type TitleGenerationResult = { title: string };

// Context compaction (one-shot)
type ContextCompactionRequest = { conversationHistory: string; model?: string | null; fallbackModels?: string[] | null };
type ContextCompactionResult = { compressedSummary: string };

// Prompt enhancement
type PromptEnhancementRequest = { originalPrompt: string; projectPath?: string | null; conversationHistory?: string | null; enableContextExtraction: boolean; model?: string | null };
type PromptEnhancementResult = { enhancedPrompt: string; extractedKeywords: string[]; generatedQueries: string[]; contextSnippetCount: number };

// Usage & billing
type TokenUsage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number | null; cacheCreationInputTokens?: number | null };
type CalculateCostRequest = { modelId: string; usage: TokenUsage; modelConfigs: Record<string, ModelConfig> };
type CalculateCostResult = { cost: number };
```

### 12.8 Provider / Model Metadata

```ts
type ProviderConfig = {
  id: string;                    // "openai" / "anthropic" / "github-copilot" / "talkcody" ...
  name: string;                  // display name
  baseUrl: string;
  apiKeyName: string;            // key name in ApiKeyManager
  supportsOAuth: boolean;
  supportsCodingPlan: boolean;
  supportsInternational: boolean;
  codingPlanBaseUrl?: string | null;
  internationalBaseUrl?: string | null;
  headers?: Record<string, string> | null;
  extraBody?: unknown;
  authType: string;              // 'none' | 'bearer' | 'api-key' | 'oauth-bearer' | 'talkcody-jwt'
};

type ModelConfig = {
  name: string;
  imageInput: boolean; imageOutput: boolean; audioInput: boolean;
  interleaved: boolean;
  providers: string[];
  providerMappings?: Record<string, string> | null;  // providerId -> provider model name
  pricing?: ModelPricing | null;
  contextLength?: number | null;
};

type ModelPricing = { input: string; output: string; cachedInput?: string | null; cacheCreation?: string | null };

type AvailableModel = {
  key: string;                   // "gpt-5.2-codex"
  name: string;
  provider: string;               // "openai"
  providerName: string;           // "OpenAI"
  imageInput: boolean; imageOutput: boolean; audioInput: boolean; videoInput: boolean;
  inputPricing?: string;
};
```

### 12.9 Event Payload Termination Rules

- Every `StreamEvent` is pushed via `window.emit("llm-stream-<id>", event)`
- Termination is always `done` or `error`. If `done` lacks `usage`, the frontend may pull from a separate `usage` event
- No events are emitted after `error`. `done` may be followed by one `usage` event before the stream closes
- `LlmEventStream` normalises legacy `snake_case` aliases (e.g. `response_id` → `responseId`) so the TS types match exactly

### 12.10 Field Naming Compatibility (Rust ↔ TS)

| Rust field | JSON field | TS field |
| --- | --- | --- |
| `tool_call_id` | `toolCallId` | `toolCallId` |
| `request_id` | `requestId` | `requestId` |
| `response_id` | `responseId` | `responseId` |
| `transport_session_id` | `transportSessionId` | `transportSessionId` |
| `continuation_accepted` | `continuationAccepted` | `continuationAccepted` |
| `previous_response_id` | `previousResponseId` | `previousResponseId` |
| `allow_transport_fallback` | `allowTransportFallback` | `allowTransportFallback` |
| `continuation_context` | `continuationContext` | `continuationContext` |
| `input_tokens` | `input_tokens` | `input_tokens` |
| `output_tokens` | `output_tokens` | `output_tokens` |
| `total_tokens` | `total_tokens` | `total_tokens` |
| `cached_input_tokens` | `cached_input_tokens` | `cached_input_tokens` |
| `cache_creation_input_tokens` | `cache_creation_input_tokens` | `cache_creation_input_tokens` |
| `provider_options` | `providerOptions` | `providerOptions` |
| `provider_metadata` | `providerMetadata` | `providerMetadata` |
| `finish_reason` | `finish_reason` | `finish_reason` |
| `input_mode: InputMode::Incremental` | `incremental` | `incremental` |
| `conversation_mode: ConversationMode::ResponsesChained` | `responses-chained` | `responses-chained` |
| `transport: ResponseTransport::HttpSse` | `http-sse` | `http-sse` |
| `provider: ResponseMetadataProvider::OpenAiSubscription` | `openai-subscription` | `openai-subscription` |
| `to: TransportFallbackTarget::FreshWebsocketBaseline` | `fresh-websocket-baseline` | `fresh-websocket-baseline` |

---

## 10. TL;DR

> TalkCody's LLM pipeline is essentially a **Tauri client using `invoke + events` to treat the Rust backend as a streaming OpenAI-compatible gateway**. The frontend owns UI + state; Rust owns protocol, auth, retry, compaction, and side-effect execution. `StreamTextRequest` / `StreamEvent` are the single "protocol contract" that runs through the whole pipeline.
