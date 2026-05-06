import { beforeEach, describe, expect, it } from 'vitest';
import { StreamProcessor } from '../services/agents/stream-processor';

type MessageState = {
  role: string;
  content: string;
  reasoningContent: string;
  isStreaming: boolean;
  isReasoningStreaming: boolean;
};

describe('Reasoning Display Integration', () => {
  let processor: StreamProcessor;
  let messages: MessageState[];
  let currentMessageIndex: number;

  const createNewMessage = () => {
    const messageId = messages.length;
    messages.push({
      role: 'assistant',
      content: '',
      reasoningContent: '',
      isStreaming: true,
      isReasoningStreaming: false,
    });
    currentMessageIndex = messageId;
  };

  const updateMessage = (
    updates: Partial<Pick<MessageState, 'content' | 'reasoningContent' | 'isStreaming' | 'isReasoningStreaming'>>
  ) => {
    const currentMessage = messages[currentMessageIndex];
    if (!currentMessage) {
      return;
    }

    messages[currentMessageIndex] = {
      ...currentMessage,
      ...updates,
    };
  };

  beforeEach(() => {
    processor = new StreamProcessor();
    messages = [];
    currentMessageIndex = -1;
  });

  it('keeps reasoning separate from assistant answer content', () => {
    const chunks: string[] = [];
    const reasoningUpdates: Array<{ reasoningContent: string; isStreaming: boolean }> = [];

    processor.processReasoningDelta(
      'reason-1',
      'I need to analyze the user query first.',
      undefined,
      { suppressReasoning: false },
      {
        onAssistantMessageStart: createNewMessage,
        onChunk: (chunk: string) => {
          chunks.push(chunk);
          updateMessage({ content: `${messages[currentMessageIndex]?.content ?? ''}${chunk}` });
        },
        onReasoningUpdate: (payload) => {
          reasoningUpdates.push(payload);
          updateMessage({
            reasoningContent: payload.reasoningContent,
            isReasoningStreaming: payload.isStreaming,
          });
        },
      }
    );

    processor.processReasoningEnd('reason-1', {
      onChunk: () => {},
      onReasoningUpdate: (payload) => {
        reasoningUpdates.push(payload);
        updateMessage({
          reasoningContent: payload.reasoningContent,
          isReasoningStreaming: payload.isStreaming,
        });
      },
    });

    processor.processTextDelta('Here is the answer.', {
      onChunk: (chunk: string) => {
        chunks.push(chunk);
        updateMessage({ content: `${messages[currentMessageIndex]?.content ?? ''}${chunk}` });
      },
      onAssistantMessageStart: createNewMessage,
    });

    updateMessage({ isStreaming: false });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      content: 'Here is the answer.',
      reasoningContent: 'I need to analyze the user query first.',
      isReasoningStreaming: false,
    });
    expect(chunks).toEqual(['Here is the answer.']);
    expect(reasoningUpdates).toEqual([
      {
        reasoningContent: 'I need to analyze the user query first.',
        isStreaming: true,
      },
      {
        reasoningContent: 'I need to analyze the user query first.',
        isStreaming: false,
      },
    ]);
  });

  it('does not leak prior iteration reasoning into the next assistant message', () => {
    processor.processReasoningDelta(
      'reason-1',
      'I should search for information first.',
      undefined,
      { suppressReasoning: false },
      {
        onAssistantMessageStart: createNewMessage,
        onChunk: () => {},
        onReasoningUpdate: (payload) => {
          updateMessage({
            reasoningContent: payload.reasoningContent,
            isReasoningStreaming: payload.isStreaming,
          });
        },
      }
    );

    processor.processReasoningEnd('reason-1', {
      onChunk: () => {},
      onReasoningUpdate: (payload) => {
        updateMessage({
          reasoningContent: payload.reasoningContent,
          isReasoningStreaming: payload.isStreaming,
        });
      },
    });

    updateMessage({ isStreaming: false });

    processor.resetState();

    processor.processTextDelta('Based on the search results, here is the answer.', {
      onAssistantMessageStart: createNewMessage,
      onChunk: (chunk: string) => {
        updateMessage({ content: `${messages[currentMessageIndex]?.content ?? ''}${chunk}` });
      },
    });

    updateMessage({ isStreaming: false });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      content: '',
      reasoningContent: 'I should search for information first.',
      isReasoningStreaming: false,
    });
    expect(messages[1]).toMatchObject({
      content: 'Based on the search results, here is the answer.',
      reasoningContent: '',
      isReasoningStreaming: false,
    });
  });
});
