export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function getRuntimeApiBaseUrl(): string {
  return import.meta.env.VITE_RUNTIME_API_URL || '';
}

export function getRuntimeApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const baseUrl = getRuntimeApiBaseUrl().replace(/\/$/, '');
  return `${baseUrl}${normalizedPath}`;
}

/**
 * Unified Tauri invoke adapter.
 * In Tauri mode: dynamically imports and calls @tauri-apps/api/core invoke.
 * In Web mode: throws an error (caller should handle or use isTauriRuntime() guard).
 */
export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/**
 * Unified Tauri listen adapter.
 * In Tauri mode: dynamically imports and calls @tauri-apps/api/event listen.
 * In Web mode: returns a no-op unlisten function.
 */
export async function tauriListen<T>(
  event: string,
  handler: (payload: T) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<T>(event, (e) => handler(e.payload));
  return unlisten;
}
