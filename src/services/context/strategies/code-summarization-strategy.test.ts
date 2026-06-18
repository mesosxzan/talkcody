import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message as ModelMessage } from '@/services/llm/types';
import type { ContextAnalysis, StrategyContext } from '@/types/agent';

vi.mock('@/services/code-navigation-service', () => ({
  estimateTokens: vi.fn().mockReturnValue(100),
}));

vi.mock('@/services/context/context-rewriter', () => {
  return {
    ContextRewriter: class {
      rewriteMessages = vi.fn((msgs: ModelMessage[]) => Promise.resolve(msgs.slice(0, -1)));
    },
  };
});

import { CodeSummarizationStrategy } from './code-summarization-strategy';

function makeUserMessage(text: string): ModelMessage {
  return { role: 'user', content: text };
}

function makeContext(overrides: Partial<ContextAnalysis> = {}): StrategyContext {
  const analysis: ContextAnalysis = {
    totalMessages: 5,
    totalTokens: 1000,
    toolCallCount: 1,
    conversationCount: 2,
    codeBlockCount: 2,
    duplicateToolCallCount: 0,
    messageTypes: { toolCalls: 0.2, conversation: 0.4, codeBlocks: 0.4 },
    explorationChains: [],
    ...overrides,
  };
  return {
    messages: [makeUserMessage('hello'), makeUserMessage('world')],
    targetTokenBudget: 500,
    preserveRecentCount: 1,
    compressionModel: 'test-model',
    analysis,
  };
}

describe('CodeSummarizationStrategy', () => {
  let strategy: CodeSummarizationStrategy;

  beforeEach(() => {
    strategy = new CodeSummarizationStrategy();
  });

  it('should have correct type and cost', () => {
    expect(strategy.type).toBe('code_summarization');
    expect(strategy.cost).toBe('low');
    expect(strategy.quality).toBe('medium');
  });

  it('should be applicable when code blocks exist', () => {
    const context = makeContext({ codeBlockCount: 2 });
    expect(strategy.isApplicable(context)).toBe(true);
  });

  it('should be applicable when codeBlocks ratio is high', () => {
    const context = makeContext({
      codeBlockCount: 0,
      messageTypes: { toolCalls: 0.2, conversation: 0.2, codeBlocks: 0.3 },
    });
    expect(strategy.isApplicable(context)).toBe(true);
  });

  it('should not be applicable when no code blocks', () => {
    const context = makeContext({
      codeBlockCount: 0,
      messageTypes: { toolCalls: 0.2, conversation: 0.6, codeBlocks: 0.05 },
    });
    expect(strategy.isApplicable(context)).toBe(false);
  });

  it('should estimate compression ratio as 0.5', () => {
    expect(strategy.estimateCompressionRatio(makeContext())).toBe(0.5);
  });

  it('should execute and return strategy result', async () => {
    const context = makeContext({ codeBlockCount: 1 });
    const result = await strategy.execute(context);

    expect(result.strategyType).toBe('code_summarization');
    expect(result.metadata.codeBlockCount).toBe(1);
    expect(result.compressionRatio).toBeGreaterThan(0);
  });
});
