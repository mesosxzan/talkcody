import { logger } from '@/lib/logger';
import type {
  CompressionStrategy,
  CompressionStrategyResult,
  CompressionStrategyType,
  StrategyContext,
} from '@/types/agent';
import { estimateTokens } from '../../code-navigation-service';
import { AISummarizationStrategy } from './ai-summarization-strategy';
import { CodeSummarizationStrategy } from './code-summarization-strategy';
import { FilterOnlyStrategy } from './filter-only-strategy';
import { SelectiveRemovalStrategy } from './selective-removal-strategy';

/**
 * ProgressiveHybrid strategy: automatically chains multiple low-cost strategies
 * before escalating to expensive ones. Stops as soon as the target compression
 * ratio or token budget is met.
 */
export class ProgressiveHybridStrategy {
  readonly type = 'progressive_hybrid' as CompressionStrategyType;
  readonly cost = 'high' as const; // Could escalate to high
  readonly quality = 'high' as const;

  private strategies: CompressionStrategy[];
  private maxEscalations: number;
  private targetCompressionRatio: number;

  constructor(options?: {
    maxEscalations?: number;
    targetCompressionRatio?: number;
  }) {
    this.maxEscalations = options?.maxEscalations ?? 3;
    this.targetCompressionRatio = options?.targetCompressionRatio ?? 0.4;

    // Strategies ordered by cost: low → medium → high
    this.strategies = [
      new FilterOnlyStrategy(),
      new CodeSummarizationStrategy(),
      new SelectiveRemovalStrategy(),
      new AISummarizationStrategy(),
    ];
  }

  isApplicable(_context: StrategyContext): boolean {
    return true; // Always applicable
  }

  estimateCompressionRatio(context: StrategyContext): number {
    // Return the best estimate from applicable strategies
    for (const strategy of this.strategies) {
      if (strategy.isApplicable(context)) {
        return strategy.estimateCompressionRatio(context);
      }
    }
    return 1;
  }

  async execute(context: StrategyContext): Promise<CompressionStrategyResult> {
    const tokensBefore = await this.countTokens(context.messages);
    let currentMessages = context.messages;
    let currentTokens = tokensBefore;
    const strategyResults: CompressionStrategyResult[] = [];
    const strategyChain: CompressionStrategyType[] = [];

    // Filter to applicable strategies
    const applicable = this.strategies.filter((s) => s.isApplicable(context));

    logger.info('ProgressiveHybrid starting', {
      applicableStrategies: applicable.map((s) => s.type),
      maxEscalations: this.maxEscalations,
      targetCompressionRatio: this.targetCompressionRatio,
      targetTokenBudget: context.targetTokenBudget,
    });

    for (let i = 0; i < Math.min(applicable.length, this.maxEscalations); i++) {
      const strategy = applicable[i];
      if (!strategy) break;

      // Build updated context with current messages
      const currentContext: StrategyContext = {
        ...context,
        messages: currentMessages,
      };

      logger.info(`ProgressiveHybrid: running strategy ${strategy.type}`, {
        currentMessages: currentMessages.length,
        currentTokens,
      });

      const result = await strategy.execute(currentContext);

      strategyResults.push(result);
      strategyChain.push(strategy.type);

      // Update current state
      currentMessages = result.messages;
      currentTokens = result.tokensAfter;

      // Check early-exit conditions
      const overallRatio = currentTokens / tokensBefore;

      if (context.targetTokenBudget > 0 && currentTokens <= context.targetTokenBudget) {
        logger.info('ProgressiveHybrid: target token budget met, stopping', {
          strategy: strategy.type,
          currentTokens,
          targetBudget: context.targetTokenBudget,
        });
        break;
      }

      if (overallRatio <= this.targetCompressionRatio) {
        logger.info('ProgressiveHybrid: target compression ratio met, stopping', {
          strategy: strategy.type,
          overallRatio,
          targetRatio: this.targetCompressionRatio,
        });
        break;
      }
    }

    const tokensAfter = currentTokens;

    logger.info('ProgressiveHybrid completed', {
      strategyChain,
      tokensBefore,
      tokensAfter,
      compressionRatio: tokensAfter / tokensBefore,
    });

    return {
      messages: currentMessages,
      tokensBefore,
      tokensAfter,
      compressionRatio: tokensAfter / tokensBefore,
      strategyType: this.type,
      metadata: {
        strategyChain,
        strategyResults,
        strategiesUsed: strategyChain.length,
      },
    };
  }

  private async countTokens(messages: { content?: string | unknown[] }[]): Promise<number> {
    try {
      const text = messages
        .map((m) => {
          return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        })
        .join('\n');
      return estimateTokens(text);
    } catch {
      return messages.reduce((sum: number, m) => {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return sum + Math.ceil(c.length / 4);
      }, 0);
    }
  }
}
