import { describe, expect, it } from 'vitest';
import type { Message, ContentPart } from '@/services/llm/types';
import { toLlmMessages } from './message-adapter';

describe('toLlmMessages', () => {
  // ── Tool messages ────────────────────────────────────────────

  describe('tool messages', () => {
    it('normalizes tool messages with tool-result content parts', () => {
      const messages: Message[] = [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'readFile',
              output: { type: 'text', value: 'file contents' },
            },
          ],
        },
      ];

      const result = toLlmMessages(messages);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('tool');

      const content = result[0].content as ContentPart[];
      expect(content).toHaveLength(1);
      expect(content[0]).toEqual({
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'readFile',
        output: { type: 'text', value: 'file contents' },
      });
    });

    it('normalizes tool messages with multiple content parts', () => {
      const messages: Message[] = [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'readFile',
              output: 'first result',
            },
            {
              type: 'tool-result',
              toolCallId: 'call-2',
              toolName: 'writeFile',
              output: 'second result',
            },
          ],
        },
      ];

      const result = toLlmMessages(messages);
      const content = result[0].content as ContentPart[];
      expect(content).toHaveLength(2);
    });

    it('preserves tool-result output as-is without stripping fields', () => {
      const messages: Message[] = [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'search',
              output: [{ file: 'a.ts' }, { file: 'b.ts' }],
            },
          ],
        },
      ];

      const result = toLlmMessages(messages);
      const content = result[0].content as ContentPart[];
      expect((content[0] as ContentPart & { type: 'tool-result' }).output).toEqual([
        { file: 'a.ts' },
        { file: 'b.ts' },
      ]);
    });
  });

  // ── Assistant messages ───────────────────────────────────────

  describe('assistant messages', () => {
    it('normalizes assistant messages with tool-call content parts', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'readFile',
              input: { file_path: 'src/index.ts' },
            },
          ],
        },
      ];

      const result = toLlmMessages(messages);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('assistant');

      const content = result[0].content as ContentPart[];
      expect(content).toHaveLength(1);
      expect(content[0]).toEqual({
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'readFile',
        input: { file_path: 'src/index.ts' },
        providerMetadata: undefined,
      });
    });

    it('normalizes assistant messages with mixed content parts', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read that file.' },
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'readFile',
              input: { file_path: 'src/index.ts' },
            },
          ],
        },
      ];

      const result = toLlmMessages(messages);
      const content = result[0].content as ContentPart[];
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: 'text', text: 'Let me read that file.' });
      expect(content[1].type).toBe('tool-call');
    });

    it('passes through assistant messages with string content', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: 'Simple response',
        },
      ];

      const result = toLlmMessages(messages);
      expect(result[0].content).toBe('Simple response');
    });

    it('preserves providerMetadata on tool-call parts', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'readFile',
              input: { path: '/tmp' },
              providerMetadata: { cache: true },
            },
          ],
        },
      ];

      const result = toLlmMessages(messages);
      const content = result[0].content as ContentPart[];
      expect((content[0] as ContentPart & { type: 'tool-call' }).providerMetadata).toEqual({
        cache: true,
      });
    });
  });

  // ── Simple text messages ─────────────────────────────────────

  describe('simple text messages', () => {
    it('passes through user text messages', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
      ];

      const result = toLlmMessages(messages);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
      expect(result[0].content).toBe('Hello');
    });

    it('passes through system text messages', () => {
      const messages: Message[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
      ];

      const result = toLlmMessages(messages);
      expect(result[0].role).toBe('system');
      expect(result[0].content).toBe('You are a helpful assistant.');
    });

    it('handles an empty messages array', () => {
      const result = toLlmMessages([]);
      expect(result).toEqual([]);
    });

    it('handles a conversation with mixed roles', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'User message' },
        { role: 'assistant', content: 'Assistant response' },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'search',
              output: 'result',
            },
          ],
        },
      ];

      const result = toLlmMessages(messages);
      expect(result).toHaveLength(4);
      expect(result[0].role).toBe('system');
      expect(result[1].role).toBe('user');
      expect(result[2].role).toBe('assistant');
      expect(result[3].role).toBe('tool');
    });
  });

  // ── providerOptions ──────────────────────────────────────────

  describe('providerOptions', () => {
    it('preserves providerOptions on messages', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: 'Hello',
          providerOptions: { temperature: 0.7 },
        },
      ];

      const result = toLlmMessages(messages);
      expect(result[0].providerOptions).toEqual({ temperature: 0.7 });
    });

    it('preserves providerOptions on tool messages', () => {
      const messages: Message[] = [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'search',
              output: 'found',
            },
          ],
          providerOptions: { cache: true },
        },
      ];

      const result = toLlmMessages(messages);
      expect(result[0].providerOptions).toEqual({ cache: true });
    });

    it('preserves providerOptions on assistant messages with content array', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello' },
          ],
          providerOptions: { model: 'gpt-4' },
        },
      ];

      const result = toLlmMessages(messages);
      expect(result[0].providerOptions).toEqual({ model: 'gpt-4' });
    });

    it('handles messages without providerOptions', () => {
      const messages: Message[] = [
        { role: 'user', content: 'No options' },
      ];

      const result = toLlmMessages(messages);
      expect(result[0].providerOptions).toBeUndefined();
    });
  });
});
