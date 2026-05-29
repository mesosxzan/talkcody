// src/services/agents/message-adapter.ts

/**
 * Converts UI/model messages to LLM-compatible format.
 * Replaces the toLlmMessages method from LLMService with proper type guards
 * instead of unsafe `as unknown as` casts.
 */

import type { ContentPart, Message } from '@/services/llm/types';

// ── Type guards ──────────────────────────────────────────────

function isToolCallPart(part: ContentPart): part is ContentPart & { type: 'tool-call' } {
  return part.type === 'tool-call';
}

function isToolResultPart(part: ContentPart): part is ContentPart & { type: 'tool-result' } {
  return part.type === 'tool-result';
}

function isTextPart(part: ContentPart): part is ContentPart & { type: 'text' } {
  return part.type === 'text';
}

function isReasoningPart(part: ContentPart): part is ContentPart & { type: 'reasoning' } {
  return part.type === 'reasoning';
}

function isImagePart(part: ContentPart): part is ContentPart & { type: 'image' } {
  return part.type === 'image';
}

function isVideoPart(part: ContentPart): part is ContentPart & { type: 'video' } {
  return part.type === 'video';
}

// ── Normalization ────────────────────────────────────────────

/**
 * Normalize a content part to ensure it conforms to the LLM ContentPart type.
 * This handles the conversion from loosely-typed UI content parts to the
 * strict ContentPart union type.
 */
function normalizeContentPart(part: ContentPart): ContentPart {
  if (isToolCallPart(part)) {
    return {
      type: 'tool-call',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: part.input,
      providerMetadata: part.providerMetadata ?? undefined,
    };
  }

  if (isToolResultPart(part)) {
    return {
      type: 'tool-result',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: part.output,
    };
  }

  // Text, reasoning, image, video parts are already well-formed
  if (isTextPart(part) || isReasoningPart(part) || isImagePart(part) || isVideoPart(part)) {
    return part;
  }

  // Unknown part types: preserve as-is (won't match any discriminated union branch)
  return part;
}

// ── Main conversion ─────────────────────────────────────────

/**
 * Convert an array of LLM messages to the normalized format expected by
 * the streaming API. Ensures content parts are properly typed without
 * relying on unsafe `as unknown as` casts.
 */
export function toLlmMessages(messages: Message[]): Message[] {
  return messages.map((msg) => {
    // Tool messages always have ContentPart[] as content
    if (msg.role === 'tool') {
      const content = Array.isArray(msg.content)
        ? (msg.content as ContentPart[]).map(normalizeContentPart)
        : msg.content;
      return {
        role: 'tool',
        content: content as ContentPart[],
        providerOptions: msg.providerOptions,
      } as Message;
    }

    // Assistant messages may have ContentPart[] or string content
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const content = (msg.content as ContentPart[]).map(normalizeContentPart);
      return {
        role: 'assistant',
        content,
        providerOptions: msg.providerOptions,
      } as Message;
    }

    // User and system messages: content may be string or ContentPart[]
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const content = (msg.content as ContentPart[]).map(normalizeContentPart);
      return {
        role: msg.role,
        content,
        providerOptions: msg.providerOptions,
      } as Message;
    }

    // Default: pass through with role and content normalized
    return {
      role: msg.role,
      content: Array.isArray(msg.content)
        ? (msg.content as ContentPart[]).map(normalizeContentPart)
        : msg.content,
      providerOptions: msg.providerOptions,
    } as Message;
  });
}
