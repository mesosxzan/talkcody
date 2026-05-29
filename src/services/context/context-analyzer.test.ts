import { describe, it, expect, vi } from 'vitest';
import type { Message as ModelMessage } from '@/services/llm/types';

// Mock estimateTokens
vi.mock('@/services/code-navigation-service', () => ({
  estimateTokens: vi.fn().mockResolvedValue(100),
}));

import { ContextAnalyzer } from './context-analyzer';

function makeToolCall(toolName: string, input: unknown, toolCallId = 'tc-1'): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName, input }],
  };
}

function makeToolResult(
  toolName: string,
  output: string,
  toolCallId = 'tc-1',
): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName, output }],
  };
}

function makeUserMessage(text: string): ModelMessage {
  return { role: 'user', content: text };
}

function makeAssistantMessage(text: string): ModelMessage {
  return { role: 'assistant', content: text };
}

function makeAssistantWithCodeBlock(lines: number): ModelMessage {
  const code = Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n');
  return {
    role: 'assistant',
    content: `Here is the code:\n\`\`\`typescript\n${code}\n\`\`\``,
  };
}

describe('ContextAnalyzer', () => {
  let analyzer: ContextAnalyzer;

  beforeEach(() => {
    analyzer = new ContextAnalyzer();
  });

  describe('basic analysis', () => {
    it('should handle empty messages', async () => {
      const result = await analyzer.analyze([]);
      expect(result.totalMessages).toBe(0);
      expect(result.toolCallCount).toBe(0);
      expect(result.conversationCount).toBe(0);
      expect(result.codeBlockCount).toBe(0);
      expect(result.duplicateToolCallCount).toBe(0);
      expect(result.explorationChains).toEqual([]);
      expect(result.messageTypes).toEqual({ toolCalls: 0, conversation: 0, codeBlocks: 0 });
    });

    it('should count tool calls correctly', async () => {
      const messages: ModelMessage[] = [
        makeUserMessage('hello'),
        makeToolCall('readFile', { path: '/a.ts' }, 'tc-1'),
        makeToolResult('readFile', 'content', 'tc-1'),
        makeToolCall('readFile', { path: '/b.ts' }, 'tc-2'),
        makeToolResult('readFile', 'content', 'tc-2'),
        makeAssistantMessage('Done'),
      ];

      const result = await analyzer.analyze(messages);
      expect(result.toolCallCount).toBe(2);
      expect(result.conversationCount).toBe(2); // user + assistant text (tool-call assistants not counted)
    });

    it('should count conversation messages (user/assistant text only)', async () => {
      const messages: ModelMessage[] = [
        makeUserMessage('hello'),
        makeAssistantMessage('hi there'),
        makeToolCall('readFile', { path: '/a.ts' }, 'tc-1'),
        makeToolResult('readFile', 'content', 'tc-1'),
        makeAssistantMessage('I read the file'),
      ];

      const result = await analyzer.analyze(messages);
      expect(result.conversationCount).toBe(3); // user + 2 assistant text messages (not tool-call assistant)
    });

    it('should count code block messages', async () => {
      const messages: ModelMessage[] = [
        makeAssistantMessage('small code: `x = 1`'),
        makeAssistantWithCodeBlock(25),
        makeUserMessage('thanks'),
      ];

      const result = await analyzer.analyze(messages);
      expect(result.codeBlockCount).toBe(1); // Only the message with large code block
    });

    it('should compute message type distribution', async () => {
      const messages: ModelMessage[] = [
        makeUserMessage('hello'),                    // conversation
        makeToolCall('readFile', { path: '/a.ts' }, 'tc-1'),  // tool call
        makeToolResult('readFile', 'content', 'tc-1'),        // tool result (not counted as conv or tool-call)
        makeAssistantMessage('done'),                // conversation
      ];

      const result = await analyzer.analyze(messages);
      expect(result.messageTypes.toolCalls).toBeCloseTo(1 / 4);
      expect(result.messageTypes.conversation).toBeCloseTo(2 / 4);
    });
  });

  describe('duplicate tool call counting', () => {
    it('should count duplicate tool calls', async () => {
      const messages: ModelMessage[] = [
        makeToolCall('readFile', { path: '/a.ts' }, 'tc-1'),
        makeToolResult('readFile', 'content', 'tc-1'),
        makeToolCall('readFile', { path: '/a.ts' }, 'tc-2'), // duplicate
        makeToolResult('readFile', 'content', 'tc-2'),
        makeToolCall('readFile', { path: '/b.ts' }, 'tc-3'), // different input
        makeToolResult('readFile', 'content', 'tc-3'),
      ];

      const result = await analyzer.analyze(messages);
      expect(result.duplicateToolCallCount).toBe(1);
    });

    it('should count multiple duplicates', async () => {
      const messages: ModelMessage[] = [
        makeToolCall('readFile', { path: '/a.ts' }, 'tc-1'),
        makeToolCall('readFile', { path: '/a.ts' }, 'tc-2'), // 1st dup
        makeToolCall('readFile', { path: '/a.ts' }, 'tc-3'), // 2nd dup
      ];

      const result = await analyzer.analyze(messages);
      expect(result.duplicateToolCallCount).toBe(2);
    });
  });

  describe('exploration chain detection', () => {
    it('should detect glob→read→glob→read sequences', async () => {
      const messages: ModelMessage[] = [
        makeToolCall('glob', { pattern: 'src/**/*.ts' }, 'tc-1'),
        makeToolResult('glob', 'file1.ts\nfile2.ts', 'tc-1'),
        makeToolCall('Read', { path: 'file1.ts' }, 'tc-2'),
        makeToolResult('Read', 'content of file1', 'tc-2'),
        makeToolCall('glob', { pattern: 'src/**/*.tsx' }, 'tc-3'),
        makeToolResult('glob', 'comp1.tsx\ncomp2.tsx', 'tc-3'),
        makeToolCall('Read', { path: 'comp1.tsx' }, 'tc-4'),
        makeToolResult('Read', 'content of comp1', 'tc-4'),
      ];

      const result = await analyzer.analyze(messages);
      expect(result.explorationChains.length).toBe(1);
      expect(result.explorationChains[0].messageCount).toBe(8);
      expect(result.explorationChains[0].startIndex).toBe(0);
      expect(result.explorationChains[0].endIndex).toBe(7);
      expect(result.explorationChains[0].summary).toContain('src/**/*.ts');
    });

    it('should not form chains shorter than MIN_CHAIN_LENGTH', async () => {
      const messages: ModelMessage[] = [
        makeToolCall('glob', { pattern: '*.ts' }, 'tc-1'),
        makeToolResult('glob', 'file1.ts', 'tc-1'),
        // Only 2 messages - below MIN_CHAIN_LENGTH (4)
      ];

      const result = await analyzer.analyze(messages);
      expect(result.explorationChains).toEqual([]);
    });

    it('should break chain on substantive analysis text', async () => {
      const messages: ModelMessage[] = [
        makeToolCall('glob', { pattern: '*.ts' }, 'tc-1'),
        makeToolResult('glob', 'file1.ts', 'tc-1'),
        makeToolCall('Read', { path: 'file1.ts' }, 'tc-2'),
        makeToolResult('Read', 'content', 'tc-2'),
        // Substantive analysis breaks the chain
        makeAssistantMessage('After analyzing the code, I can see the architecture is...'),
        makeToolCall('glob', { pattern: '*.tsx' }, 'tc-3'),
        makeToolResult('glob', 'comp.tsx', 'tc-3'),
        makeToolCall('Read', { path: 'comp.tsx' }, 'tc-4'),
        makeToolResult('Read', 'content', 'tc-4'),
      ];

      const result = await analyzer.analyze(messages);
      // Two chains separated by the analysis message
      expect(result.explorationChains.length).toBe(2);
      expect(result.explorationChains[0].startIndex).toBe(0);
      expect(result.explorationChains[0].endIndex).toBe(3);
      expect(result.explorationChains[1].startIndex).toBe(5);
      expect(result.explorationChains[1].endIndex).toBe(8);
    });

    it('should break chain on code edit operations', async () => {
      const messages: ModelMessage[] = [
        makeToolCall('glob', { pattern: '*.ts' }, 'tc-1'),
        makeToolResult('glob', 'file1.ts', 'tc-1'),
        makeToolCall('Read', { path: 'file1.ts' }, 'tc-2'),
        makeToolResult('Read', 'content', 'tc-2'),
        // Edit breaks the chain
        makeToolCall('Edit', { path: 'file1.ts' }, 'tc-3'),
        makeToolResult('Edit', 'ok', 'tc-3'),
        makeToolCall('glob', { pattern: '*.tsx' }, 'tc-4'),
        makeToolResult('glob', 'comp.tsx', 'tc-4'),
        makeToolCall('Read', { path: 'comp.tsx' }, 'tc-5'),
        makeToolResult('Read', 'content', 'tc-5'),
      ];

      const result = await analyzer.analyze(messages);
      // Edit breaks the chain into two separate chains
      expect(result.explorationChains.length).toBe(2);
      expect(result.explorationChains[0].startIndex).toBe(0); // First exploration before edit
      expect(result.explorationChains[1].startIndex).toBe(6); // Second exploration after edit
    });

    it('should break chain on error messages', async () => {
      const messages: ModelMessage[] = [
        makeToolCall('glob', { pattern: '*.ts' }, 'tc-1'),
        makeToolResult('glob', 'file1.ts', 'tc-1'),
        makeToolCall('Read', { path: 'file1.ts' }, 'tc-2'),
        makeToolResult('Read', 'Error: file not found', 'tc-2'), // Error
        makeToolCall('glob', { pattern: '*.tsx' }, 'tc-3'),
        makeToolResult('glob', 'comp.tsx', 'tc-3'),
      ];

      const result = await analyzer.analyze(messages);
      // Error breaks the first chain, second part too short
      expect(result.explorationChains).toEqual([]);
    });

    it('should detect multiple separate chains', async () => {
      const messages: ModelMessage[] = [
        makeToolCall('glob', { pattern: '*.ts' }, 'tc-1'),
        makeToolResult('glob', 'file1.ts', 'tc-1'),
        makeToolCall('Read', { path: 'file1.ts' }, 'tc-2'),
        makeToolResult('Read', 'content', 'tc-2'),
        // Non-exploratory message breaks the chain
        makeAssistantMessage('Analysis done.'),
        makeToolCall('grep', { pattern: 'TODO' }, 'tc-3'),
        makeToolResult('Grep', 'todo1\ntodo2', 'tc-3'),
        makeToolCall('Grep', { pattern: 'FIXME' }, 'tc-4'),
        makeToolResult('Grep', 'fixme1', 'tc-4'),
      ];

      const result = await analyzer.analyze(messages);
      expect(result.explorationChains.length).toBe(2);
    });
  });

  describe('token estimation', () => {
    it('should use estimateTokens when available', async () => {
      const messages: ModelMessage[] = [makeUserMessage('hello')];
      const result = await analyzer.analyze(messages);
      expect(result.totalTokens).toBe(100); // mocked value
    });

    it('should fallback to character estimate on error', async () => {
      const { estimateTokens } = await import('@/services/code-navigation-service');
      (estimateTokens as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));

      const messages: ModelMessage[] = [makeUserMessage('hello world')];
      const result = await analyzer.analyze(messages);
      // Fallback: 11 chars / 4 = 3 tokens
      expect(result.totalTokens).toBe(3);
    });
  });
});
