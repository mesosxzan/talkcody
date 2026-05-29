import { logger } from '@/lib/logger';
import type { Message as ModelMessage } from '@/services/llm/types';
import type {
  CompressionStrategyResult,
  CompressionStrategyType,
  StrategyContext,
} from '@/types/agent';
import { estimateTokens } from '../../code-navigation-service';
import { ContextRewriter } from '../context-rewriter';

/**
 * CodeSummarization strategy: uses tree-sitter to compress large code blocks
 * into signatures and key definitions. Low cost, medium quality.
 */
export class CodeSummarizationStrategy {
  readonly type = 'code_summarization' as CompressionStrategyType;
  readonly cost = 'low' as const;
  readonly quality = 'medium' as const;

  private messageRewriter = new ContextRewriter();

  isApplicable(context: StrategyContext): boolean {
    const { analysis } = context;
    return analysis.codeBlockCount > 0 || analysis.messageTypes.codeBlocks > 0.2;
  }

  estimateCompressionRatio(_context: StrategyContext): number {
    return 0.5;
  }

  async execute(context: StrategyContext): Promise<CompressionStrategyResult> {
    const tokensBefore = await this.countTokens(context.messages);

    let rewritten: ModelMessage[];
    try {
      rewritten = await this.messageRewriter.rewriteMessages(context.messages);
    } catch (error) {
      logger.warn('CodeSummarization failed, returning original messages', error);
      rewritten = context.messages;
    }

    const tokensAfter = await this.countTokens(rewritten);

    logger.info('CodeSummarization strategy executed', {
      messagesBefore: context.messages.length,
      messagesAfter: rewritten.length,
      tokensBefore,
      tokensAfter,
    });

    return {
      messages: rewritten,
      tokensBefore,
      tokensAfter,
      compressionRatio: tokensAfter / tokensBefore,
      strategyType: this.type,
      metadata: {
        codeBlockCount: context.analysis.codeBlockCount,
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
