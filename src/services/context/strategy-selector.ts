import { logger } from '@/lib/logger';
import type {
  CompressionConfig,
  CompressionStrategy,
  CompressionStrategyType,
  StrategyContext,
} from '@/types/agent';
import { ContextAnalyzer } from './context-analyzer';
import { AISummarizationStrategy } from './strategies/ai-summarization-strategy';
import { CodeSummarizationStrategy } from './strategies/code-summarization-strategy';
import { FilterOnlyStrategy } from './strategies/filter-only-strategy';
import { ProgressiveHybridStrategy } from './strategies/progressive-hybrid-strategy';
import { SelectiveRemovalStrategy } from './strategies/selective-removal-strategy';

export class StrategySelector {
  private analyzer: ContextAnalyzer;

  constructor(analyzer?: ContextAnalyzer) {
    this.analyzer = analyzer ?? new ContextAnalyzer();
  }

  /**
   * Selects the appropriate compression strategy based on config and context analysis.
   */
  select(config: CompressionConfig): CompressionStrategy {
    const mode = config.strategyMode ?? 'auto';

    switch (mode) {
      case 'filter_only':
        return new FilterOnlyStrategy();

      case 'code_summarization':
        return new CodeSummarizationStrategy();

      case 'selective_removal':
        return new SelectiveRemovalStrategy();

      case 'ai_only':
        return new AISummarizationStrategy({ preRunCodeSummarization: true });

      case 'progressive':
        return new ProgressiveHybridStrategy({
          maxEscalations: config.maxStrategyEscalations,
          targetCompressionRatio: config.targetCompressionRatio,
        });

      case 'auto':
      default:
        return new ProgressiveHybridStrategy({
          maxEscalations: config.maxStrategyEscalations,
          targetCompressionRatio: config.targetCompressionRatio,
        });
    }
  }

  /**
   * Builds a StrategyContext from messages, config, and analysis.
   */
  buildContext(
    messages: Parameters<ContextAnalyzer['analyze']>[0],
    config: CompressionConfig,
    analysis: Awaited<ReturnType<ContextAnalyzer['analyze']>>,
    targetTokenBudget: number,
    preserveRecentCount: number
  ): StrategyContext {
    return {
      messages,
      targetTokenBudget,
      preserveRecentCount,
      compressionModel: config.compressionModel ?? 'default',
      compressionFallbackModels: config.compressionFallbackModels,
      analysis,
    };
  }
}
