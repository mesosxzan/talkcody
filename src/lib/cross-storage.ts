/**
 * Cross-platform key-value storage.
 *
 * Tauri mode: reads/writes files in AppData via @tauri-apps/plugin-fs.
 * Web mode: uses localStorage as a lightweight fallback.
 *
 * The API mirrors a simple JSON file store — get/set/delete with a filename key.
 */

import { logger } from '@/lib/logger';
import { isTauriRuntime } from '@/lib/runtime-env';

const STORAGE_PREFIX = 'talkcody:';

async function tauriRead(filename: string): Promise<string | null> {
  const { exists } = await import('@tauri-apps/plugin-fs');
  const { BaseDirectory, readTextFile } = await import('@tauri-apps/plugin-fs');
  if (!(await exists(filename, { baseDir: BaseDirectory.AppData }))) {
    return null;
  }
  return await readTextFile(filename, { baseDir: BaseDirectory.AppData });
}

async function tauriWrite(filename: string, content: string): Promise<void> {
  const { BaseDirectory, writeTextFile } = await import('@tauri-apps/plugin-fs');
  await writeTextFile(filename, content, { baseDir: BaseDirectory.AppData });
}

function webRead(filename: string): string | null {
  return localStorage.getItem(`${STORAGE_PREFIX}${filename}`);
}

function webWrite(filename: string, content: string): void {
  localStorage.setItem(`${STORAGE_PREFIX}${filename}`, content);
}

function webDelete(filename: string): void {
  localStorage.removeItem(`${STORAGE_PREFIX}${filename}`);
}

export async function crossStorageRead(filename: string): Promise<string | null> {
  try {
    if (isTauriRuntime()) {
      return await tauriRead(filename);
    }
    return webRead(filename);
  } catch (error) {
    logger.warn(`[crossStorage] read failed for ${filename}:`, error);
    return null;
  }
}

export async function crossStorageWrite(filename: string, content: string): Promise<void> {
  try {
    if (isTauriRuntime()) {
      await tauriWrite(filename, content);
      return;
    }
    webWrite(filename, content);
  } catch (error) {
    logger.error(`[crossStorage] write failed for ${filename}:`, error);
    throw error;
  }
}

export async function crossStorageDelete(filename: string): Promise<void> {
  try {
    if (isTauriRuntime()) {
      const { BaseDirectory, remove } = await import('@tauri-apps/plugin-fs');
      await remove(filename, { baseDir: BaseDirectory.AppData });
      return;
    }
    webDelete(filename);
  } catch (error) {
    logger.warn(`[crossStorage] delete failed for ${filename}:`, error);
  }
}
