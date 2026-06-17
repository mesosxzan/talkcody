---
title: 前端与后端 LLM 交互技术文档
description: TalkCody 中前端 React 客户端与 Rust/Tauri 后端如何围绕 LLM 协同工作、数据格式、选型与关键技术实现
icon: Cable
---

import { Callout } from 'fumadocs-ui/components/callout';

# 前端与后端 LLM 交互技术文档

本文面向二次开发者和希望理解 TalkCody 内核行为的读者，拆解 LLM 链路在前后端的角色分工、协议选型、数据格式、关键代码落点与失败/重试机制。

<Callout type="info">
本文基于 `src/services/llm/*`、`src/services/agents/llm-service.ts`、Tauri 命令 `llm_stream_text` 以及 `src-tauri/core/src/llm/*` 目录下的实现撰写。
</Callout>

---

## 1. 全景图

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

关键事实：

- 前端从不直接与 LLM 提供商通信。所有 HTTP / WebSocket 请求都先经过 Rust 后端。
- Rust 端负责鉴权、协议适配、流式解析、错误重试，并通过 Tauri 事件总线把流式片段回推到前端。
- 前端 `llmClient` 是薄包装，真正负责 LLM 调用的是 Rust 侧 `StreamHandler` / `StreamRunner`。
- 流式事件是 **命令 + 事件** 双通道：`invoke('llm_stream_text', { request })` 立刻返回 `request_id`，事件通过 `window.emit('llm-stream-<id>', StreamEvent)` 持续推送。

---

## 2. 技术栈选型与理由

### 2.1 前端栈

| 模块 | 技术 | 选型理由 |
| --- | --- | --- |
| UI 框架 | React 19 + TypeScript | 生态成熟、组件复用强；TS 让 LLM 协议数据结构（`StreamEvent` 联合类型）能被静态校验 |
| 构建 | Vite 7 | HMR 快，与 Tauri 2 的 WebView 集成顺畅 |
| 样式 | Tailwind 4 + Shadcn UI | 与 Tauri 桌面风格匹配，UI 资产可复制 |
| 状态管理 | Zustand | 比 Redux 轻量，能在 Tauri 渲染进程高效触发 React 渲染 |
| IPC | `@tauri-apps/api/core` `invoke` / `@tauri-apps/api/event` `listen` | Tauri 官方绑定；事件通道天然适合 SSE 风格的流式回推 |
| LLM 客户端 | 自研 `LlmClient` | 需要把 `request_id` 与 Tauri 事件总线串起来；`Vercel AI SDK` 适合纯 Web 场景，不直接适配 Tauri 后端转发 |
| 工具/MCP | 自研 `ToolExecutor` / `@/lib/mcp/*` | 工具是 LLM 协议外的副作用能力，必须在 Rust 侧执行（文件、bash、lsp） |

### 2.2 后端栈

| 模块 | 技术 | 选型理由 |
| --- | --- | --- |
| 桌面壳 | Tauri 2 | 比 Electron 体积小、内存低；Rust 后端可承担真正 LLM 适配层 |
| 异步运行时 | Tokio | LLM 请求是长连接 + 流式，必须 async/await |
| HTTP 客户端 | `reqwest` | 支持流式 `bytes_stream`，天然适合 SSE |
| 协议层 | 自研 `Protocol` trait + `openai_protocol.rs` / `claude_protocol.rs` / `openai_responses_protocol.rs` | 用 Provider-Protocol 分离应对 OpenAI Chat Completions、OpenAI Responses、Claude Messages 的差异 |
| 模型路由 | `ProviderRegistry` | 内置 OpenAI / Claude / Anthropic / OpenRouter / GitHub Copilot / Moonshot / Kimi / TalkCody / 自定义 OpenAI 兼容 provider |
| 持久化 | SQLite (libSQL) + Tauri `app_data_dir` 下的 `.talkcody/` 文件树 | 任务状态、压缩后的消息、session memory sidecar 都靠这套持久化 |
| 压缩/上下文 | 自研 `ContextCompactor` + 多策略（`ai_summarization`、`filter_only`、`code_summarization`、`selective_removal`） | 兼顾成本与质量；可以在 AI 失败时回退到本地 session memory summary |

### 2.3 选型权衡

- **为什么不用 Vercel AI SDK 直接调 LLM？**
  - LLM 工具调用结果必须在 Rust 侧执行（文件、bash、lsp、MCP），让前端直接调 LLM 会绕开本地执行沙箱。
  - API key 需要加密落盘到 OS keyring / SQLite，统一在 Rust 侧管理更安全。
  - 部分 provider（OpenAI Responses WS、Claude Prompt Caching `cache_edits`）需要更细的协议控制，自研协议层更灵活。

- **为什么事件总线 + invoke 双通道？**
  - Tauri `invoke` 是请求-应答模式，不适合长时间 SSE。
  - 把流式拆成 `invoke`（注册 + 返回 `request_id`）+ 事件（按 `request_id` 推 `StreamEvent`）是 Tauri 流式响应的官方推荐做法。

- **为什么用 Protocol/Provider 拆分？**
  - Provider 管鉴权、base_url、特殊 header（GitHub Copilot 的 `Editor-Version`、OpenRouter 的 `HTTP-Referer`）。
  - Protocol 管请求体与 SSE 解析（OpenAI Chat / OpenAI Responses / Claude Messages 三套协议差异巨大）。
  - 两者通过 `BuiltRequest.transport` 和 `provider_route()` 组合决定走 HTTP SSE 还是 OpenAI Responses WebSocket。

---

## 3. 前端交互链路

### 3.1 入口：ChatBox → LLMService

