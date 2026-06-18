import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message as ModelMessage } from '@/services/llm/types';
import type { ContextAnalysis, ExplorationChain, StrategyContext } from '@/types/agent';

vi.mock('@/services/code-navigation-service', () => ({
  estimateTokens: vi.fn(),
}));

import { estimateTokens } from '@/services/code-navigation-service';
import { SelectiveRemovalStrategy } from './selective-removal-strategy';

function makeToolCall(toolName: string, toolCallId = 'tc-1'): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName, input: {} }],
  };
}

function makeToolResult(toolCallId = 'tc-1'): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName: 'test', output: '' }],
  };
}

function makeUserMessage(text: string): ModelMessage {
  return { role: 'user', content: text };
}

function makeContext(
  messages: ModelMessage[],
  chains: ExplorationChain[],
  preserveRecent = 2,
): StrategyContext {
  const analysis: ContextAnalysis = {
    totalMessages: messages.length,
    totalTokens: 1000,
    toolCallCount: 5,
    conversationCount: 2,
    codeBlockCount: 0,
    duplicateToolCallCount: 0,
    messageTypes: { toolCalls: 0.5, conversation: 0.3, codeBlocks: 0 },
    explorationChains: chains,
  };
  return {
    messages,
    targetTokenBudget: 500,
    preserveRecentCount: preserveRecent,
    compressionModel: 'test-model',
    analysis,
  };
}

describe('SelectiveRemovalStrategy', () => {
  let strategy: SelectiveRemovalStrategy;

  beforeEach(() => {
    vi.mocked(estimateTokens).mockReturnValue(100);
    strategy = new SelectiveRemovalStrategy();
  });

  it('should have correct type and cost', () => {
    expect(strategy.type).toBe('selective_removal');
    expect(strategy.cost).toBe('medium');
    expect(strategy.quality).toBe('medium');
  });

  it('should be applicable when exploration chains exist', () => {
    const context = makeContext(
      [makeToolCall('glob', 'tc-1'), makeToolResult('tc-1')],
      [{ startIndex: 0, endIndex: 1, messageCount: 2, summary: 'Explored files' }],
    );
    expect(strategy.isApplicable(context)).toBe(true);
  });

  it('should not be applicable when no exploration chains', () => {
    const context = makeContext([makeUserMessage('hello')], []);
    expect(strategy.isApplicable(context)).toBe(false);
  });

  it('should estimate compression ratio based on chain sizes', () => {
    const context = makeContext(
      [makeUserMessage('hello')], // 1 message
      [{ startIndex: 0, endIndex: 3, messageCount: 4, summary: 'Chain' }], // 4 in chain
    );
    // totalMessages=1 but chain says 4 messages... analysis says 1
    // estimateCompressionRatio uses totalMessages from analysis
    const ratio = strategy.estimateCompressionRatio(context);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it('should execute and replace chains with summary messages', async () => {
    const messages: ModelMessage[] = [
      makeToolCall('glob', 'tc-1'),
      makeToolResult('tc-1'),
      makeToolCall('Read', 'tc-2'),
      makeToolResult('tc-2'),
      makeUserMessage('done'),
    ];

    const chains: ExplorationChain[] = [
      { startIndex: 0, endIndex: 3, messageCount: 4, summary: 'Explored src/**/*.ts' },
    ];

    const context = makeContext(messages, chains, 1);
    const result = await strategy.execute(context);

    expect(result.strategyType).toBe('selective_removal');
    // 4 chain messages replaced by 1 summary + 1 preserved user message = 2
    expect(result.messages.length).toBe(2);
    expect(result.metadata.chainsRemoved).toBe(1);
  });

  it('should condense chains in the preserve-recent window instead of removing', async () => {
    const messages: ModelMessage[] = [
      makeUserMessage('start'),
      makeToolCall('glob', 'tc-1'),
      makeToolResult('tc-1'),
      makeToolCall('Read', 'tc-2'),
      makeToolResult('tc-2'),
    ];

    const chains: ExplorationChain[] = [
      { startIndex: 1, endIndex: 4, messageCount: 4, summary: 'Explored files' },
    ];

    // Chain is in preserve-recent window (last 4 messages)
    const context = makeContext(messages, chains, 4);
    const result = await strategy.execute(context);

    expect(result.metadata.chainsCondensed).toBe(1);
    expect(result.metadata.chainsRemoved).toBe(0);
  });

  it('should handle no chains gracefully', async () => {
    const messages = [makeUserMessage('hello')];
    const context = makeContext(messages, []);
    const result = await strategy.execute(context);

    expect(result.messages).toEqual(messages);
    expect(result.metadata.chainsRemoved).toBe(0);
  });
});
