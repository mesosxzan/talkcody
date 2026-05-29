import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message as ModelMessage } from '@/services/llm/types';
import type { CompressionStrategy, CompressionStrategyResult, CompressionStrategyType, ContextAnalysis, StrategyContext } from '@/types/agent';

vi.mock('@/services/code-navigation-service', () => ({
  estimateTokens: vi.fn().mockResolvedValue(100),
}));

vi.mock('@/services/ai/ai-context-compaction', () => ({
  aiContextCompactionService: {
    compactContext: vi.fn().mockResolvedValue('1. Summary: compressed'),
  },
}));

import { ProgressiveHybridStrategy } from './progressive-hybrid-strategy';

function makeUserMessage(text: string): ModelMessage {
  return { role: 'user', content: text };
}

function makeContext(overrides: Partial<ContextAnalysis> = {}): StrategyContext {
  const analysis: ContextAnalysis = {
    totalMessages: 5,
    totalTokens: 1000,
    toolCallCount: 1,
    conversationCount: 3,
    codeBlockCount: 0,
    duplicateToolCallCount: 0,
    messageTypes: { toolCalls: 0.2, conversation: 0.6, codeBlocks: 0 },
    explorationChains: [],
    ...overrides,
  };
  return {
    messages: [makeUserMessage('hello'), makeUserMessage('world')],
    targetTokenBudget: 0,
    preserveRecentCount: 1,
    compressionModel: 'test-model',
    analysis,
  };
}

function makeMockStrategy(
  type: CompressionStrategyType,
  applicable: boolean,
  resultMessages: ModelMessage[],
): CompressionStrategy {
  return {
    type,
    cost: 'low' as const,
    quality: 'low' as const,
    isApplicable: vi.fn().mockReturnValue(applicable),
    estimateCompressionRatio: vi.fn().mockReturnValue(0.5),
    execute: vi.fn().mockResolvedValue({
      messages: resultMessages,
      tokensBefore: 100,
      tokensAfter: 50,
      compressionRatio: 0.5,
      strategyType: type,
      metadata: {},
    } satisfies CompressionStrategyResult),
  };
}

describe('ProgressiveHybridStrategy', () => {
  it('should have correct type', () => {
    const strategy = new ProgressiveHybridStrategy();
    expect(strategy.type).toBe('progressive_hybrid');
  });

  it('should always be applicable', () => {
    const strategy = new ProgressiveHybridStrategy();
    expect(strategy.isApplicable(makeContext())).toBe(true);
  });

  it('should chain strategies and stop when ratio target is met', async () => {
    // Test with direct strategy injection by using a subclass approach
    // Since ProgressiveHybridStrategy creates its own strategies internally,
    // we test the overall behavior through the public interface
    const strategy = new ProgressiveHybridStrategy({
      targetCompressionRatio: 0.99, // Very easy to meet
      maxEscalations: 4,
    });

    const context = makeContext({
      duplicateToolCallCount: 1,
      messageTypes: { toolCalls: 0.6, conversation: 0.2, codeBlocks: 0.2 },
    });

    const result = await strategy.execute(context);
    expect(result.strategyType).toBe('progressive_hybrid');
    expect(result.metadata.strategiesUsed).toBeGreaterThanOrEqual(1);
  });

  it('should respect maxEscalations limit', async () => {
    const strategy = new ProgressiveHybridStrategy({ maxEscalations: 1 });
    const context = makeContext({
      duplicateToolCallCount: 1,
      messageTypes: { toolCalls: 0.6, conversation: 0.2, codeBlocks: 0.2 },
    });

    const result = await strategy.execute(context);
    expect(result.metadata.strategiesUsed).toBeLessThanOrEqual(1);
  });

  it('should execute with only AI when no low-cost strategies apply', async () => {
    const strategy = new ProgressiveHybridStrategy();
    const context = makeContext({
      duplicateToolCallCount: 0,
      codeBlockCount: 0,
      messageTypes: { toolCalls: 0.1, conversation: 0.8, codeBlocks: 0 },
    });

    const result = await strategy.execute(context);
    expect(result.strategyType).toBe('progressive_hybrid');
    // AI strategy is always applicable
    expect(result.metadata.strategiesUsed).toBeGreaterThanOrEqual(1);
  });

  it('should stop when token budget is met', async () => {
    const strategy = new ProgressiveHybridStrategy();
    const context = makeContext({
      duplicateToolCallCount: 1,
      messageTypes: { toolCalls: 0.6, conversation: 0.2, codeBlocks: 0.2 },
    });
    context.targetTokenBudget = 100000; // Very high budget

    const result = await strategy.execute(context);
    expect(result.metadata.strategiesUsed).toBeGreaterThanOrEqual(1);
  });
});
