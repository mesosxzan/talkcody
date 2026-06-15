import type { Message as ModelMessage } from '@/services/llm/types';

const MAX_SECTION_ITEMS = 6;
const MAX_SECTION_CHARS = 1_600;
const MAX_PATHS = 10;
const MAX_WORK_LOG_ITEMS = 8;
const MAX_SUMMARY_CHARS = 9_000;
const SESSION_MEMORY_ACCEPT_RATIO = 0.72;

export type SessionMemoryCompactionCandidate = {
  summary: string;
  estimatedTokens: number;
  compressionRatio: number;
};

function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function truncateText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function limitItems(items: string[], maxItems = MAX_SECTION_ITEMS): string[] {
  return items.filter(Boolean).slice(0, maxItems);
}

function formatSection(title: string, items: string[]): string | null {
  const limitedItems = limitItems(items);
  if (limitedItems.length === 0) {
    return null;
  }

  const body = limitedItems.map((item) => `- ${truncateText(item, 260)}`).join('\n');
  const content = truncateText(body, MAX_SECTION_CHARS);
  return `${title}:\n${content}`;
}

function extractPathHints(value: unknown, paths: Set<string>): void {
  if (paths.size >= MAX_PATHS || value == null) {
    return;
  }

  if (typeof value === 'string') {
    const matches = value.match(
      /(?:\/[\w.~/-]+(?:\/[\w.-]+)+|[A-Za-z]:\\(?:[\w. -]+\\)*[\w. -]+|(?:src|app|apps|packages|docs|tests?)\/[\w./-]+)/g
    );
    if (matches) {
      for (const match of matches) {
        if (paths.size >= MAX_PATHS) {
          break;
        }
        paths.add(match);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractPathHints(item, paths);
      if (paths.size >= MAX_PATHS) {
        break;
      }
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'path' || key === 'filePath' || key === 'file_path' || key === 'cwd') {
        extractPathHints(entry, paths);
      } else if (key === 'command' && typeof entry === 'string') {
        extractPathHints(entry, paths);
      } else if (typeof entry === 'string' && /(path|file|cwd)/i.test(key)) {
        extractPathHints(entry, paths);
      }
      if (paths.size >= MAX_PATHS) {
        break;
      }
    }
  }
}

function unwrapPreviousSummary(text: string): string {
  const marker = '[Previous conversation summary]';
  if (!text.includes(marker)) {
    return text;
  }

  const withoutPrefix = text.slice(text.indexOf(marker) + marker.length).trim();
  return withoutPrefix.replace(/Please continue from where we left off\.\s*$/i, '').trim();
}

function extractMessageText(message: ModelMessage): string {
  if (typeof message.content === 'string') {
    return truncateText(unwrapPreviousSummary(message.content), 600);
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === 'text' || part.type === 'reasoning') {
      parts.push(part.text);
      continue;
    }

    if (part.type === 'tool-call') {
      parts.push(`tool ${part.toolName}`);
      continue;
    }

    if (part.type === 'tool-result') {
      const output =
        typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? '');
      parts.push(`${part.toolName}: ${truncateText(output, 220)}`);
    }
  }

  return truncateText(parts.join(' | '), 600);
}

function isErrorLike(text: string): boolean {
  return /(error|failed|exception|traceback|enoent|eacces|503|500|timeout)/i.test(text);
}

function hasSessionMemorySignals(messages: ModelMessage[]): boolean {
  return messages.some((message) => {
    const text =
      typeof message.content === 'string' ? message.content : extractMessageText(message);

    return (
      text.includes('[Previous conversation summary]') ||
      isErrorLike(text) ||
      (Array.isArray(message.content) && message.content.length > 0)
    );
  });
}

function isCommandLike(toolName: string, input: unknown): input is { command?: string } {
  return (
    /bash|command|terminal|shell|run/i.test(toolName) && typeof input === 'object' && input !== null
  );
}

