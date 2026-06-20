/**
 * Cross-runtime path utilities.
 * In Tauri mode: dynamically imports @tauri-apps/api/path for platform-aware path handling.
 * In Web mode: uses browser-compatible path operations (simple string manipulation).
 */

import { isTauriRuntime } from '@/lib/runtime-env';

/** Check if a path is absolute */
export async function isAbsolute(path: string): Promise<boolean> {
  if (isTauriRuntime()) {
    const { isAbsolute: tauriIsAbsolute } = await import('@tauri-apps/api/path');
    return tauriIsAbsolute(path);
  }
  // Browser fallback: simple absolute path detection
  // Unix: starts with /, Windows: starts with drive letter like C:\
  return path.startsWith('/') || /^[A-Za-z]:\\/.test(path);
}

/** Join path segments */
export async function join(...paths: string[]): Promise<string> {
  if (isTauriRuntime()) {
    const { join: tauriJoin } = await import('@tauri-apps/api/path');
    return tauriJoin(...paths);
  }
  // Browser fallback: simple path joining
  return paths.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/\/$/, '');
}

/** Get the directory name of a path */
export async function dirname(path: string): Promise<string> {
  if (isTauriRuntime()) {
    const { dirname: tauriDirname } = await import('@tauri-apps/api/path');
    return tauriDirname(path);
  }
  // Browser fallback
  const normalized = path.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) return '.';
  if (lastSlash === 0) return '/';
  return normalized.substring(0, lastSlash);
}

/** Normalize a path */
export async function normalize(path: string): Promise<string> {
  if (isTauriRuntime()) {
    const { normalize: tauriNormalize } = await import('@tauri-apps/api/path');
    return tauriNormalize(path);
  }
  // Browser fallback: resolve . and ..
  const parts = path.replace(/\\/g, '/').split('/');
  const result: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      result.pop();
    } else if (part !== '.' && part !== '') {
      result.push(part);
    }
  }
  const joined = result.join('/');
  return path.startsWith('/') ? `/${joined}` : joined;
}

/** Get the base name of a path */
export async function basename(path: string, ext?: string): Promise<string> {
  if (isTauriRuntime()) {
    const { basename: tauriBasename } = await import('@tauri-apps/api/path');
    return tauriBasename(path, ext);
  }
  // Browser fallback
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  let name = segments[segments.length - 1] || '';
  if (ext && name.endsWith(ext)) {
    name = name.substring(0, name.length - ext.length);
  }
  return name;
}

/** Check if a file exists */
export async function fileExists(path: string): Promise<boolean> {
  if (isTauriRuntime()) {
    const { exists } = await import('@tauri-apps/plugin-fs');
    return exists(path);
  }
  const { platformClient } = await import('@/services/platform-client');
  return platformClient.checkFileExists(path);
}
