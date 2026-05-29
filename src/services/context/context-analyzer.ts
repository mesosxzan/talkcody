import { logger } from '@/lib/logger';
import type { Message as ModelMessage } from '@/services/llm/types';
import type { ContextAnalysis, ExplorationChain, MessageTypeDistribution } from '@/types/agent';
import { estimateTokens } from '../code-navigation-service';

/** Tool names that indicate exploration (file browsing, searching) */
const EXPLORATORY_TOOL_NAMES = new Set([
  'glob',
  'listFiles',
  'codeSearch',
  'readFile',
  'grep',
  'Grep',
  'Glob',
  'Read',
]);

/** Minimum consecutive exploratory messages to form a chain */
const MIN_CHAIN_LENGTH = 4;

/** Threshold for "large" code blocks (lines) */
const LARGE_CODE_BLOCK_LINES = 20;

export class ContextAnalyzer {
  /**
   * Analyzes a set of messages to determine their composition,
   * detect exploration chains, and count duplicates.
   */
  async analyze(messages: ModelMessage[]): Promise<ContextAnalysis> {
    const totalMessages = messages.length;
    const toolCallCount = this.countToolCalls(messages);
    const conversationCount = this.countConversationMessages(messages);
    const codeBlockCount = this.countCodeBlockMessages(messages);
    const duplicateToolCallCount = this.countDuplicateToolCalls(messages);
    const messageTypes = this.computeMessageTypes(
      totalMessages,
      toolCallCount,
      conversationCount,
      codeBlockCount
    );
    const explorationChains = this.detectExplorationChains(messages);

    // Estimate total tokens
    let totalTokens = 0;
    try {
      const text = messages
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n');
      totalTokens = await estimateTokens(text);
    } catch {
      // Fallback: rough character-based estimate
      const totalChars = messages.reduce((sum, m) => {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return sum + c.length;
      }, 0);
      totalTokens = Math.ceil(totalChars / 4);
    }

    const analysis: ContextAnalysis = {
      totalMessages,
      totalTokens,
      toolCallCount,
      conversationCount,
      codeBlockCount,
      duplicateToolCallCount,
      messageTypes,
      explorationChains,
    };

    logger.info('Context analysis completed', {
      totalMessages,
      totalTokens,
      toolCallCount,
      duplicateToolCallCount,
      explorationChains: explorationChains.length,
    });

    return analysis;
  }

