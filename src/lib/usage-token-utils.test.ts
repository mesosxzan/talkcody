import { describe, expect, it } from 'vitest';
import { normalizeUsageTokens } from './usage-token-utils';

describe('normalizeUsageTokens', () => {
  it('normalizes snake_case usage fields', () => {
    const normalized = normalizeUsageTokens({
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      cached_tokens: 50,
    });

    expect(normalized).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1550,
      cachedInputTokens: 50,
    });
  });

  it('prefers camelCase fields when both are present', () => {
    const normalized = normalizeUsageTokens({
      inputTokens: 400,
      outputTokens: 100,
      totalTokens: 500,
      prompt_tokens: 999,
      completion_tokens: 999,
      total_tokens: 999,
    });

    expect(normalized).toEqual({
      inputTokens: 400,
      outputTokens: 100,
      totalTokens: 500,
    });
  });

  it('falls back to total_tokens when input/output are missing', () => {
    const normalized = normalizeUsageTokens({
      total_tokens: 250,
    });

    expect(normalized).toEqual({
      inputTokens: 250,
      outputTokens: 0,
      totalTokens: 250,
    });
  });

  it('uses totalUsage when usage is undefined', () => {
    const normalized = normalizeUsageTokens(undefined, {
      prompt_tokens: 90,
      completion_tokens: 10,
    });

    expect(normalized).toEqual({
      inputTokens: 90,
      outputTokens: 10,
      totalTokens: 100,
    });
  });

  it('falls back to totalUsage when primary has zero tokens', () => {
    const normalized = normalizeUsageTokens(
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      { inputTokens: 3, outputTokens: 4, totalTokens: 7 }
    );

    expect(normalized).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
    });
  });
});
