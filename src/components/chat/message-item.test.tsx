import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { UIMessage } from '@/types/agent';
import { MessageItem } from './message-item';

vi.mock('@/hooks/use-locale', () => ({
  useLocale: () => ({
    t: {
      Chat: {
        reasoning: {
          title: 'Reasoning',
        },
      },
    },
  }),
}));

vi.mock('@/components/chat/file-preview', () => ({
  FilePreview: () => null,
}));

vi.mock('@/components/tools/tool-error-boundary', () => ({
  ToolErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/components/tools/tool-error-fallback', () => ({
  ToolErrorFallback: () => null,
}));

vi.mock('@/components/tools/unified-tool-result', () => ({
  UnifiedToolResult: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/lib/tool-adapter', () => ({
  getToolUIRenderers: () => null,
}));

vi.mock('../ai-elements/actions', () => ({
  Action: ({ children }: { children: ReactNode }) => children,
  Actions: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('./my-markdown', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('./web-content-renderer', () => ({
  WebContentRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

function createAssistantMessage(overrides: Partial<UIMessage> = {}): UIMessage {
  return {
    id: 'assistant-message',
    role: 'assistant',
    content: 'Final answer',
    timestamp: new Date('2026-05-05T00:00:00.000Z'),
    isStreaming: true,
    reasoningContent: 'Step 1\nStep 2',
    isReasoningStreaming: true,
    ...overrides,
  };
}

describe('MessageItem reasoning UI', () => {
  it('shows reasoning content while reasoning is still streaming', () => {
    render(<MessageItem message={createAssistantMessage()} />);

    expect(screen.getByRole('button', { name: 'Reasoning' })).toBeInTheDocument();
    expect(screen.getByText('Step 1 Step 2', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Final answer')).toBeInTheDocument();
  });

  it('auto-collapses after reasoning ends and can be expanded again manually', () => {
    const { rerender } = render(<MessageItem message={createAssistantMessage()} />);

    expect(screen.getByText('Step 1 Step 2', { exact: false })).toBeInTheDocument();

    rerender(
      <MessageItem
        message={createAssistantMessage({
          isReasoningStreaming: false,
          content: 'Final answer while still streaming',
        })}
      />
    );

    expect(screen.queryByText('Step 1 Step 2', { exact: false })).not.toBeInTheDocument();
    expect(screen.getByText('Final answer while still streaming')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reasoning' }));

    expect(screen.getByText('Step 1 Step 2', { exact: false })).toBeInTheDocument();
  });
});
