// src/providers/custom/custom-provider-url.ts

const CUSTOM_PROVIDER_ENDPOINT_SUFFIXES = [
  '/chat/completions',
  '/completions',
  '/responses',
  '/messages',
  '/models',
];

export function normalizeCustomProviderBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.trim();

  if (!normalized) {
    return normalized;
  }

  normalized = normalized.replace(/\/+$/, '');

  for (const suffix of CUSTOM_PROVIDER_ENDPOINT_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length).replace(/\/+$/, '');
      break;
    }
  }

  return normalized;
}
