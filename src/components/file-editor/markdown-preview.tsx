import { open } from '@tauri-apps/plugin-shell';
import mermaid from 'mermaid';
import {
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import MemoizedCodeBlock from '@/components/chat/code-block';
import { ScrollArea } from '@/components/ui/scroll-area';
import '@/styles/highlight.css';
import { useTheme } from '@/hooks/use-theme';

function getCodeText(value: ReactNode): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(getCodeText).join('');
  if (isValidElement(value)) {
    const element = value as ReactElement<{ children?: ReactNode }>;
    return getCodeText(element.props.children ?? '');
  }
  return '';
}

function MermaidBlock({ chart, fallback }: { chart: string; fallback: React.ReactNode }) {
  const { resolvedTheme } = useTheme();
  const id = useId();
  const renderId = useMemo(() => `mermaid-${id}`, [id]);
  const [svg, setSvg] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          fontFamily: 'inherit',
          theme: resolvedTheme === 'dark' ? 'dark' : 'default',
        });

        const result = await mermaid.render(renderId, chart);
        if (!cancelled) setSvg(result.svg);
      } catch {
        if (!cancelled) setSvg(null);
      }
    };

    setSvg(null);
    render();

    return () => {
      cancelled = true;
    };
  }, [chart, renderId, resolvedTheme]);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = svg ?? '';
  }, [svg]);

  if (!svg) return <>{fallback}</>;

  return (
    <div ref={containerRef} className="my-4 overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full" />
  );
}

interface MarkdownPreviewProps {
  content: string;
  className?: string;
}

function MarkdownPreview({ content, className }: MarkdownPreviewProps) {
  return (
    <ScrollArea className={className}>
      <div className="prose prose-sm dark:prose-invert max-w-none p-6">
        <ReactMarkdown
          components={{
            // Open external links in default browser
            a: ({ href, children, ...props }) => (
              <a
                href={href}
                onClick={(e) => {
                  if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
                    e.preventDefault();
                    open(href);
                  }
                }}
                className="text-primary hover:underline"
                {...props}
              >
                {children}
              </a>
            ),
            p: ({ ...props }) => <p dir="auto" {...props} />,
            li: ({ ...props }) => <li dir="auto" {...props} />,
            pre: ({ children, ...props }) => (
              <MemoizedCodeBlock {...props}>{children}</MemoizedCodeBlock>
            ),
            code: ({ className, children, ...props }) => {
              const language = className?.replace('language-', '') ?? '';
              if (language === 'mermaid') {
                const chart = getCodeText(children).trim();
                return (
                  <MermaidBlock
                    chart={chart}
                    fallback={
                      <code className={className} {...props}>
                        {children}
                      </code>
                    }
                  />
                );
              }
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            },
            // Theme-aware table styling
            table: ({ ...props }) => (
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse border border-border" {...props} />
              </div>
            ),
            th: ({ ...props }) => (
              <th
                className="border border-border bg-muted/50 px-4 py-2 text-left font-medium"
                {...props}
              />
            ),
            td: ({ ...props }) => <td className="border border-border px-4 py-2" {...props} />,
            // Theme-aware blockquote
            blockquote: ({ ...props }) => (
              <blockquote
                className="border-muted-foreground/30 border-l-4 pl-4 text-muted-foreground italic"
                {...props}
              />
            ),
            // Theme-aware horizontal rule
            hr: ({ ...props }) => <hr className="my-6 border-border" {...props} />,
            // Headings with proper styling
            h1: ({ ...props }) => <h1 className="mb-4 mt-6 text-3xl font-bold" {...props} />,
            h2: ({ ...props }) => <h2 className="mb-3 mt-5 text-2xl font-bold" {...props} />,
            h3: ({ ...props }) => <h3 className="mb-2 mt-4 text-xl font-semibold" {...props} />,
            h4: ({ ...props }) => <h4 className="mb-2 mt-3 text-lg font-semibold" {...props} />,
            // Lists
            ul: ({ ...props }) => <ul className="my-2 ml-6 list-disc" {...props} />,
            ol: ({ ...props }) => <ol className="my-2 ml-6 list-decimal" {...props} />,
          }}
          rehypePlugins={[
            [
              rehypeHighlight as never,
              {
                detect: false,
                ignoreMissing: true,
              },
            ],
          ]}
          remarkPlugins={[remarkGfm]}
        >
          {content}
        </ReactMarkdown>
      </div>
    </ScrollArea>
  );
}

export default memo(MarkdownPreview);
