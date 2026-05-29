import { logger } from '@/lib/logger';
import type { Message as ModelMessage } from '@/services/llm/types';
import type {
  CompressionStrategyResult,
  CompressionStrategyType,
  StrategyContext,
} from '@/types/agent';
import { estimateTokens } from '../../code-navigation-service';
import { ContextFilter } from '../context-filter';

/**
 * FilterOnly strategy: removes duplicate file reads and outdated exploratory tools.
 * Lowest cost, lowest quality — good first pass before more expensive strategies.
 */
export class FilterOnlyStrategy {
  readonly type = 'filter_only' as CompressionStrategyType;
  readonly cost = 'low' as const;
  readonly quality = 'low' as const;

  private messageFilter = new ContextFilter();

  isApplicable(context: StrategyContext): boolean {
    const { analysis } = context;
    return analysis.duplicateToolCallCount > 0 || analysis.messageTypes.toolCalls > 0.5;
  }

  estimateCompressionRatio(_context: StrategyContext): number {
    return 0.7; // Conservative estimate
  }

  async execute(context: StrategyContext): Promise<CompressionStrategyResult> {
    const tokensBefore = await this.countTokens(context.messages);
    const filtered = this.messageFilter.filterMessages(context.messages);
    const tokensAfter = await this.countTokens(filtered);

    const duplicateCount = context.analysis.duplicateToolCallCount;

    logger.info('FilterOnly strategy executed', {
      messagesBefore: context.messages.length,
      messagesAfter: filtered.length,
      tokensBefore,
      tokensAfter,
      duplicateCount,
    });

    return {
      messages: filtered,
      tokensBefore,
      tokensAfter,
      compressionRatio: tokensAfter / tokensBefore,
      strategyType: this.type,
      metadata: {
        duplicateCount,
        messagesRemoved: context.messages.length - filtered.length,
      },
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
