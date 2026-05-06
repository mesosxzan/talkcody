import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamProcessor } from '@/services/agents/stream-processor';

describe('StreamProcessor multi-iteration behavior', () => {
  let processor: StreamProcessor;
  let onAssistantMessageStartCalls: number;
  let onChunkCalls: string[];
  let reasoningUpdates: Array<{ reasoningContent: string; isStreaming: boolean }>;

  beforeEach(() => {
    processor = new StreamProcessor();
    onAssistantMessageStartCalls = 0;
    onChunkCalls = [];
    reasoningUpdates = [];
  });

  const createCallbacks = () => ({
    onChunk: (chunk: string) => {
      onChunkCalls.push(chunk);
    },
    onStatus: vi.fn(),
    onAssistantMessageStart: () => {
      onAssistantMessageStartCalls++;
    },
    onReasoningUpdate: (payload: { reasoningContent: string; isStreaming: boolean }) => {
      reasoningUpdates.push(payload);
    },
  });

  it('calls onAssistantMessageStart for each text iteration after resetState()', () => {
    const callbacks = createCallbacks();

    processor.processTextStart(callbacks);
    processor.processTextDelta('AAAA', callbacks);
    expect(onAssistantMessageStartCalls).toBe(1);
    expect(processor.getCurrentStepText()).toBe('AAAA');

    processor.resetState();

    processor.processTextStart(callbacks);
    processor.processTextDelta('BBBB', callbacks);
    expect(onAssistantMessageStartCalls).toBe(2);
    expect(processor.getCurrentStepText()).toBe('BBBB');
    expect(onChunkCalls).toEqual(['AAAA', 'BBBB']);
  });

  it('starts an assistant message for reasoning-only output without sending answer chunks', () => {
    const callbacks = createCallbacks();

    processor.processReasoningDelta(
      'reason-1',
      'Thinking about the problem...',
      undefined,
      { suppressReasoning: false },
      callbacks
    );

    expect(onAssistantMessageStartCalls).toBe(1);
    expect(onChunkCalls).toEqual([]);
    expect(reasoningUpdates).toEqual([
      {
        reasoningContent: 'Thinking about the problem...',
        isStreaming: true,
      },
    ]);
  });

  it('does not start or update visible reasoning when reasoning is suppressed', () => {
    const callbacks = createCallbacks();

    processor.processReasoningDelta(
      'reason-1',
      'Thinking about the problem...',
      undefined,
      { suppressReasoning: true },
      callbacks
    );

    expect(onAssistantMessageStartCalls).toBe(0);
    expect(onChunkCalls).toEqual([]);
    expect(reasoningUpdates).toEqual([]);
  });

  it('keeps reasoning updates separate from answer chunks in mixed responses', () => {
    const callbacks = createCallbacks();

    processor.processReasoningDelta(
      'reason-1',
      'Analyzing...',
      undefined,
      { suppressReasoning: false },
      callbacks
    );
    processor.processReasoningDelta(
      'reason-1',
      'Considering options...',
      undefined,
      { suppressReasoning: false },
      callbacks
    );
    processor.processReasoningEnd('reason-1', callbacks);
    processor.processTextDelta('Here is my answer', callbacks);

    expect(onAssistantMessageStartCalls).toBe(1);
    expect(onChunkCalls).toEqual(['Here is my answer']);
    expect(reasoningUpdates).toEqual([
      {
        reasoningContent: 'Analyzing...',
        isStreaming: true,
      },
      {
        reasoningContent: 'Analyzing...Considering options...',
        isStreaming: true,
      },
      {
        reasoningContent: 'Analyzing...Considering options...',
        isStreaming: false,
      },
    ]);
  });
});