UI 侧由 [chat-box.tsx](file:///Users/a1-6/project/talkcody/src/components/chat-box.tsx) 把用户消息写入 `useTaskStore`，触发一次 `executionService.run()`。`runAgentLoop` 真实定义在 [llm-service.ts](file:///Users/a1-6/project/talkcody/src/services/agents/llm-service.ts#L271-L290)：

```ts
// LLMService.runAgentLoop()
streamResult = await llmClient.streamText(requestPlan.request, abortController?.signal);
```

`requestPlan.request` 包含：

- `model`：形如 `gpt-5.2-codex@openai` 的 `model@provider` 标识
- `messages`：UI 消息经 `toLlmMessages` 转成的 `Message[]`
- `tools`：`ToolDefinition[]`
- `conversationMode` / `inputMode` / `previousResponseId` / `transportSessionId`：OpenAI Responses 链式复用
- `continuationContext`：增量上下文（baseline / delta / fallbackCount）

### 3.2 LLMClient：invoke + 事件订阅

[llm-client.ts](file:///Users/a1-6/project/talkcody/src/services/llm/llm-client.ts#L41-L137) 负责：

1. 生成 `requestId`（16 位）并以 `llm-stream-<id>` 为事件名先订阅（关键：必须在 `invoke` 之前完成 listen，避免事件丢失）。
2. `invoke<StreamResponse>('llm_stream_text', { request })`。
3. 收到事件后做 `normalizeStreamEvent` 规范化（处理 `snake_case` ↔ `camelCase` 别名），推入内部队列。
4. 收到 `done` 或 `error` 终止事件时自动关闭监听器。
5. 返回 `AsyncGenerator<StreamEvent>`，调用方 `for await` 消费。

`StreamTextRequest` / `StreamEvent` 的所有字段在 [types.ts](file:///Users/a1-6/project/talkcody/src/services/llm/types.ts) 中定义；TS 的判别式联合（`type: 'text-delta' | 'tool-call' | ...`）让消费端可以用 `switch` 静态穷尽。

### 3.3 事件总线：`llm-event-stream.ts`

[llm-event-stream.ts](file:///Users/a1-6/project/talkcody/src/services/llm/llm-event-stream.ts) 提供三件事：

- `LlmEventStream`：封装 `listen` / `close` 生命周期
- `normalizeStreamEvent`：把后端可能发出的 `response_id` / `responseId`、`fallback_reason` / `reason` 别名归一
- `isTerminalEvent`：判断 `done` / `error` 终止事件

### 3.4 状态管理：useTaskStore

流式结果通过 `onChunk` / `onToolMessage` 回调落入 [task-store.ts](file:///Users/a1-6/project/talkcody/src/stores/task-store.ts) 的 `updateTaskUsage` / `appendMessage`，再由 React 组件订阅触发 UI 更新。`StreamingMessagesCache` 用 `Map<taskId, { baseMessages, derivedMessages, streamingContent }>` 做派生缓存，避免每次 `text-delta` 都全量拷贝。

### 3.5 工具执行闭环

当 LLM 流式返回 `tool-call` 事件时：

1. 前端 `StreamProcessor` 把它转成 `UIMessage` 推入 store
2. `ToolExecutor`（在 `LLMService` 内）通过智能并发调度执行该工具
3. 工具结果（写文件、bash、lsp 跳转、MCP）封装成 `tool-result` 推回 loop
4. Loop 判断 `finishReason`：
   - `stop` / `end_turn` → 退出
   - `tool_calls` → 把工具结果 append 进 messages，构造下一次 `StreamTextRequest` 继续调用
   - `length` / `max_tokens` → 自动续写

---

## 4. 后端交互链路（Tauri + Rust）

### 4.1 Tauri 命令入口

[commands.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/commands.rs#L40-L70)：

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

要点：

- 命令立即返回 `request_id`，不等流结束。
- 实际流式处理在 `tauri::async_runtime::spawn` 里跑。
- `window: Window` 用于事件回推。

### 4.2 StreamHandler

[stream_handler.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/streaming/stream_handler.rs) 是后端总调度：

1. 解析 `model` → 找到 `model_key`、`provider_id`、`provider_model_name`
2. 通过 `ProviderRegistry::create_provider` 拿到 `Provider`
3. `provider.build_complete_request(ctx)` 产出 `BuiltRequest { url, headers, body, transport, route }`
4. 选择传输：
   - `transport == Websocket && openai_responses_ws::should_use_websocket_transport` → OpenAI Responses WebSocket
   - 否则走 `reqwest` HTTP SSE
5. 读取 `bytes_stream` → `find_sse_delimiter` + `parse_sse_event` → `provider.parse_stream_event_with_context` → `StreamEvent`
6. 每次产出一个 `StreamEvent` 调用 `emit_event(window, event_name, &event)`，即 `window.emit("llm-stream-<id>", event)`
7. 结束时强制 emit `StreamEvent::Done`（保险丝）
8. 错误路径在多处 emit `StreamEvent::Error` 并 `return Err`

`StreamParseState` 维护增量解析需要的所有游标：`tool_calls`、`tool_call_index_map`、`content_block_types`、`response_id`、`openai_reasoning` 等。

### 4.3 StreamRunner（model fallback + transient retry）

[stream_runner.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/ai_services/stream_runner.rs) 是更高层的尝试-回退封装：

- `build_attempt_models` 把 `request.model` 与 `request.fallback_models` 合并成尝试序列
- 每次 `stream_once` 后重置 `previousResponse_id` 和 `transport_session_id`（避免链式污染）
- 同一模型遇到 transient 错误（`overloaded`、`processing your request`）时按 `1s → 2s → 4s` 指数退避重试 `TRANSIENT_PROVIDER_RETRY_LIMIT`（默认 3）次
- 任何模型出现非 transient 错误时直接进入下一个 fallback 模型

### 4.4 Provider / Protocol 抽象

[provider.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/providers/provider.rs) 定义：

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
    // ... closure-based overrides (build_protocol_headers, add_provider_headers, etc.)
}
```

`Provider` 通过闭包式方法把 `Protocol` 的默认行为与 provider 特殊行为组合，例如 `OpenAiProvider` 覆盖 `resolve_endpoint_path` 走 `codex/responses`，`GithubCopilotProvider` 覆盖 `build_headers` 加 `Editor-Version` 等。

`provider_registry.rs` 内置：

- `TalkCody Free`（Claude 协议）
- `OpenAI`（OpenAI 兼容 + OAuth）
- `Anthropic`（Claude 协议）
- `GitHub Copilot`（OpenAI 兼容 + 自定义 header）
- `OpenRouter`（OpenAI 兼容 + 站点推荐 header）
- `Moonshot` / `Kimi Coding`（OpenAI 兼容 + 国内/海外 endpoint）
- `Vercel AI Gateway`（OpenAI 兼容）
- 自定义 OpenAI 兼容 / Anthropic provider

### 4.5 OpenAI Responses WebSocket 路径

[openai_responses_ws.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/streaming/openai_responses_ws.rs) 是另一个传输通道：

- 对 ChatGPT Subscription（OAuth）自动判断 `should_use_websocket_transport`
- 用 `tungstenite` / `tokio-tungstenite` 建立 WS，复用 `previous_response_id` / `transport_session_id`
- 失败时 `FallbackToHttpSse`，由 `StreamHandler` 切回 HTTP SSE
- 事件类型被 `openai_responses_protocol.rs` 映射到通用 `StreamEvent`（`text-delta` / `reasoning-*` / `response-metadata` / `usage` / `done`）

### 4.6 其他 AI 服务命令

`llm/commands.rs` 还暴露了若干一次性调用，统一走 Rust 适配层：

- `llm_transcribe_audio` → 音频转写
- `llm_calculate_cost` → 用 `ModelPricing` 计算成本
- `llm_get_completion` → 编辑器内联补全
- `llm_generate_commit_message` → 借助 diff 生成提交信息
- `llm_generate_title` → 任务标题生成
- `llm_compact_context` → 上下文压缩（带 503 重试和按预算降载）
- `llm_enhance_prompt` → 提示词增强
- `llm_generate_image` / `llm_download_image` → 文生图

这些命令都是 `request → result` 同步模式，前端通过 `llmClient.xxx()` 调用。

### 4.7 OAuth 流程

`llm_claude_oauth_start` / `llm_claude_oauth_complete` / `llm_claude_oauth_refresh` 等命令实现 Anthropic、OpenAI、GitHub Copilot 三个 OAuth 流程。前端 [openai-oauth-service.ts](file:///Users/a1-6/project/talkcody/src/providers/oauth/openai-oauth-service.ts) 只负责引导 PKCE/state，并把参数交给 Rust 实际处理。

---

## 5. 数据格式详解

### 5.1 StreamTextRequest（前端 → 后端）

```ts
// src/services/llm/types.ts
type StreamTextRequest = {
  model: string;                                // "gpt-5.2-codex@openai"
  fallbackModels?: string[] | null;             // ["claude-3-5-sonnet@anthropic", …]
  messages: Message[];
  tools?: ToolDefinition[] | null;              // {type:'function',name,description,parameters,strict:true}
  stream?: boolean | null;                      // 默认 true
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  topK?: number | null;
  providerOptions?: ProviderOptions;            // 透传到 provider_options
  requestId?: string | null;                    // 前端生成 16 位
  traceContext?: TraceContext | null;           // 透传到 TraceWriter
  conversationMode?: 'stateless' | 'responses-chained' | null;
  inputMode?: 'full-history' | 'incremental' | null;
  previousResponseId?: string | null;           // OpenAI Responses 链式复用
  transportSessionId?: string | null;           // WS session id
  allowTransportFallback?: boolean | null;
  continuationContext?: ContinuationContext | null; // {iteration, baselineMessageCount, deltaMessageCount, fallbackCount}
  contextManagement?: ContextManagementConfig | null; // Anthropic cache_edits
};
```

Rust 侧对应的 `StreamTextRequest` 使用 `#[serde(rename_all = "camelCase")]` + `rename = "..."` 兼容 TS 的命名（详见 [types.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/types.rs)）。

### 5.2 Message

```ts
type Message =
  | { role: 'system'; content: string; providerOptions?: ProviderOptions }
  | { role: 'user'; content: MessageContent; providerOptions?: ProviderOptions }
  | { role: 'assistant'; content: MessageContent; providerOptions?: ProviderOptions }
  | { role: 'tool'; content: ContentPart[]; providerOptions?: ProviderOptions };

type MessageContent = string | ContentPart[];

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string }                    // url 或 base64
  | { type: 'video'; video: string; mimeType?: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; providerMetadata?: ProviderOptions }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'reasoning'; text: string; providerOptions?: ProviderOptions };
```

Rust 端用 `#[serde(tag = "role", rename_all = "lowercase")]` 序列化后仍是 `{"role":"user","content":...}`，与 OpenAI/Claude 通用消息格式基本一致，方便 `protocols/*` 复用映射函数。

### 5.3 StreamEvent（后端 → 前端）

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

关键点：

- 文本与 reasoning 分通道，方便 UI 区分主回答和思考内容
- `response-metadata` 用于 OpenAI Responses 链式复用：`responseId` + `transportSessionId` 在下一轮请求里回传
- `transport-fallback` 让前端能感知“WS 失败 → HTTP SSE 兜底”并更新 UI 提示
- `usage` 一次性在流末尾或中间 token 节点发出，供前端算成本（结合 `ModelPricing`）
- `raw` 用于调试直通（前端不消费）

### 5.4 ToolDefinition

```ts
type ToolDefinition = {
  type: 'function';
  name: string;
  description?: string | null;
  parameters: unknown;     // JSON Schema
  strict: true;
};
```

前端 `toOpenAIToolDefinition` 把项目内 `ToolWithUI` 转成这个 shape；不同 provider 的 `protocols/openai_protocol.rs` / `claude_protocol.rs` 会再映射成各家协议要求的 `tools` 字段。

### 5.5 ProviderConfig / AvailableModel

- `ProviderConfig`（TS） / `ProviderConfig`（Rust，camelCase via serde）：provider 元信息
- `AvailableModel`：模型目录页用，含 `key / name / provider / imageInput / imageOutput / audioInput / videoInput / inputPricing`
- `ModelConfig` / `ModelPricing`：定价、上下文长度、provider 路由表

### 5.6 Tauri 事件 Payload 协议

- 事件名：`llm-stream-<request_id>`（Rust 端 `format!("llm-stream-{}", request_id)`）
- Payload：`StreamEvent` 的序列化 JSON（与 `StreamEvent` TS 类型一一对应，但 `serde_json::Value` ↔ `camelCase` ↔ `snake_case` 通过 serde 自动处理）
- 终止约定：`done` 或 `error` 后 `LlmEventStream` 自动 `unlisten`，避免事件泄漏

---

## 6. 关键时序

### 6.1 一次普通对话流（简化）

```text
User  → ChatBox  → taskStore.appendMessage
     → executionService.run()
     → LLMService.runAgentLoop()
        ├─ resolveCachedMessages()    // 拿压缩过的旧消息 + 新增 delta
        ├─ planStreamTextRequest()    // 决定 stateless / responses-chained / incremental
        ├─ llmClient.streamText()
        │   ├─ listen('llm-stream-<id>')
        │   └─ invoke('llm_stream_text', { request })
        │       └─ Tauri 派发到 Rust 任务
        │           └─ StreamHandler::stream_completion
        │               ├─ resolve model/provider
        │               ├─ build request (Provider/Protocol)
        │               ├─ reqwest SSE / OpenAI WS
        │               └─ 持续 window.emit('llm-stream-<id>', StreamEvent)
        ├─ for await StreamEvent
        │   ├─ text-delta  → onChunk  → taskStore.update streamingContent
        │   ├─ tool-call   → ToolExecutor.execute
        │   ├─ reasoning-* → onReasoningUpdate
        │   ├─ usage       → onUsage
        │   └─ done/error  → 结束
        └─ 循环：tool result → messages.push → planStreamTextRequest 再调一次
     → onComplete(fullText)
```

### 6.2 OpenAI Responses 链式复用

- 首轮 `conversationMode=responses-chained` 命中
- 后端返回 `response-metadata { responseId, transportSessionId, continuationAccepted }`
- 后续轮次 `inputMode=incremental` + `previousResponseId=…` + `transportSessionId=…` 复用 server-side state
- WS 失败 → emit `transport-fallback` → 前端 `ResponsesChainManager` 标记 chain broken → 下一轮降级为 `stateless` 重新发全量

### 6.3 上下文压缩触发

- `loopState.lastRequestTokens > autoCompactThreshold(currentModel)`
- `performCompressionIfNeeded` 调 `ContextCompactor.compactMessages`
  - 优先尝试本地 session memory compaction（无需调 LLM）
  - 不足才走 `AISummarizationStrategy`（调 `llm_compact_context`）
- 压缩完成后 `CompactionManager.runAutoCompaction`：
  - 重建 `loopState.messages`
  - `saveCompactedMessages` 落盘到 `.talkcody/context/<taskId>/compacted-messages.json`
  - 同步写 `.talkcody/context/<taskId>/session-memory.json` 作为兜底
- 下次进入 loop 时 `resolveCachedMessages` 用压缩后的 messages 替换 base

---

## 7. 失败、重试、容错

| 场景 | 后端处理 | 前端处理 |
| --- | --- | --- |
| 401/403 鉴权失败 | 透传错误 + emit `StreamEvent::Error` | `LLMService` 标记 OAuth 失效并提示用户重新授权 |
| 429 限流 | 不在 Rust 中自动重试（依赖 `ai-context-compaction` 走 fallback） | 退避重试见 `stream-retry-orchestrator.ts` |
| 5xx / 503 过载 | `StreamRunner` transient retry `TRANSIENT_PROVIDER_RETRY_LIMIT` 次，指数退避；再换 fallback 模型 | `RunStream` 阶段错误走 `stream-retry-orchestrator` |
| 网络中断 / idle timeout | `tokio::time::timeout(stream_timeout, stream.next())` 触发 `StreamEvent::Error` | abort + 提示 |
| OpenAI Responses WS 握手失败 | emit `transport-fallback` 并切 HTTP SSE | UI 不感知，自动继续 |
| compaction 失败 | `CompactionManager` 走 `session-memory.json` sidecar 重建上下文 | 无感恢复 |
| 连续 3 次 compaction 失败 | circuit breaker 触发，跳过后续 compaction | 不再压上下文，由 LLMService 走 manual 限流 |
| AbortSignal 触发 | Rust 不感知 abort 协议（依赖 reqwest 关闭 connection） | `LlmClient.stop()` unlisten 并 `queue.finish()` |

---

## 8. 关键代码索引

| 主题 | 路径 |
| --- | --- |
| Tauri 流式命令入口 | `src-tauri/core/src/llm/commands.rs::llm_stream_text` |
| Stream 调度 | `src-tauri/core/src/llm/streaming/stream_handler.rs` |
| Fallback + Transient Retry | `src-tauri/core/src/llm/ai_services/stream_runner.rs` |
| OpenAI Responses WebSocket | `src-tauri/core/src/llm/streaming/openai_responses_ws.rs` |
| OpenAI 协议 | `src-tauri/core/src/llm/protocols/openai_protocol.rs` |
| OpenAI Responses 协议 | `src-tauri/core/src/llm/protocols/openai_responses_protocol.rs` |
| Claude 协议 | `src-tauri/core/src/llm/protocols/claude_protocol.rs` |
| Provider 注册表 | `src-tauri/core/src/llm/providers/provider_registry.rs` |
| Provider trait | `src-tauri/core/src/llm/providers/provider.rs` |
| 上下文压缩 | `src/services/context/context-compactor.ts` + `src-tauri/core/src/llm/ai_services/context_compaction_service.rs` |
| 压缩管理器 | `src/services/agents/compaction-manager.ts` |
| 前端 LLMClient | `src/services/llm/llm-client.ts` |
| 事件总线 | `src/services/llm/llm-event-stream.ts` |
| TS 类型 | `src/services/llm/types.ts` |
| Agent Loop | `src/services/agents/llm-service.ts::runAgentLoop` |
| 任务状态 | `src/stores/task-store.ts` |
| ChatBox | `src/components/chat-box.tsx` |
| OAuth 服务（TS 端） | `src/providers/oauth/*` |

---

## 9. 二次开发建议

1. **新增 Provider**：在 `provider_registry.rs::builtin_providers` 注册 `ProviderConfig`，并提供对应 `Provider` 实现（大多数情况下只需 `DefaultProvider` + `Protocol` 即可）。
2. **新增协议**：实现 `LlmProtocol` 三个 trait：`ProtocolHeaderBuilder`、`ProtocolRequestBuilder`、`ProtocolStreamParser`，再在 `Provider::build_complete_request` / `parse_stream_event_with_context` 里 dispatch。
3. **新增流事件类型**：在 `StreamEvent`（Rust）和 `types.ts`（TS）同时添加 case；前端用判别式联合自动收窄。
4. **修改压缩策略**：在 `ContextCompactor` / `AISummarizationStrategy` / `session-memory-compaction.ts` 之间调整，新策略需要同时定义 `CompressionStrategyType`、UI 状态、Prompts。
5. **注意命名兼容**：Rust 用 `serde` 别名保持与 TS camelCase 对齐，TS 端的 `normalizeStreamEvent` 负责把 `snake_case` 别名转回 camelCase。

---

## 11. 前端流式渲染 LLM 返回内容

本节回答“流式事件到了 React 后到底怎么变成 UI”，重点在 `MessageItem` 分发、`StreamProcessor` 状态机、工具专属渲染、计划/查询表单等富交互组件。

### 11.1 总体渲染管线

```
Tauri event  →  LlmEventStream.normalizeStreamEvent
            →  LLMService.runAgentLoop  →  StreamProcessor.processXxx()
            →  AgentLoopCallbacks (onChunk / onReasoningUpdate / onToolMessage)
            →  Zustand store (taskStore / streamingMessagesCache)
            →  React (MessageList → MessageItem → 专属工具组件)
```

调用方 [llm-service.ts](file:///Users/a1-6/project/talkcody/src/services/agents/llm-service.ts#L271-L290) 在拿到 `for await StreamEvent` 后按 `type` 派发：

- `text-start` → `streamProcessor.processTextStart` → `onAssistantMessageStart` → 标记 `isAnswering = true`
- `text-delta` → `processTextDelta` → `onChunk(text)` 拼接到当前助手消息的 `streamingContent`
- `reasoning-start` / `reasoning-delta` / `reasoning-end` → `processReasoning*` → `onReasoningUpdate({ reasoningContent, isStreaming })` 进入 `reasoningBlocks`
- `tool-call` → `processToolCall` → `onToolMessage({ role:'tool', content:[tool-call part] })` 进入 store
- `response-metadata` → 记录 `responseId / transportSessionId` 给下一轮 chain
- `usage` / `done` / `error` → 触发结算与清理

`StreamProcessor` 自身维护 [StreamProcessorState](file:///Users/a1-6/project/talkcody/src/services/agents/stream-processor.ts#L43-L65)：

- `isAnswering` / `hasReceivedText` 决定是否要新建 assistant 消息
- `contentOrder: Array<{ type: 'reasoning' | 'text', index }>` 用来在 `getAssistantContent()` 中按顺序拼回 content parts
- `reasoningBlocks: ReasoningBlock[]` 收集多个 reasoning 段，支持 `signature` / `redactedData` 等 provider metadata 的 deep merge
- `consecutiveToolErrors` 用于在连续工具失败时插入熔断提示
- `fullReset()` / `resetState()` 分别在新对话/新 iteration 时清理

### 11.2 MessageItem 派发逻辑

[message-item.tsx](file:///Users/a1-6/project/talkcody/src/components/chat/message-item.tsx) 是所有 UI 渲染的入口：

1. 先按 `message.role` 分流：
   - `user` → `UserCircle` 头像 + 文本/附件
   - `assistant` → `Bot` 头像 + 推理折叠区（`isReasoningStreaming` 自动展开，结束自动收起）+ Markdown 主体
   - `tool` → 进入第 2 步
2. 对 `role:'tool'`：
   - `message.content: ContentPart[]`，按 `item.type` 进一步分流
   - `item.type === 'tool-call'` → 走 `toolRenderers.renderToolDoing(input, { taskId })`
   - `item.type === 'tool-result'` → 走 `toolRenderers.renderToolResult(output, input)`
   - 没有注册渲染器 → 兜底走 [UnifiedToolResult](file:///Users/a1-6/project/talkcody/src/components/tools/unified-tool-result.tsx)（JSON 文本）
3. 对 `callAgent` 这种特殊工具，会把 `message.nestedTools` 过滤出 `parentToolCallId` 匹配的子消息，在“doing 卡片”下面再嵌一层。
4. 每个工具节点都被 [ToolErrorBoundary](file:///Users/a1-6/project/talkcody/src/components/tools/tool-error-boundary.tsx) 包住，单个工具崩溃不会让整条消息消失。

推理折叠区 [message-item.tsx](file:///Users/a1-6/project/talkcody/src/components/chat/message-item.tsx#L72-L100) 的策略：

- `useEffect` 监听 `message.isReasoningStreaming`
- 切换到新消息时按当前是否流式决定初始展开
- 流式期间保持展开，结束（`previousReasoningStreamingRef.current` 由 true → false）时自动收起
- 用户手动点开后不再自动合上

### 11.3 工具注册表：`tool-adapter.ts`

工具 → React 组件的绑定不在 `message-item` 里写死，而是走 [tool-adapter.ts](file:///Users/a1-6/project/talkcody/src/lib/tool-adapter.ts) 的全局 `Map`：

```ts
const toolUIRegistry = new Map<string, {
  renderToolDoing: (params, context) => ReactElement | null;
  renderToolResult: (result, params) => ReactElement | null;
}>();

registerToolUIRenderers(toolWithUI, keyName);
getToolUIRenderers(toolName) // 在 message-item 中调用
```

注册入口有两处：

- [lib/tools/index.ts](file:///Users/a1-6/project/talkcody/src/lib/tools/index.ts) `loadAllTools()` 启动时统一注册
- [services/agents/agent-registry.ts](file:///Users/a1-6/project/talkcody/src/services/agents/agent-registry.ts) 加载 agent 携带的工具时也注册一次

因此新增工具只要实现 `ToolWithUI` 接口（`renderToolDoing` / `renderToolResult`）并在 `TOOL_DEFINITIONS` 加一行即可，不需要改 `MessageItem`。

### 11.4 内置工具的渲染矩阵

下表列出常见工具的“doing 期间”UI 与“result 期间”UI 关键文件，完整组件都在 [components/tools/](file:///Users/a1-6/project/talkcody/src/components/tools) 下：

| 工具 | renderToolDoing | renderToolResult | 关键能力 |
| --- | --- | --- | --- |
| `bash` | [bash-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/bash-tool-doing.tsx) | [bash-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/bash-tool-result.tsx) | exit code、后台任务标识、长输出折叠、超时提示 |
| `writeFile` | [write-file-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/write-file-tool-doing.tsx) | [write-file-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/write-file-result.tsx) | 文件路径、权限申请、错误边界 |
| `editFile` | [edit-file-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/edit-file-tool-doing.tsx) | [edit-file-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/edit-file-result.tsx) | 内嵌 LCS diff 渲染，行级 added/removed 颜色 |
| `readFile` | [generic-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/generic-tool-doing.tsx) | [generic-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/generic-tool-result.tsx) | `renderDoingUI:false`，避免 UI 闪烁 |
| `listFiles` | [list-files-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/list-files-doing.tsx) | [list-files-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/list-files-result.tsx) | 树形结构、可点击行跳到文件编辑器 |
| `glob` | [glob-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/glob-doing.tsx) | [glob-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/glob-result.tsx) | 模式高亮、命中行数 |
| `codeSearch` / `webSearch` | [search-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/search-tool-doing.tsx) | [search-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/search-tool-result.tsx) | 分组展示、复制路径 |
| `webFetch` | 同名组件 | 同名组件 | URL 预览卡片、Markdown 摘要 |
| `askUserQuestions` | [ask-user-questions-ui.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/ask-user-questions-ui.tsx) | [ask-user-questions-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/ask-user-questions-result.tsx) | 多 Tab 表单，单/多选 + 文本说明 + 必填校验 |
| `exitPlanMode` | `renderToolDoing` 复用入口 | [plan-review-card.tsx](file:///Users/a1-6/project/talkcody/src/components/plan/plan-review-card.tsx) | 计划审阅/编辑/拒绝 + 反馈文本框 |
| `callAgent` | [call-agent-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/call-agent-tool-doing.tsx) | [call-agent-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/call-agent-tool-result.tsx) | 自动尝试加载 plan `.md` 文件并 Markdown 化 |
| `todoWrite` | [todo-write-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/todo-write-tool-doing.tsx) | [todo-write-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/todo-write-tool-result.tsx) | 当前步骤高亮，渲染 LLM 当前正在做哪一步 |
| `custom tools` | [custom-tool-doing.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/custom-tool-doing.tsx) | [custom-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/custom-tool-result.tsx) | 由用户在工具配置里提供 render 函数 |

`renderDoingUI: false` 的工具（read/glob/listFiles/codeSearch/getCurrentDateTime/todoWrite 等快操作）会直接渲染 result 卡片，避免“闪一下 doing 又闪到 result”的体验。

### 11.5 计划（Plan）数据渲染

Plan 有两层入口：

1. `exitPlanMode` 工具的 result 卡片：[plan-review-card.tsx](file:///Users/a1-6/project/talkcody/src/components/plan/plan-review-card.tsx)
   - 顶部 approve / reject / edit 按钮
   - `useEffect` 监听 `autoApprovePlan` 任务设置，自动点 approve
   - 编辑模式：把 plan 文本灌进 `Textarea`，approve 时把编辑后的版本回传
   - reject 时弹出反馈输入框，把用户反馈转成下一轮 `user` 消息
2. `callAgent` 工具的 result 卡片：[call-agent-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/call-agent-tool-result.tsx)
   - 用正则从输出文本里抽 `` `[.../plan.md]` `` 这样的路径
   - 用 `@tauri-apps/plugin-fs` 的 `readTextFile` 读取 plan 文件
   - 失败回退到原始 output；成功则用 `MyMarkdown` 渲染

Plan 模式开关在 [settings-store.ts](file:///Users/a1-6/project/talkcody/src/stores/settings-store.ts) `is_plan_mode_enabled`，并通过 [services/prompt/providers/env-provider.ts](file:///Users/a1-6/project/talkcody/src/services/prompt/providers/env-provider.ts) 以 `<plan_mode>TRUE/FALSE</plan_mode>` 形式注入系统提示。

### 11.6 命令（bash）执行数据渲染

[bash-tool-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/bash-tool-result.tsx) 同时承载“执行状态”和“执行结果”两类数据：

- `success / exitCode` 决定主体色（绿/红）
- `outputFilePath / errorFilePath` 用 i18n 文案提示“完整输出已落盘”
- `idleTimedOut / timedOut` → 后台任务卡片（带 PID）
- `output` 用等宽字体、保留换行、可滚动、可换行，避免长输出撑爆布局
- `error` 同样落入同一展示区，但与 `output` 互斥（由 `displayOutput = output || error || message` 决定）

### 11.7 文件改动数据渲染

文件改动走两条路径，最终汇总到 [file-changes-summary.tsx](file:///Users/a1-6/project/talkcody/src/components/chat/file-changes-summary.tsx)：

1. 实时 diff（单次 edit 之后）：[edit-file-result.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/edit-file-result.tsx) 内嵌 LCS diff 渲染（>2000 行自动降级为“过大”提示）
2. 全任务汇总：
   - `useFileChangesStore` 按 `taskId` 汇总 `fileChanges`
   - 同一文件多次改动时，按 `isInitialWrite ? write : edit` 合并，保留第一次 originalContent
   - 顶部展示新增/修改数量，支持 `git commit` 一键提交（[useGit](file:///Users/a1-6/project/talkcody/src/hooks/use-git.ts) 生成 AI 提交信息）
   - `worktree` 模式下还会展示 merge 进度和冲突文件

### 11.8 询问表单（askUserQuestions）渲染

[ask-user-questions-ui.tsx](file:///Users/a1-6/project/talkcody/src/components/tools/ask-user-questions-ui.tsx) 是 LLM 主动向用户发问的核心 UI：

- `questions: Question[]` 每个问题支持多 Tab：multiSelect 选项 + 文本补充
- `multiSelect: true` 时多选；`false` 时单选
- 每题支持自由文本（与 options 并存）
- `useUserQuestionStore.submitAnswers` 把答案打包成 `AskUserQuestionsOutput` 写回对话流
- `submitted` 状态切到“已提交”卡片，避免用户重复提交

LLM 侧入口在 [lib/tools/ask-user-questions-tool.tsx](file:///Users/a1-6/project/talkcody/src/lib/tools/ask-user-questions-tool.tsx)，由 LLM 工具调用触发。计划审阅卡片的 reject 反馈也是这套 store 在背后收集。

### 11.9 Markdown / 代码 / 图表渲染

[my-markdown.tsx](file:///Users/a1-6/project/talkcody/src/components/chat/my-markdown.tsx) 是所有 assistant 文本的最终去处：

- `react-markdown` + `remark-gfm` + `rehype-highlight` 解析 GitHub 风格 Markdown
- 代码块用 [code-block.tsx](file:///Users/a1-6/project/talkcody/src/components/chat/code-block.tsx) 渲染，支持复制/折叠
- `mermaid` 块（` ```mermaid `）调用 mermaid 在客户端渲染 SVG
- HTML 实体通过 `decodeObjectHtmlEntities` 解码
- 与 theme 联动：dark/light 模式自动切 highlight 主题

### 11.10 步骤事件（Agent steps）UI

[ai-elements/task.tsx](file:///Users/a1-6/project/talkcody/src/components/ai-elements/task.tsx) 用 `use-stick-to-bottom` 给整个聊天区一个“自动跟随最新消息”的滚动容器：

- `Task`：外层容器，监听滚动位置
- `TaskContent`：内部内容区
- `TaskScrollButton`：当用户向上滚动离开底部时出现，点一下回到最新

步骤状态本身在 [MessageList](file:///Users/a1-6/project/talkcody/src/components/chat/message-list.tsx) 里通过 `derivedMessages` 计算：

- 空消息（`isEmptyMessage`）会被跳过
- 已经完成工具调用的 tool-call（`completedToolCalls.has(toolCallId)`）会被合并 / 隐藏
- 标出每个 turn 的最后一个 assistant message（用于显示 `Regenerate` 按钮）

### 11.11 文件附件 / 图像 / 视频

`MessageAttachment` 在流式过程里由 `onAttachment` 回调注入：

- 图片：`<img>` + Tauri `convertFileSrc` 转成 `asset://`
- 视频：`<video>` + 控制条
- 文件：通用附件卡片，文件名 + 路径

这些组件都不在 `MessageItem` 主体内，而是 `attachments` 字段被消费后渲染，避免与 Markdown 主体冲突。

### 11.12 性能与一致性优化

- [StreamingMessagesCache](file:///Users/a1-6/project/talkcody/src/stores/task-store.ts) 把 base / derived / streaming 三层分开，避免每个 `text-delta` 都触发整列克隆
- [MessageItem](file:///Users/a1-6/project/talkcody/src/components/chat/message-item.tsx) 用 `memo` + `useMemo` 包裹工具节点渲染
- `computedDerivedMessages` 在 `MessageList` 顶部一次完成所有去重/过滤，再下发渲染
- 流式期间 `use-stick-to-bottom` 抑制用户主动滚动冲突

---

## 12. LLM 返回给前端的数据结构定义

本节是流式事件 + 消息结构的“字段级”参考，所有内容以 Rust 端 [types.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/types.rs) 为权威源，TS 端 [types.ts](file:///Users/a1-6/project/talkcody/src/services/llm/types.ts) 保持字段一一对应。

### 12.1 命名约定：snake_case ↔ camelCase 兼容

Rust 端用 `#[serde(rename_all = "kebab-case")]` / `#[serde(rename = "...")]` 把枚举值和字段名转换到与 TS 端 `camelCase` 完全兼容的形式：

- 枚举值走 `kebab-case`：`responses-chained` / `http-sse` / `websocket` / `openai-subscription` / `fresh-websocket-baseline`
- 字段名走 `camelCase`：`requestId` ↔ `request_id`、`toolCallId` ↔ `tool_call_id`、`finishReason` ↔ `finish_reason`、`inputTokens` ↔ `input_tokens`、`cachedInputTokens` ↔ `cached_input_tokens`
- `ProviderOptions` 这种半自由对象统一用 `serde_json::Value` ↔ `unknown` 对应，前端拿到的是 `Record<string, unknown> | null`

这套约定让 Rust 侧可以直接 `window.emit("llm-stream-<id>", event)`，前端 `normalizeStreamEvent` 只剩极个别历史别名需要归一。

### 12.2 顶层流式信封

```ts
// 来自 src/services/llm/llm-client.ts
type StreamResponse = { request_id: string };

// 事件 payload: StreamEvent (联合类型)
```

- `StreamResponse` 是 `invoke<StreamResponse>('llm_stream_text', { request })` 的返回值，只有一个 `requestId`
- 真正的流式 payload 在 Tauri 事件 `llm-stream-<requestId>` 中以 `StreamEvent` 形式连续推送
- 终止事件：`done` 或 `error`，`LlmEventStream` 会自动 `unlisten`

### 12.3 StreamEvent 联合类型（后端 → 前端）

来源：[types.ts](file:///Users/a1-6/project/talkcody/src/services/llm/types.ts) `StreamEvent`，与 Rust [types.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/types.rs) `StreamEvent` 字段一一对应。

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

逐项字段说明：

| type | 必填字段 | 可选字段 | 含义 / 何时触发 |
| --- | --- | --- | --- |
| `text-start` | — | — | 标记 assistant 文本通道开始，触发新建 assistant 消息 |
| `text-delta` | `text` | — | 一段文本增量。`MessageItem` 通过 `onChunk` 拼到 `streamingContent` |
| `tool-call` | `toolCallId`, `toolName`, `input` | `providerMetadata` | 一次工具调用。`input` 是 `Record<string, unknown>`，可包含文件路径、命令、问题等 |
| `reasoning-start` | `id` | `providerMetadata` | 推理通道开始。`id` 是 provider 给的 block id，用于 `reasoning-end` 收尾 |
| `reasoning-delta` | `id`, `text` | `providerMetadata` | 推理文本增量。`providerMetadata` 可带 Claude 的 `signature`、Anthropic 的 `redactedData` 等 |
| `reasoning-end` | `id` | — | 推理通道结束 |
| `response-metadata` | `responseId`, `transport`, `provider` | `continuationAccepted`, `transportSessionId` | OpenAI Responses 链式复用时给出。下一轮请求要回传 `previousResponseId` / `transportSessionId` |
| `transport-fallback` | `reason`, `from`, `to` | — | WS 失败切 HTTP SSE / chain 失败切 stateless。前端用于给用户提示和调整下一轮 `conversationMode` |
| `usage` | `input_tokens`, `output_tokens` | `total_tokens`, `cached_input_tokens`, `cache_creation_input_tokens` | 一次性发送的用量与缓存命中。`total_tokens` 可能为 `null` 时由前端 `input+output` 算 |
| `done` | — | `finish_reason` | 流结束。`finish_reason` 取 `stop` / `tool_calls` / `length` / `max_tokens` / `end_turn` |
| `error` | `message` | `name` | 错误终止。`message` 是可读信息，前端用 `toast.error` 提示 |
| `raw` | `raw_value` | — | 调试直通。原始 SSE 字符串，前端不消费，仅做穿透 |

`providerMetadata` 的常见形态（来自 Anthropic / OpenAI Responses）：

- `signature`：Claude 的 reasoning 签名，必须在历史 assistant 消息中保留
- `redactedData`：Claude 加密的思考段，需要在历史的 `reasoning` part 中保留
- `openaiCompatible.reasoning_content`：OpenAI 兼容 provider（如 DeepSeek / Moonshot）的 `reasoning_content` 字段
- `openai.safety`：OpenAI 的安全评分

### 12.4 Message 与 ContentPart（前后端共用）

来源：[types.ts](file:///Users/a1-6/project/talkcody/src/services/llm/types.ts) `Message` / `ContentPart`，与 Rust [types.rs](file:///Users/a1-6/project/talkcody/src-tauri/core/src/llm/types.rs) `Message` / `ContentPart` 对齐。

```ts
type Message =
  | { role: 'system'; content: string; providerOptions?: ProviderOptions }
  | { role: 'user'; content: MessageContent; providerOptions?: ProviderOptions }
  | { role: 'assistant'; content: MessageContent; providerOptions?: ProviderOptions }
  | { role: 'tool'; content: ContentPart[]; providerOptions?: ProviderOptions };

type MessageContent = string | ContentPart[];

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string }                              // url 或 base64
  | { type: 'video'; video: string; mimeType?: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; providerMetadata?: ProviderOptions }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'reasoning'; text: string; providerOptions?: ProviderOptions };
```

字段逐项说明：

- `role: 'system'`：`content` 必须是字符串，存放系统提示词
- `role: 'user'` / `'assistant'`：`content` 既可以是字符串（简单场景），也可以是 `ContentPart[]`（多模态/工具/推理混合）
- `role: 'tool'`：`content` 必须是 `ContentPart[]`，每个 part 是 `tool-call` 或 `tool-result`
- `providerOptions`：每条消息都允许携带 provider 私有参数，例如 `openaiCompatible.reasoning_content`、`anthropic.thinking.signature` 等

`ContentPart` 类型说明：

- `text`：纯文本
- `image`：`image` 字段是 URL 或 base64 字符串；OpenAI 走 `image_url`、Claude 走 `image` block
- `video`：URL 或 base64 字符串，可选 `mimeType`（默认由前端推断）
- `tool-call`：调用声明。`input` 在 Rust 端是 `serde_json::Value`，在前端是 `unknown`，保持灵活
- `tool-result`：调用结果。`output` 是 `unknown`，实际形态由各工具 schema 决定（文本、JSON、图像 base64 等）
- `reasoning`：Claude / OpenAI / DeepSeek 的 `reasoning_content`、Anthropic 的 `thinking` 文本

### 12.5 StreamTextRequest（前端 → 后端）

```ts
type StreamTextRequest = {
  model: string;                                  // 形如 "gpt-5.2-codex@openai"
  fallbackModels?: string[] | null;               // 串行 fallback 模型列表
  messages: Message[];                            // 见 12.4
  tools?: ToolDefinition[] | null;                // 工具定义
  stream?: boolean | null;                        // 默认 true
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  topK?: number | null;
  providerOptions?: ProviderOptions;              // provider 私有透传
  requestId?: string | null;                      // 前端生成 16 位
  traceContext?: TraceContext | null;             // 透传到 TraceWriter
  conversationMode?: 'stateless' | 'responses-chained' | null;
  inputMode?: 'full-history' | 'incremental' | null;
  previousResponseId?: string | null;             // OpenAI Responses 链式
  transportSessionId?: string | null;             // WS session id
  allowTransportFallback?: boolean | null;        // WS 失败时是否允许降级
  continuationContext?: ContinuationContext | null; // 增量上下文
  contextManagement?: ContextManagementConfig | null; // Anthropic cache_edits
};
```

关键子结构：

```ts
type ContinuationContext = {
  iteration: number;              // 同一个 loopState 的迭代计数
  baselineMessageCount: number;   // 上次压缩后的消息数
  deltaMessageCount: number;      // 之后新增的消息数
  fallbackCount: number;          // 已发生的 fallback 次数
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
  name: string;                  // 如 "bash" / "readFile" / "exitPlanMode"
  description?: string | null;
  parameters: unknown;           // JSON Schema
  strict: true;
};
```

- 工具定义由前端 `toOpenAIToolDefinition(name, description, inputSchema, opts)` 统一转成这种形态
- Rust 侧 `protocols/openai_protocol.rs` 和 `protocols/claude_protocol.rs` 再把它映射成各家 `tools` 字段
- `strict: true` 表示走 OpenAI 的严格 JSON Schema 模式

### 12.7 一次性 AI 服务响应

这些是 `invoke<...>('llm_xxx', { request })` 的请求/响应形态（不是 stream 事件）：

```ts
// 音频转写
type TranscriptionRequest = {
  model: string; audioBase64: string; mimeType: string;
  language?: string | null; prompt?: string | null;
  temperature?: number | null; responseFormat?: string | null;
};
type TranscriptionResponse = { text: string; language?: string | null; duration?: number | null };

// 图像生成
type ImageGenerationRequest = {
  model: string; prompt: string;
  size?: string | null; quality?: string | null; n?: number | null;
  responseFormat?: string | null;
  providerOptions?: ProviderOptions; requestId?: string | null;
};
type GeneratedImage = { b64Json?: string | null; url?: string | null; mimeType: string; revisedPrompt?: string | null };
type ImageGenerationResponse = { provider: string; images: GeneratedImage[]; requestId?: string | null };

// 图像下载
type ImageDownloadRequest = { url: string };
type ImageDownloadResponse = { data: number[]; mimeType: string };

// 编辑器内联补全
type CompletionContext = { fileContent: string; cursorPosition: number; fileName: string; language: string; model?: string | null };
type CompletionRange = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
type CompletionResult = { completion: string; range?: CompletionRange | null };

// Git commit 信息生成
type GitMessageContext = { userInput?: string | null; diffText: string; model?: string | null; fallbackModels?: string[] | null; language?: string | null };
type GitMessageResult = { message: string; suggestions?: string[] | null };

// 任务标题生成
type TitleGenerationRequest = { userInput: string; language?: string | null; model?: string | null; fallbackModels?: string[] | null };
type TitleGenerationResult = { title: string };

// 上下文压缩（一次性 invoke）
type ContextCompactionRequest = { conversationHistory: string; model?: string | null; fallbackModels?: string[] | null };
type ContextCompactionResult = { compressedSummary: string };

// 提示词增强
type PromptEnhancementRequest = { originalPrompt: string; projectPath?: string | null; conversationHistory?: string | null; enableContextExtraction: boolean; model?: string | null };
type PromptEnhancementResult = { enhancedPrompt: string; extractedKeywords: string[]; generatedQueries: string[]; contextSnippetCount: number };

// 用量与计费
type TokenUsage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number | null; cacheCreationInputTokens?: number | null };
type CalculateCostRequest = { modelId: string; usage: TokenUsage; modelConfigs: Record<string, ModelConfig> };
type CalculateCostResult = { cost: number };
```

### 12.8 Provider / Model 元数据

```ts
type ProviderConfig = {
  id: string;                    // "openai" / "anthropic" / "github-copilot" / "talkcody" ...
  name: string;                  // 显示名
  baseUrl: string;
  apiKeyName: string;            // 指向 ApiKeyManager 的 key 名
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

### 12.9 事件 payload 收尾约定

- 后端每个 `StreamEvent` 都通过 `window.emit("llm-stream-<id>", event)` 推送
- 终止事件一定是 `done` 或 `error` 之一。`done` 不带 `usage` 时，前端按需从 `usage` 事件补取
- `error` 之后不再发任何事件；`done` 之后允许再发一个 usage 之后再结束
- 前端 `LlmEventStream` 把 `snake_case` 字段（如 `response_id`）归一为 `responseId` 等 camelCase 别名，保持与 TS 类型一致

### 12.10 字段命名兼容对照表（Rust ↔ TS）

| Rust 字段 | JSON 字段 | TS 字段 |
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

## 10. 一句话总结

> TalkCody 的 LLM 链路本质上是 “**Tauri 客户端用 `invoke + 事件` 把 Rust 后端当成可发流式响应的 OpenAI-compatible 网关**”，前端只负责 UI 与状态，Rust 负责协议、鉴权、重试、压缩、副作用执行；`StreamTextRequest` / `StreamEvent` 是贯穿这条链路的唯一“协议合同”。
