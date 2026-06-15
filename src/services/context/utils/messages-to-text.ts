import type { Message as ModelMessage } from '@/services/llm/types';

const MAX_TEXT_PART_LENGTH = 3_000;
const MAX_REASONING_LENGTH = 1_500;
const MAX_TOOL_INPUT_LENGTH = 1_200;
const MAX_TOOL_RESULT_LENGTH = 1_600;
const MAX_ARRAY_ITEMS = 8;
const MAX_OBJECT_KEYS = 20;
const MAX_SERIALIZATION_DEPTH = 3;

function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const ellipsis = `\n...[truncated ${text.length - maxLength} chars]...\n`;
  const available = Math.max(0, maxLength - ellipsis.length);
  const headLength = Math.ceil(available * 0.7);
  const tailLength = Math.max(0, available - headLength);

  return `${text.slice(0, headLength)}${ellipsis}${text.slice(-tailLength)}`;
}

function summarizeValueForCompaction(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return truncateMiddle(value, MAX_TOOL_RESULT_LENGTH);
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (depth >= MAX_SERIALIZATION_DEPTH) {
    if (Array.isArray(value)) {
      return `[Array(${value.length}) truncated]`;
    }

    const keyCount = Object.keys(value).length;
    return `[Object(${keyCount} keys) truncated]`;
  }

  if (Array.isArray(value)) {
    const summarizedItems = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => summarizeValueForCompaction(item, depth + 1));

    if (value.length > MAX_ARRAY_ITEMS) {
      summarizedItems.push(`[${value.length - MAX_ARRAY_ITEMS} more items truncated]`);
    }

    return summarizedItems;
  }

  const entries = Object.entries(value);
  const summarizedObject: Record<string, unknown> = {};

  for (const [key, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
    summarizedObject[key] = summarizeValueForCompaction(entryValue, depth + 1);
  }

  if (entries.length > MAX_OBJECT_KEYS) {
    summarizedObject.__truncatedKeys = `${entries.length - MAX_OBJECT_KEYS} more keys truncated`;
  }

  return summarizedObject;
}

function serializeForCompaction(value: unknown, maxLength: number): string {
  const serialized =
    typeof value === 'string'
      ? value
      : (JSON.stringify(summarizeValueForCompaction(value), null, 2) ?? String(value));

  return truncateMiddle(serialized, maxLength);
}

/**
 * @internal Serializes model messages to plain text for AI compression input.
 * Tool calls become `[TOOL CALL: name(params)]`, results become `[TOOL RESULT: name -> output]`.
 * Reasoning blocks become `[REASONING: text]` (thinking content is included for context).
 */
export function messagesToText(messages: ModelMessage[]): string {
  return messages
    .map((msg) => {
      const role = msg.role.toUpperCase();
      let content = '';

      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .map(
            (part: {
              type: string;
              text?: string;
              value?: string;
              toolName?: string;
              input?: unknown;
              output?: unknown;
            }) => {
              if (part.type === 'text') {
                return truncateMiddle(part.text || part.value || '', MAX_TEXT_PART_LENGTH);
              } else if (part.type === 'reasoning') {
                // Include reasoning/thinking content for context preservation
                return `[REASONING: ${truncateMiddle(part.text || '', MAX_REASONING_LENGTH)}]`;
              } else if (part.type === 'tool-call') {
                return `[TOOL CALL: ${part.toolName}(${serializeForCompaction(part.input, MAX_TOOL_INPUT_LENGTH)})]`;
              } else if (part.type === 'tool-result') {
                return `[TOOL RESULT: ${part.toolName} -> ${serializeForCompaction(part.output, MAX_TOOL_RESULT_LENGTH)}]`;
              }
              return '';
            }
          )
          .join('\n');
      }

      return `${role}: ${content}`;
    })
    .join('\n\n');
}
