import { describe, expect, it } from 'vitest';

import type { Message } from '@/services/llm/types';
import { messagesToText } from './messages-to-text';

describe('messagesToText', () => {
  it('truncates oversized tool results before serializing compaction input', () => {
    const hugeOutput = `line-${'x'.repeat(5_000)}`;
    const messages: Message[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-1',
            toolName: 'readFile',
            output: hugeOutput,
          },
        ],
      },
    ];

    const serialized = messagesToText(messages);

    expect(serialized).toContain('[TOOL RESULT: readFile ->');
    expect(serialized).toContain('[truncated ');
    expect(serialized.length).toBeLessThan(2_200);
  });

  it('summarizes deeply nested arrays and objects to keep payload bounded', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-2',
            toolName: 'searchCode',
            input: {
              query: 'find all retries',
              files: Array.from({ length: 20 }, (_, index) => `/tmp/file-${index}.ts`),
              metadata: {
                a: { value: '1' },
                b: { value: '2' },
                c: { value: '3' },
                d: { value: '4' },
                e: { value: '5' },
                f: { value: '6' },
                g: { value: '7' },
                h: { value: '8' },
                i: { value: '9' },
                j: { value: '10' },
                k: { value: '11' },
                l: { value: '12' },
                m: { value: '13' },
                n: { value: '14' },
                o: { value: '15' },
                p: { value: '16' },
                q: { value: '17' },
                r: { value: '18' },
                s: { value: '19' },
                t: { value: '20' },
                u: { value: '21' },
              },
            },
          },
        ],
      },
    ];

    const serialized = messagesToText(messages);

    expect(serialized).toContain('[TOOL CALL: searchCode(');
    expect(serialized).toContain('more items truncated');
    expect(serialized).toContain('__truncatedKeys');
    expect(serialized.length).toBeLessThan(2_000);
  });
});
