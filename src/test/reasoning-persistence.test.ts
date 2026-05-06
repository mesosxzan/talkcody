import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamProcessor } from '@/services/agents/stream-processor';

describe('StreamProcessor reasoning persistence', () => {
  let processor: StreamProcessor;
  let chunks: string[];
  let reasoningUpdates: Array<{ reasoningContent: string; isStreaming: boolean }>;

  beforeEach(() => {
    processor = new StreamProcessor();
    chunks = [];
    reasoningUpdates = [];
  });

  const createCallbacks = () => ({
    onChunk: (chunk: string) => {
      chunks.push(chunk);
    },
    onStatus: vi.fn(),
    onAssistantMessageStart: vi.fn(),
    onReasoningUpdate: (payload: { reasoningContent: string; isStreaming: boolean }) => {
      reasoningUpdates.push(payload);
    },
  });

  it('stores reasoning separately from streamed assistant text', () => {
    const callbacks = createCallbacks();

    processor.processReasoningDelta(
      'reason-1',
      'I need to think about this carefully.',
      undefined,
      { suppressReasoning: false },
      callbacks
    );

    expect(processor.getFullText()).toBe('');
    expect(processor.getCurrentStepText()).toBe('');
    expect(processor.getCurrentReasoningText()).toBe('I need to think about this carefully.');
    expect(chunks).toEqual([]);
    expect(reasoningUpdates).toEqual([
      {
        reasoningContent: 'I need to think about this carefully.',
        isStreaming: true,
      },
    ]);
  });

  it('preserves answer text across resetState while clearing live reasoning for the next iteration', () => {
    const callbacks = createCallbacks();

    processor.processTextDelta('First iteration answer.', callbacks);
    processor.processReasoningDelta(
      'reason-1',
      'Temporary reasoning',
      undefined,
      { suppressReasoning: false },
      callbacks
    );

    expect(processor.getFullText()).toBe('First iteration answer.');
    expect(processor.getCurrentReasoningText()).toBe('Temporary reasoning');

    processor.resetState();

    expect(processor.getFullText()).toBe('First iteration answer.');
    expect(processor.getCurrentStepText()).toBe('');
    expect(processor.getCurrentReasoningText()).toBe('');

    processor.processReasoningDelta(
      'reason-2',
      'Second iteration reasoning',
      undefined,
      { suppressReasoning: false },
      callbacks
    );

    expect(processor.getFullText()).toBe('First iteration answer.');
    expect(processor.getCurrentReasoningText()).toBe('Second iteration reasoning');
  });

  it('keeps suppressed reasoning out of UI updates while preserving assistant content for providers', () => {
    const callbacks = createCallbacks();

    processor.processReasoningDelta(
      'reason-1',
      'Suppressed reasoning',
      undefined,
      { suppressReasoning: true },
      callbacks
    );

    expect(processor.getFullText()).toBe('');
    expect(chunks).toEqual([]);
    expect(reasoningUpdates).toEqual([]);

    const assistantContent = processor.getAssistantContent();
    expect(assistantContent).toEqual([
      {
        type: 'reasoning',
        text: 'Suppressed reasoning',
      },
    ]);
  });

  it('emits a finished reasoning update when reasoning-end arrives', () => {
    const callbacks = createCallbacks();

    processor.processReasoningDelta(
      'reason-1',
      'Finished reasoning block',
      undefined,
      { suppressReasoning: false },
      callbacks
    );
    processor.processReasoningEnd('reason-1', callbacks);

    expect(reasoningUpdates).toEqual([
      {
        reasoningContent: 'Finished reasoning block',
        isStreaming: true,
      },
      {
        reasoningContent: 'Finished reasoning block',
        isStreaming: false,
      },
    ]);
  });
});
