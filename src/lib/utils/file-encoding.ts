/**
 * File encoding detection and preservation utilities.
 * Handles UTF-8, UTF-16LE (with BOM), and line ending preservation.
 */

import { readFile as readFileBytes, stat } from '@tauri-apps/plugin-fs';
import { logger } from '@/lib/logger';

export type FileEncoding = 'utf-8' | 'utf-16le';
export type LineEnding = 'lf' | 'crlf' | 'cr';

export interface FileEncodingInfo {
  encoding: FileEncoding;
  lineEnding: LineEnding;
  hasBOM: boolean;
}

/**
 * Detect file encoding by reading the BOM (Byte Order Mark) from raw bytes.
 * UTF-16LE BOM: FF FE
 * UTF-8 BOM: EF BB BF (we treat this as UTF-8 since it's the same encoding)
 */
export function detectEncoding(firstBytes: Uint8Array): FileEncodingInfo {
  // Check for UTF-16LE BOM
  if (firstBytes.length >= 2 && firstBytes[0] === 0xff && firstBytes[1] === 0xfe) {
    return { encoding: 'utf-16le', lineEnding: 'lf', hasBOM: true };
  }

  // Default to UTF-8
  const hasBOM =
    firstBytes.length >= 3 &&
    firstBytes[0] === 0xef &&
    firstBytes[1] === 0xbb &&
    firstBytes[2] === 0xbf;

  return { encoding: 'utf-8', lineEnding: 'lf', hasBOM };
}

/**
 * Detect line ending style from content
 */
export function detectLineEnding(content: string): LineEnding {
  const crlfIndex = content.indexOf('\r\n');
  if (crlfIndex !== -1) return 'crlf';

  const crIndex = content.indexOf('\r');
  if (crIndex !== -1) return 'cr';

  return 'lf';
}

/**
 * Read a file with encoding detection.
 * Returns the content as a string (always normalized to LF line endings internally),
 * plus the detected encoding info for write-back preservation.
 */
export async function readFileForEdit(filePath: string): Promise<{
  content: string;
  encodingInfo: FileEncodingInfo;
  modifiedTime: number;
  fileExists: boolean;
}> {
  try {
    const fileStats = await stat(filePath);
    const modifiedTime = fileStats.mtime?.getTime() || 0;

    // Read raw bytes for encoding detection
    const bytes = await readFileBytes(filePath);
    const firstBytes = new Uint8Array(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 4));
    const encodingInfo = detectEncoding(firstBytes);

    // For UTF-16LE, decode manually
    let content: string;
    if (encodingInfo.encoding === 'utf-16le') {
      const decoder = new TextDecoder('utf-16le');
      content = decoder.decode(bytes);
      // Skip BOM character if present
      if (content.charCodeAt(0) === 0xfeff) {
        content = content.substring(1);
      }
    } else {
      // UTF-8 - use TextDecoder
      const decoder = new TextDecoder('utf-8');
      content = decoder.decode(bytes);
      // Skip UTF-8 BOM if present
      if (content.charCodeAt(0) === 0xfeff) {
        content = content.substring(1);
      }
    }

    // Detect line endings before normalization
    encodingInfo.lineEnding = detectLineEnding(content);

    // Normalize to LF internally for consistent editing
    content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    return { content, encodingInfo, modifiedTime, fileExists: true };
  } catch (error) {
    logger.error(`Failed to read file for edit: ${filePath}`, error);
    return {
      content: '',
      encodingInfo: { encoding: 'utf-8', lineEnding: 'lf', hasBOM: false },
      modifiedTime: 0,
      fileExists: false,
    };
  }
}

/**
 * Restore line endings to the original style before writing back to disk.
 */
export function restoreLineEndings(content: string, lineEnding: LineEnding): string {
  if (lineEnding === 'crlf') {
    return content.replace(/\n/g, '\r\n');
  }
  if (lineEnding === 'cr') {
    return content.replace(/\n/g, '\r');
  }
  return content; // LF - no change needed
}

/**
 * Maximum file size for editing (1 GiB) to prevent OOM
 */
export const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024;

/**
 * Check if a file exceeds the maximum edit size
 */
export async function isFileTooLargeForEdit(filePath: string): Promise<boolean> {
  try {
    const fileStats = await stat(filePath);
    return (fileStats.size ?? 0) > MAX_EDIT_FILE_SIZE;
  } catch {
    return false;
  }
}
