import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message as ModelMessage } from '@/services/llm/types';
import type { ContextAnalysis, StrategyContext } from '@/types/agent';

vi.mock('@/services/code-navigation-service', () => ({
  estimateTokens: vi.fn(),
}));

vi.mock('@/services/ai/ai-context-compaction', () => ({
  aiContextCompactionService: {
    compactContext: vi.fn().mockResolvedValue(
      '<analysis>Test analysis</analysis>\n1. Key Points: Important information here.',
    ),
  },
}));

vi.mock('@/services/context/context-rewriter', () => {
  return {
    ContextRewriter: class {
      rewriteMessages = vi.fn((msgs: ModelMessage[]) => Promise.resolve(msgs));
    },
  };
});

import { estimateTokens } from '@/services/code-navigation-service';
import { AISummarizationStrategy } from './ai-summarization-strategy';

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
    targetTokenBudget: 500,
    preserveRecentCount: 1,
    compressionModel: 'test-model',
    analysis,
  };
}

describe('AISummarizationStrategy', () => {
  let strategy: AISummarizationStrategy;

  beforeEach(() => {
    vi.mocked(estimateTokens).mockResolvedValue(100);
    strategy = new AISummarizationStrategy();
  });

  it('should have correct type and cost', () => {
    expect(strategy.type).toBe('ai_summarization');
    expect(strategy.cost).toBe('high');
    expect(strategy.quality).toBe('high');
  });

  it('should always be applicable', () => {
    expect(strategy.isApplicable(makeContext())).toBe(true);
  });

  it('should estimate compression ratio as 0.3', () => {
    expect(strategy.estimateCompressionRatio(makeContext())).toBe(0.3);
  });

  it('should execute AI compression and return structured result', async () => {
    const context = makeContext();
    const result = await strategy.execute(context);

    expect(result.strategyType).toBe('ai_summarization');
    expect(result.messages.length).toBe(2); // summary user + ack assistant
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toContain('[Previous conversation summary]');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.metadata.modelUsed).toBe('test-model');
    expect(result.metadata.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should optionally pre-run code summarization', async () => {
    const strategyWithPreRun = new AISummarizationStrategy({
      preRunCodeSummarization: true,
    });
    const context = makeContext({ codeBlockCount: 1 });
    const result = await strategyWithPreRun.execute(context);

    expect(result.metadata.preSummarized).toBe(true);
  });

  it('should handle AI compression failure gracefully', async () => {
    const { aiContextCompactionService } = await import('@/services/ai/ai-context-compaction');
    (aiContextCompactionService.compactContext as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('API error'),
    );

    const context = makeContext();
    const result = await strategy.execute(context);

    expect(result.metadata.failed).toBe(true);
    expect(result.messages).toEqual(context.messages); // Return original on failure
  });
});
