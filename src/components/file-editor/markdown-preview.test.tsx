import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MarkdownPreview from './markdown-preview';

// Mock Tauri shell plugin
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(),
}));

// Mock mermaid
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
  },
}));

// Mock theme hook
vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({
    resolvedTheme: 'light',
  }),
}));

// Mock code block component
vi.mock('@/components/chat/code-block', () => ({
  default: ({ children }: { children: React.ReactNode }) => <pre>{children}</pre>,
}));

describe('MarkdownPreview', () => {
  it('should render markdown content correctly', () => {
    const content = '# Hello World\n\nThis is **bold** text.';
    render(<MarkdownPreview content={content} />);

    expect(screen.getByText('Hello World')).toBeInTheDocument();
    expect(screen.getByText(/bold/)).toBeInTheDocument();
  });

  it('should render lists correctly', () => {
    const content = '- Item 1\n- Item 2\n- Item 3';
    render(<MarkdownPreview content={content} />);

    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Item 2')).toBeInTheDocument();
    expect(screen.getByText('Item 3')).toBeInTheDocument();
  });

  it('should render code blocks with language', () => {
    const content = '```typescript\nconst x = 1;\n```';
    const { container } = render(<MarkdownPreview content={content} />);

    // Check that the code block contains the expected content
    const codeElement = container.querySelector('code.language-typescript');
    expect(codeElement).toBeInTheDocument();
    expect(codeElement?.textContent).toContain('const');
    expect(codeElement?.textContent).toContain('x = 1');
  });

  it('should render links correctly', () => {
    const content = '[Example Link](https://example.com)';
    render(<MarkdownPreview content={content} />);

    const link = screen.getByText('Example Link');
    expect(link).toBeInTheDocument();
    expect(link.closest('a')).toHaveAttribute('href', 'https://example.com');
  });

  it('should render blockquotes correctly', () => {
    const content = '> This is a quote';
    render(<MarkdownPreview content={content} />);

    expect(screen.getByText('This is a quote')).toBeInTheDocument();
  });

  it('should render tables correctly', () => {
    const content = `
| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |
`;
    render(<MarkdownPreview content={content} />);

    expect(screen.getByText('Header 1')).toBeInTheDocument();
    expect(screen.getByText('Header 2')).toBeInTheDocument();
    expect(screen.getByText('Cell 1')).toBeInTheDocument();
    expect(screen.getByText('Cell 2')).toBeInTheDocument();
  });

  it('should render inline code correctly', () => {
    const content = 'This is `inline code` in a paragraph.';
    render(<MarkdownPreview content={content} />);

    expect(screen.getByText(/inline code/)).toBeInTheDocument();
  });

  it('should apply custom className', () => {
    const content = '# Test';
    const { container } = render(<MarkdownPreview content={content} className="custom-class" />);

    expect(container.querySelector('.custom-class')).toBeInTheDocument();
  });

  it('should render GFM features like task lists', () => {
    const content = '- [x] Task 1\n- [ ] Task 2';
    render(<MarkdownPreview content={content} />);

    expect(screen.getByText('Task 1')).toBeInTheDocument();
    expect(screen.getByText('Task 2')).toBeInTheDocument();
  });

  it('should render headings with proper hierarchy', () => {
    const content = '# H1\n## H2\n### H3\n#### H4';
    render(<MarkdownPreview content={content} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('H1');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('H2');
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('H3');
    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent('H4');
  });
});
