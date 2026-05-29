import type { Message as ModelMessage } from '@/services/llm/types';

/**
 * @internal Serializes model messages to plain text for AI compression input.
 * Tool calls become `[TOOL CALL: name(params)]`, results become `[TOOL RESULT: name -> output]`.
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
                return part.text || part.value || '';
              } else if (part.type === 'tool-call') {
                return `[TOOL CALL: ${part.toolName}(${JSON.stringify(part.input)})]`;
              } else if (part.type === 'tool-result') {
                return `[TOOL RESULT: ${part.toolName} -> ${JSON.stringify(part.output)}]`;
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
