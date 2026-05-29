import { logger } from '@/lib/logger';
import type { Message as ModelMessage } from '@/services/llm/types';
import type {
  CompressionStrategyResult,
  CompressionStrategyType,
  ExplorationChain,
  StrategyContext,
} from '@/types/agent';
import { estimateTokens } from '../../code-navigation-service';

/**
 * SelectiveRemoval strategy: identifies and removes/compresses exploration chains
 * (sequences of glob→read→glob→read) by replacing each chain with a concise summary.
 * Medium cost, medium quality.
 */
export class SelectiveRemovalStrategy {
  readonly type = 'selective_removal' as CompressionStrategyType;
  readonly cost = 'medium' as const;
  readonly quality = 'medium' as const;

  isApplicable(context: StrategyContext): boolean {
    return context.analysis.explorationChains.length > 0;
  }

  estimateCompressionRatio(context: StrategyContext): number {
    const { explorationChains, totalMessages } = context.analysis;
    if (totalMessages === 0) return 1;

    let chainMessages = 0;
    for (const chain of explorationChains) {
      chainMessages += chain.messageCount;
    }
    // Each chain is replaced by 1 summary message
    const messagesRemoved = chainMessages - explorationChains.length;
    return Math.max(0.3, 1 - messagesRemoved / totalMessages);
  }

  async execute(context: StrategyContext): Promise<CompressionStrategyResult> {
    const tokensBefore = await this.countTokens(context.messages);
    const { explorationChains, totalMessages } = context.analysis;

    if (explorationChains.length === 0) {
      return {
        messages: context.messages,
        tokensBefore,
        tokensAfter: tokensBefore,
        compressionRatio: 1,
        strategyType: this.type,
        metadata: { chainsRemoved: 0, chainsCondensed: 0, messagesRemoved: 0 },
      };
    }

    // Mark chain ranges for replacement
    const chainRanges = new Map<number, ExplorationChain>();
    for (const chain of explorationChains) {
      chainRanges.set(chain.startIndex, chain);
    }

    const result: ModelMessage[] = [];
    let chainsRemoved = 0;
    let chainsCondensed = 0;
    let messagesRemoved = 0;

    let i = 0;
    while (i < totalMessages) {
      const chain = chainRanges.get(i);
      if (chain) {
        // Check if this chain is within the preserve-recent window
        const preserveBoundary = totalMessages - context.preserveRecentCount;
        if (chain.endIndex >= preserveBoundary) {
          // Chain is in recent window — keep it but condense
          result.push(this.createChainSummaryMessage(chain));
          chainsCondensed++;
        } else {
          // Chain is outside recent window — replace with compact summary
          result.push(this.createChainSummaryMessage(chain));
          chainsRemoved++;
        }
        messagesRemoved += chain.messageCount - 1; // -1 because we add 1 summary message
        i = chain.endIndex + 1;
      } else {
        const msg = context.messages[i];
        if (msg) result.push(msg);
        i++;
      }
    }

    const tokensAfter = await this.countTokens(result);

    logger.info('SelectiveRemoval strategy executed', {
      messagesBefore: context.messages.length,
      messagesAfter: result.length,
      tokensBefore,
      tokensAfter,
      chainsRemoved,
      chainsCondensed,
      messagesRemoved,
    });

    return {
      messages: result,
      tokensBefore,
      tokensAfter,
      compressionRatio: tokensAfter / tokensBefore,
      strategyType: this.type,
      metadata: { chainsRemoved, chainsCondensed, messagesRemoved },
    };
  }

  private createChainSummaryMessage(chain: ExplorationChain): ModelMessage {
    return {
      role: 'assistant',
      content: `[Exploration summary: ${chain.summary} (${chain.messageCount} messages condensed)]`,
    };
  }

  private async countTokens(messages: ModelMessage[]): Promise<number> {
    try {
      const text = messages
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n');
      return await estimateTokens(text);
    } catch {
      return messages.reduce((sum, m) => {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return sum + Math.ceil(c.length / 4);
      }, 0);
    }
  }
}
