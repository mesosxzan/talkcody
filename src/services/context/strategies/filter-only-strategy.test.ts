import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message as ModelMessage } from '@/services/llm/types';
import type { ContextAnalysis, StrategyContext } from '@/types/agent';

// Mock dependencies
vi.mock('@/services/code-navigation-service', () => ({
  estimateTokens: vi.fn().mockReturnValue(100),
}));

vi.mock('@/services/context/context-filter', () => {
  return {
    ContextFilter: class {
      filterMessages = vi.fn((msgs: ModelMessage[]) => msgs.slice(0, -1));
    },
  };
});

import { FilterOnlyStrategy } from './filter-only-strategy';

function makeToolCall(toolName: string, input: unknown, toolCallId = 'tc-1'): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName, input }],
  };
}

function makeToolResult(toolName: string, output: string, toolCallId = 'tc-1'): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName, output }],
  };
}

function makeUserMessage(text: string): ModelMessage {
  return { role: 'user', content: text };
}

function makeContext(overrides: Partial<ContextAnalysis> = {}): StrategyContext {
  const analysis: ContextAnalysis = {
    totalMessages: 10,
    totalTokens: 1000,
    toolCallCount: 5,
    conversationCount: 3,
    codeBlockCount: 0,
    duplicateToolCallCount: 0,
    messageTypes: { toolCalls: 0.5, conversation: 0.3, codeBlocks: 0 },
    explorationChains: [],
    ...overrides,
  };
  return {
    messages: [
      makeUserMessage('hello'),
      makeToolCall('readFile', { path: '/a.ts' }, 'tc-1'),
      makeToolResult('readFile', 'content', 'tc-1'),
      makeToolCall('readFile', { path: '/a.ts' }, 'tc-2'),
      makeToolResult('readFile', 'content', 'tc-2'),
    ],
    targetTokenBudget: 500,
    preserveRecentCount: 2,
    compressionModel: 'test-model',
    analysis,
  };
}

describe('FilterOnlyStrategy', () => {
  let strategy: FilterOnlyStrategy;

  beforeEach(() => {
    strategy = new FilterOnlyStrategy();
  });

  it('should have correct type and cost', () => {
    expect(strategy.type).toBe('filter_only');
    expect(strategy.cost).toBe('low');
    expect(strategy.quality).toBe('low');
  });

  it('should be applicable when duplicates exist', () => {
    const context = makeContext({ duplicateToolCallCount: 2 });
    expect(strategy.isApplicable(context)).toBe(true);
  });

  it('should be applicable when toolCalls ratio is high', () => {
    const context = makeContext({
      duplicateToolCallCount: 0,
      messageTypes: { toolCalls: 0.6, conversation: 0.2, codeBlocks: 0.2 },
    });
    expect(strategy.isApplicable(context)).toBe(true);
  });

  it('should not be applicable when no duplicates and low toolCalls ratio', () => {
    const context = makeContext({
      duplicateToolCallCount: 0,
      messageTypes: { toolCalls: 0.3, conversation: 0.5, codeBlocks: 0.2 },
    });
    expect(strategy.isApplicable(context)).toBe(false);
  });

  it('should estimate compression ratio as 0.7', () => {
    const context = makeContext();
    expect(strategy.estimateCompressionRatio(context)).toBe(0.7);
  });

  it('should execute and return strategy result', async () => {
    const context = makeContext({ duplicateToolCallCount: 1 });
    const result = await strategy.execute(context);

    expect(result.strategyType).toBe('filter_only');
    expect(result.messages.length).toBeLessThanOrEqual(context.messages.length);
    expect(result.metadata.duplicateCount).toBe(1);
    expect(result.compressionRatio).toBeGreaterThan(0);
    expect(result.compressionRatio).toBeLessThanOrEqual(1);
  });
});
