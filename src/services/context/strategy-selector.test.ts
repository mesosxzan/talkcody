import { describe, it, expect, vi } from 'vitest';
import type { CompressionConfig } from '@/types/agent';
import { ContextAnalyzer } from './context-analyzer';
import { StrategySelector } from './strategy-selector';

vi.mock('@/services/code-navigation-service', () => ({
  estimateTokens: vi.fn().mockResolvedValue(100),
}));

describe('StrategySelector', () => {
  let selector: StrategySelector;

  beforeEach(() => {
    selector = new StrategySelector();
  });

  describe('select', () => {
    it('should return ProgressiveHybridStrategy for auto mode (default)', () => {
      const config: CompressionConfig = {};
      const strategy = selector.select(config);
      expect(strategy.type).toBe('progressive_hybrid');
    });

    it('should return ProgressiveHybridStrategy for progressive mode', () => {
      const config: CompressionConfig = { strategyMode: 'progressive' };
      const strategy = selector.select(config);
      expect(strategy.type).toBe('progressive_hybrid');
    });

    it('should return FilterOnlyStrategy for filter_only mode', () => {
      const config: CompressionConfig = { strategyMode: 'filter_only' };
      const strategy = selector.select(config);
      expect(strategy.type).toBe('filter_only');
    });

    it('should return CodeSummarizationStrategy for code_summarization mode', () => {
      const config: CompressionConfig = { strategyMode: 'code_summarization' };
      const strategy = selector.select(config);
      expect(strategy.type).toBe('code_summarization');
    });

    it('should return SelectiveRemovalStrategy for selective_removal mode', () => {
      const config: CompressionConfig = { strategyMode: 'selective_removal' };
      const strategy = selector.select(config);
      expect(strategy.type).toBe('selective_removal');
    });

    it('should return AISummarizationStrategy with preRunCodeSummarization for ai_only mode', () => {
      const config: CompressionConfig = { strategyMode: 'ai_only' };
      const strategy = selector.select(config);
      expect(strategy.type).toBe('ai_summarization');
    });

    it('should pass maxStrategyEscalations and targetCompressionRatio to progressive', () => {
      const config: CompressionConfig = {
        strategyMode: 'auto',
        maxStrategyEscalations: 5,
        targetCompressionRatio: 0.3,
      };
      const strategy = selector.select(config);
      expect(strategy.type).toBe('progressive_hybrid');
    });
  });

  describe('buildContext', () => {
    it('should build a valid StrategyContext', () => {
      const messages = [{ role: 'user' as const, content: 'hello' }];
      const config: CompressionConfig = { compressionModel: 'gpt-4' };
      const analysis = {
        totalMessages: 1,
        totalTokens: 10,
        toolCallCount: 0,
        conversationCount: 1,
        codeBlockCount: 0,
        duplicateToolCallCount: 0,
        messageTypes: { toolCalls: 0, conversation: 1, codeBlocks: 0 },
        explorationChains: [],
      };

      const context = selector.buildContext(messages, config, analysis, 500, 2);

      expect(context.messages).toEqual(messages);
      expect(context.targetTokenBudget).toBe(500);
      expect(context.preserveRecentCount).toBe(2);
      expect(context.compressionModel).toBe('gpt-4');
      expect(context.analysis).toEqual(analysis);
    });

    it('should default compressionModel when not specified', () => {
      const config: CompressionConfig = {};
      const analysis = {
        totalMessages: 0,
        totalTokens: 0,
        toolCallCount: 0,
        conversationCount: 0,
        codeBlockCount: 0,
        duplicateToolCallCount: 0,
        messageTypes: { toolCalls: 0, conversation: 0, codeBlocks: 0 },
        explorationChains: [],
      };

      const context = selector.buildContext([], config, analysis, 0, 0);
      expect(context.compressionModel).toBe('default');
    });
  });
});
