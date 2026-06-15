import { describe, expect, it } from 'vitest';

import type { Message } from '../llm/types';
import {
  buildSessionMemoryCompactionCandidate,
  buildSessionMemorySummary,
  shouldUseSessionMemoryCompaction,
} from './session-memory-compaction';

describe('session-memory-compaction', () => {
  it('builds a structured local session memory summary from mixed messages', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: 'Please fix the context compaction pipeline for long coding sessions.',
      },
      {
        role: 'assistant',
        content:
          '[Previous conversation summary]\n\n1. Current Work: Compression retries landed.\n2. Pending Tasks: Add session memory.\n\nPlease continue from where we left off.',
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'readFile',
            input: { path: 'src/services/context/context-compactor.ts' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-1',
            toolName: 'readFile',
            output: 'Loaded src/services/context/context-compactor.ts successfully.',
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-2',
            toolName: 'bash',
            input: { command: 'bun run test:file src/services/context/context-compactor.test.ts' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-2',
            toolName: 'bash',
            output: 'Error: HTTP 503 service unavailable while compacting context',
          },
        ],
      },
      {
        role: 'assistant',
        content: 'I will add a local session memory fallback and retry logic next.',
      },
    ];

    const summary = buildSessionMemorySummary(messages);

    expect(summary).toContain('1. Previous Summary');
    expect(summary).toContain('2. Task Specification');
    expect(summary).toContain('3. Current State');
    expect(summary).toContain('4. Files and Paths');
    expect(summary).toContain('5. Workflow');
    expect(summary).toContain('6. Errors and Corrections');
    expect(summary).toContain('src/services/context/context-compactor.ts');
    expect(summary).toContain('bun run test:file');
    expect(summary).toContain('503 service unavailable');
  });

  it('accepts local session memory compaction when it is well below the token budget', () => {
    const messagesToCompress: Message[] = [
      {
        role: 'user',
        content:
          'Implement a session memory compaction layer that preserves task state, files, workflow, and errors.',
      },
      {
        role: 'assistant',
        content:
          '[Previous conversation summary]\n\n1. Current Work: Added compaction retries.\n2. Pending Tasks: Add session memory.\n\nPlease continue from where we left off.',
      },
      {
        role: 'assistant',
        content: 'I am wiring the new summary path into the compactor now.',
      },
    ];

    const candidate = buildSessionMemoryCompactionCandidate(messagesToCompress, [], 4_000);

    expect(candidate).not.toBeNull();
    expect(candidate?.compressionRatio).toBeLessThan(0.72);
    expect(shouldUseSessionMemoryCompaction(candidate)).toBe(true);
  });
});
