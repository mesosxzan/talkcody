import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock, unlistenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  unlistenMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

let eventHandler: ((event: { payload: unknown }) => void) | undefined;

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock.mockImplementation(async (_eventName, handler) => {
    eventHandler = handler;
    return unlistenMock;
  }),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { RustRuntimeAdapter } from './rust-runtime-adapter';

describe('RustRuntimeAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandler = undefined;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'runtime_start_task') {
        return 'runtime-task-1';
      }
      if (command === 'runtime_send_action') {
        return args;
      }
      if (command === 'runtime_cancel_task') {
        return undefined;
      }
      return null;
    });
  });

  it('listens on a session-scoped channel and completes from streamed events', async () => {
    const adapter = new RustRuntimeAdapter();
    const onAssistantMessageStart = vi.fn();
    const onChunk = vi.fn();
    const onComplete = vi.fn();

    const startPromise = adapter.start(
      {
        sessionId: 'task-1',
        initialMessage: 'hello',
      },
      {
        onAssistantMessageStart,
        onChunk,
        onComplete,
      },
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(listenMock).toHaveBeenCalledWith('runtime-event:task-1', expect.any(Function));

    eventHandler?.({
      payload: {
        type: 'messageCreated',
        sessionId: 'task-1',
        message: {
          id: 'msg-1',
          sessionId: 'task-1',
          role: 'assistant',
          content: { type: 'text', text: '' },
          createdAt: Date.now(),
        },
      },
    });
    eventHandler?.({
      payload: {
        type: 'token',
        sessionId: 'task-1',
        taskId: 'runtime-task-1',
        token: 'world',
      },
    });
    eventHandler?.({
      payload: {
        type: 'taskCompleted',
        sessionId: 'task-1',
        taskId: 'runtime-task-1',
      },
    });

    await startPromise;

    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith('world');
    expect(onComplete).toHaveBeenCalledWith('world');
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });

  it('serializes TaskAction payloads in the Rust enum shape', async () => {
    const adapter = new RustRuntimeAdapter();

    const startPromise = adapter.start(
      {
        sessionId: 'task-1',
        initialMessage: 'hello',
      },
      {
        onChunk: vi.fn(),
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    invokeMock.mockClear();

    await adapter.sendAction({ type: 'approve', toolCallId: 'tool-1' });
    expect(invokeMock).toHaveBeenLastCalledWith('runtime_send_action', {
      taskId: 'runtime-task-1',
      action: { approve: { toolCallId: 'tool-1' } },
    });

    await adapter.sendAction({ type: 'reject', toolCallId: 'tool-2', reason: 'deny' });
    expect(invokeMock).toHaveBeenLastCalledWith('runtime_send_action', {
      taskId: 'runtime-task-1',
      action: { reject: { toolCallId: 'tool-2', reason: 'deny' } },
    });

    await adapter.sendAction({ type: 'toolResult', toolCallId: 'tool-3', result: { ok: true } });
    expect(invokeMock).toHaveBeenLastCalledWith('runtime_send_action', {
      taskId: 'runtime-task-1',
      action: { toolResult: { toolCallId: 'tool-3', result: { ok: true } } },
    });

    await adapter.sendAction({ type: 'cancel' });
    expect(invokeMock).toHaveBeenLastCalledWith('runtime_send_action', {
      taskId: 'runtime-task-1',
      action: 'cancel',
    });

    eventHandler?.({
      payload: {
        type: 'taskCompleted',
        sessionId: 'task-1',
        taskId: 'runtime-task-1',
      },
    });

    await startPromise;
  });

  it('maps tool messages from MessageCreated with renderDoingUI, parent ids, and attachments', async () => {
    const adapter = new RustRuntimeAdapter();
    const onToolMessage = vi.fn();

    const startPromise = adapter.start(
      {
        sessionId: 'task-1',
        initialMessage: 'hello',
      },
      {
        onChunk: vi.fn(),
        onToolMessage,
      },
    );

    await Promise.resolve();
    await Promise.resolve();

    eventHandler?.({
      payload: {
        type: 'messageCreated',
        sessionId: 'task-1',
        message: {
          id: 'assistant-tool-calls',
          sessionId: 'task-1',
          role: 'assistant',
          content: {
            type: 'tool_calls',
            calls: [{ id: 'tool-1', name: 'bash', input: { command: 'pwd' } }],
          },
          createdAt: Date.now(),
          parentId: 'parent-tool',
        },
      },
    });
    eventHandler?.({
      payload: {
        type: 'messageCreated',
        sessionId: 'task-1',
        message: {
          id: 'tool-result-msg',
          sessionId: 'task-1',
          role: 'tool',
          content: {
            type: 'tool_result',
            result: {
              toolCallId: 'tool-1',
              toolName: 'bash',
              input: { command: 'pwd' },
              output: {
                stdout: '/repo',
                attachments: [
                  {
                    id: 'attach-1',
                    type: 'file',
                    filename: 'out.txt',
                    filePath: '/tmp/out.txt',
                    mimeType: 'text/plain',
                    size: 12,
                  },
                ],
              },
            },
          },
          createdAt: Date.now(),
          parentId: 'parent-tool',
        },
      },
    });
    eventHandler?.({
      payload: {
        type: 'toolCallCompleted',
        sessionId: 'task-1',
        taskId: 'runtime-task-1',
        result: {
          toolCallId: 'tool-1',
          name: 'bash',
          success: true,
          output: { stdout: '/repo' },
        },
      },
    });
    eventHandler?.({
      payload: {
        type: 'taskCompleted',
        sessionId: 'task-1',
        taskId: 'runtime-task-1',
      },
    });

    await startPromise;

    expect(onToolMessage).toHaveBeenCalledTimes(2);
    expect(onToolMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: 'tool-1',
        toolCallId: 'tool-1',
        toolName: 'bash',
        parentToolCallId: 'parent-tool',
        renderDoingUI: true,
      }),
    );
    expect(onToolMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'tool-1-result',
        toolCallId: 'tool-1',
        toolName: 'bash',
        parentToolCallId: 'parent-tool',
        attachments: [
          expect.objectContaining({
            id: 'attach-1',
            filename: 'out.txt',
          }),
        ],
      }),
    );
  });

  it('forwards usage events with context threshold metadata', async () => {
    const adapter = new RustRuntimeAdapter();
    const onUsage = vi.fn();

    const startPromise = adapter.start(
      {
        sessionId: 'task-1',
        initialMessage: 'hello',
      },
      {
        onChunk: vi.fn(),
        onUsage,
      },
    );

    await Promise.resolve();
    await Promise.resolve();

    eventHandler?.({
      payload: {
        type: 'usage',
        sessionId: 'task-1',
        taskId: 'runtime-task-1',
        inputTokens: 1200,
        outputTokens: 400,
        totalTokens: 32000,
        contextUsage: 25,
        contextPercentLeft: 63,
        isAboveWarningThreshold: false,
        isAboveErrorThreshold: false,
        isAboveAutoCompactThreshold: false,
        isAtBlockingLimit: false,
      },
    });
    eventHandler?.({
      payload: {
        type: 'taskCompleted',
        sessionId: 'task-1',
        taskId: 'runtime-task-1',
      },
    });

    await startPromise;

    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 1200,
      outputTokens: 400,
      totalTokens: 32000,
      contextUsage: 25,
      contextPercentLeft: 63,
      isAboveWarningThreshold: false,
      isAboveErrorThreshold: false,
      isAboveAutoCompactThreshold: false,
      isAtBlockingLimit: false,
    });
  });
});
