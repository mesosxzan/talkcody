import { getRuntimeApiUrl, isTauriRuntime } from '@/lib/runtime-env';
import { simpleFetch } from '@/lib/tauri-fetch';

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await simpleFetch(getRuntimeApiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await simpleFetch(getRuntimeApiUrl(path));

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
}

export function isWebMode(): boolean {
  return !isTauriRuntime();
}

export function webModeUnsupported(feature: string): Error {
  return new Error(
    `${feature} is not available in web mode. Use the server-side path input instead.`
  );
}