export function buildSessionMemorySummary(messages: ModelMessage[]): string {
  const previousSummaries: string[] = [];
  const taskSpecification: string[] = [];
  const currentState: string[] = [];
  const filesAndPaths = new Set<string>();
  const workflow: string[] = [];
  const errors: string[] = [];
  const keyResults: string[] = [];
  const workLog: string[] = [];

  const recentMessages = messages.slice(-8);

  for (const [index, message] of messages.entries()) {
    const rawText = typeof message.content === 'string' ? message.content : '';
    const text = extractMessageText(message);

    if (rawText.includes('[Previous conversation summary]')) {
      previousSummaries.push(truncateText(unwrapPreviousSummary(rawText), 260));
    }

    if (message.role === 'user' && text && !rawText.includes('[Previous conversation summary]')) {
      if (taskSpecification.length < 4) {
        taskSpecification.push(text);
      }
      if (recentMessages.includes(message)) {
        currentState.push(`User: ${text}`);
      }
    }

    if (message.role === 'assistant' && text) {
      if (recentMessages.includes(message)) {
        currentState.push(`Assistant: ${text}`);
      }
      if (!/tool\s+\w+/i.test(text) && keyResults.length < 4) {
        keyResults.push(text);
      }
    }

    if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'tool-result') {
          extractPathHints(part.output, filesAndPaths);

          const outputText =
            typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? '');

          if (isErrorLike(outputText)) {
            errors.push(`${part.toolName}: ${truncateText(outputText, 240)}`);
          }

          workLog.push(`Tool ${part.toolName} returned ${truncateText(outputText, 140)}`);
        }
      }
    }

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'tool-call') {
          extractPathHints(part.input, filesAndPaths);
          if (isCommandLike(part.toolName, part.input) && typeof part.input.command === 'string') {
            workflow.push(part.input.command);
          }
          workLog.push(`Assistant called ${part.toolName}`);
        }
      }
    }

    if (text && isErrorLike(text)) {
      errors.push(text);
    }

    if (index >= messages.length - MAX_WORK_LOG_ITEMS && text) {
      workLog.push(`${message.role}: ${text}`);
    }
  }

  const sections = [
    formatSection('1. Previous Summary', previousSummaries),
    formatSection('2. Task Specification', taskSpecification),
    formatSection('3. Current State', currentState),
    formatSection('4. Files and Paths', Array.from(filesAndPaths)),
    formatSection('5. Workflow', workflow),
    formatSection('6. Errors and Corrections', errors),
    formatSection('7. Key Results', keyResults),
    formatSection('8. Work Log', workLog),
  ].filter((section): section is string => Boolean(section));

  return truncateText(sections.join('\n\n'), MAX_SUMMARY_CHARS);
}

export function buildSessionMemoryCompactionCandidate(
  messagesToCompress: ModelMessage[],
  preservedMessages: ModelMessage[],
  lastTokenCount: number
): SessionMemoryCompactionCandidate | null {
  if (
    messagesToCompress.length === 0 ||
    lastTokenCount <= 0 ||
    !hasSessionMemorySignals(messagesToCompress)
  ) {
    return null;
  }

  const summary = buildSessionMemorySummary(messagesToCompress);
  if (!summary.trim()) {
    return null;
  }

  const preservedTokens = preservedMessages.reduce((sum, message) => {
    const content =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    return sum + estimateTokensFromText(content);
  }, 0);
  const estimatedTokens = estimateTokensFromText(summary) + preservedTokens;

  return {
    summary,
    estimatedTokens,
    compressionRatio: estimatedTokens / lastTokenCount,
  };
}

export function shouldUseSessionMemoryCompaction(
  candidate: SessionMemoryCompactionCandidate | null
): boolean {
  if (!candidate) {
    return false;
  }

  return candidate.compressionRatio <= SESSION_MEMORY_ACCEPT_RATIO;
}