  /**
   * Counts messages that contain tool-call parts.
   */
  private countToolCalls(messages: ModelMessage[]): number {
    let count = 0;
    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (
            typeof part === 'object' &&
            part !== null &&
            'type' in part &&
            part.type === 'tool-call'
          ) {
            count++;
          }
        }
      }
    }
    return count;
  }

  /**
   * Counts pure conversation messages (user/assistant text without tool calls).
   */
  private countConversationMessages(messages: ModelMessage[]): number {
    let count = 0;
    for (const msg of messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          count++;
        } else if (Array.isArray(msg.content)) {
          const hasToolCall = msg.content.some(
            (p) => typeof p === 'object' && p !== null && 'type' in p && p.type === 'tool-call'
          );
          if (!hasToolCall) count++;
        }
      }
    }
    return count;
  }

  /**
   * Counts messages containing large code blocks (```...``` with >= LARGE_CODE_BLOCK_LINES lines).
   */
  private countCodeBlockMessages(messages: ModelMessage[]): number {
    let count = 0;
    for (const msg of messages) {
      const text = this.extractText(msg);
      if (this.hasLargeCodeBlock(text)) count++;
    }
    return count;
  }

  /**
   * Counts duplicate tool calls (same tool name + same input appearing more than once).
   */
  private countDuplicateToolCalls(messages: ModelMessage[]): number {
    const seen = new Map<string, number>();
    let duplicates = 0;

    for (const msg of messages) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if (
          typeof part !== 'object' ||
          part === null ||
          !('type' in part) ||
          part.type !== 'tool-call' ||
          !('toolName' in part) ||
          !('input' in part)
        )
          continue;

        const key = `${(part as { toolName: string }).toolName}:${JSON.stringify((part as { input: unknown }).input)}`;
        const prev = seen.get(key) ?? 0;
        if (prev > 0) duplicates++;
        seen.set(key, prev + 1);
      }
    }

    return duplicates;
  }

  /**
   * Detects exploration chains: consecutive sequences of exploratory tool calls
   * (glob, readFile, grep, etc.) without substantive analysis text between them.
   */
  private detectExplorationChains(messages: ModelMessage[]): ExplorationChain[] {
    const chains: ExplorationChain[] = [];
    let chainStart = -1;
    let chainEnd = -1;
    const filePathsInChain = new Set<string>();

    const isExploratory = (msg: ModelMessage): boolean => {
      if (msg.role === 'tool' && Array.isArray(msg.content)) {
        // Tool results for exploratory tools
        return msg.content.some(
          (p) =>
            typeof p === 'object' &&
            p !== null &&
            'type' in p &&
            p.type === 'tool-result' &&
            'toolName' in p &&
            EXPLORATORY_TOOL_NAMES.has((p as { toolName: string }).toolName)
        );
      }
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        // Assistant messages that only contain exploratory tool calls (no text analysis)
        const parts = msg.content;
        const hasText = parts.some(
          (p) => typeof p === 'object' && p !== null && 'type' in p && p.type === 'text'
        );
        if (hasText) return false; // Has substantive text, not pure exploration

        const hasExploratoryCall = parts.some(
          (p) =>
            typeof p === 'object' &&
            p !== null &&
            'type' in p &&
            p.type === 'tool-call' &&
            'toolName' in p &&
            EXPLORATORY_TOOL_NAMES.has((p as { toolName: string }).toolName)
        );
        return hasExploratoryCall;
      }
      return false;
    };

    const extractFilePaths = (msg: ModelMessage): string[] => {
      const paths: string[] = [];
      if (!Array.isArray(msg.content)) return paths;

      for (const part of msg.content) {
        if (typeof part !== 'object' || part === null || !('type' in part)) continue;

        if (part.type === 'tool-call' && 'input' in part) {
          const input = (part as { input: unknown }).input;
          if (typeof input === 'object' && input !== null) {
            const obj = input as Record<string, unknown>;
            if (typeof obj.path === 'string') paths.push(obj.path);
            if (typeof obj.pattern === 'string') paths.push(obj.pattern);
            if (typeof obj.query === 'string') paths.push(obj.query);
          }
        }

        if (part.type === 'tool-result' && 'output' in part) {
          const output = (part as { output: unknown }).output;
          if (typeof output === 'string') {
            // Extract file paths from tool output (common patterns)
            const pathMatches = output.matchAll(/(?:^|\n)([^\s:]+\.\w{1,10})(?::|\s|$)/gm);
            for (const m of pathMatches) {
              if (m[1] && !m[1].startsWith('```')) paths.push(m[1]);
            }
          }
        }
      }
      return paths;
    };

    const finalizeChain = () => {
      if (chainStart >= 0 && chainEnd >= chainStart) {
        const messageCount = chainEnd - chainStart + 1;
        if (messageCount >= MIN_CHAIN_LENGTH) {
          const paths = [...filePathsInChain].slice(0, 5);
          const summary =
            paths.length > 0
              ? `Explored ${paths.join(', ')}${filePathsInChain.size > 5 ? ' and more' : ''}`
              : 'Exploration sequence';

          chains.push({
            startIndex: chainStart,
            endIndex: chainEnd,
            messageCount,
            summary,
          });
        }
      }
      chainStart = -1;
      chainEnd = -1;
      filePathsInChain.clear();
    };

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;

      // Skip messages with errors or code edits — they're not pure exploration
      if (this.hasErrorOrEdit(msg)) {
        finalizeChain();
        continue;
      }

      if (isExploratory(msg)) {
        if (chainStart < 0) chainStart = i;
        chainEnd = i;
        for (const p of extractFilePaths(msg)) filePathsInChain.add(p);
      } else {
        finalizeChain();
      }
    }

    finalizeChain();
    return chains;
  }

  private computeMessageTypes(
    total: number,
    toolCalls: number,
    conversation: number,
    codeBlocks: number
  ): MessageTypeDistribution {
    if (total === 0) {
      return { toolCalls: 0, conversation: 0, codeBlocks: 0 };
    }
    return {
      toolCalls: toolCalls / total,
      conversation: conversation / total,
      codeBlocks: codeBlocks / total,
    };
  }

  private extractText(msg: ModelMessage): string {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter(
          (p): p is { type: 'text'; text: string } =>
            typeof p === 'object' && p !== null && 'type' in p && p.type === 'text'
        )
        .map((p) => p.text)
        .join('\n');
    }
    return '';
  }

  private hasLargeCodeBlock(text: string): boolean {
    const codeBlockRegex = /```[\s\S]*?```/g;
    for (const match of text.matchAll(codeBlockRegex)) {
      const lines = match[0].split('\n').length;
      if (lines >= LARGE_CODE_BLOCK_LINES) return true;
    }
    return false;
  }

  /**
   * Checks if a message contains an error or code edit, which should
   * break an exploration chain.
   */
  private hasErrorOrEdit(msg: ModelMessage): boolean {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          typeof part === 'object' &&
          part !== null &&
          'type' in part &&
          part.type === 'tool-call' &&
          'toolName' in part
        ) {
          const name = (part as { toolName: string }).toolName;
          // Edit/write operations break exploration chains
          if (
            name === 'Edit' ||
            name === 'Write' ||
            name === 'edit' ||
            name === 'write' ||
            name === 'apply_diff' ||
            name === 'replace'
          ) {
            return true;
          }
        }
      }
    }

    // Check for error indicators in tool results
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          typeof part === 'object' &&
          part !== null &&
          'type' in part &&
          part.type === 'tool-result' &&
          'output' in part
        ) {
          const output = String((part as { output: unknown }).output);
          if (output.toLowerCase().includes('error') || output.toLowerCase().includes('failed')) {
            return true;
          }
        }
      }
    }

    return false;
  }
}
