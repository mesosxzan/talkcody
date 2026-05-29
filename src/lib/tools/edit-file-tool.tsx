import { writeTextFile } from '@tauri-apps/plugin-fs';
import { z } from 'zod';
import { GenericToolDoing } from '@/components/tools/generic-tool-doing';
import { GenericToolResult } from '@/components/tools/generic-tool-result';
import { createTool } from '@/lib/create-tool';
import { logger } from '@/lib/logger';
import {
  isFileTooLargeForEdit,
  readFileForEdit,
  restoreLineEndings,
} from '@/lib/utils/file-encoding';
import { fileReadStateTracker } from '@/lib/utils/file-read-state';
import { findActualString, normalizeQuotes, preserveQuoteStyle } from '@/utils/text-replacement';

/**
 * Synchronous basename - extracts the filename from a path.
 */
function basename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

interface EditFileParams {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * Find all occurrences of a string in content, with optional quote normalization
 */
function findOccurrences(
  content: string,
  searchString: string,
  useNormalization: boolean
): { index: number; actualString: string }[] {
  const occurrences: { index: number; actualString: string }[] = [];

  if (content.includes(searchString)) {
    let searchFrom = 0;
    while (true) {
      const index = content.indexOf(searchString, searchFrom);
      if (index === -1) break;
      occurrences.push({ index, actualString: searchString });
      searchFrom = index + 1;
    }
  } else if (useNormalization) {
    const normalizedContent = normalizeQuotes(content);
    const normalizedSearch = normalizeQuotes(searchString);
    let searchFrom = 0;
    while (true) {
      const index = normalizedContent.indexOf(normalizedSearch, searchFrom);
      if (index === -1) break;
      // Extract actual text from original content at same position
      const actualString = content.substring(index, index + searchString.length);
      occurrences.push({ index, actualString });
      searchFrom = index + 1;
    }
  }

  return occurrences;
}

export const editFile = createTool({
  name: 'edit_file',
  description: `Performs exact string replacements in files.

Usage:
- You must use your Read tool at least once in the conversation before editing. This tool will error if you attempt to edit without reading the file first.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`,
  inputSchema: z.object({
    file_path: z.string().describe('The absolute path to the file to modify'),
    old_string: z.string().describe('The text to replace'),
    new_string: z
      .string()
      .describe('The text to replace it with (must be different from old_string)'),
    replace_all: z
      .boolean()
      .optional()
      .describe('Replace all occurrences of old_string (default false)'),
  }),
  isDestructive: true,
  canConcurrent: false, // File edits are never concurrency-safe
  renderToolDoing: ({ file_path }) => <GenericToolDoing operation="edit" filePath={file_path} />,
  renderToolResult: (result) => {
    if (result && typeof result === 'object' && 'error' in result) {
      return <GenericToolResult success={false} error={(result as { error: string }).error} />;
    }
    const output =
      result && typeof result === 'object' && 'output' in result
        ? (result as { output: string }).output
        : String(result);
    return <GenericToolResult success={true} message={output} />;
  },
  execute: async (params: EditFileParams, context) => {
    const { file_path, old_string, new_string, replace_all = false } = params;

    // Validation
    if (!file_path) {
      return { error: 'file_path is required' };
    }
    if (old_string === new_string) {
      return { error: 'old_string and new_string must be different' };
    }
    if (!old_string && !replace_all) {
      return { error: 'old_string cannot be empty (use write_file to create new files)' };
    }

    const fileName = basename(file_path);

    try {
      // Check file size before attempting edit
      const tooLarge = await isFileTooLargeForEdit(file_path);
      if (tooLarge) {
        return { error: `File ${fileName} is too large to edit safely (>1GiB)` };
      }

      // === Staleness Detection ===
      // Check if the file was modified externally since the AI last read it
      if (context?.taskId) {
        const stalenessResult = await fileReadStateTracker.checkStaleness(
          context.taskId,
          file_path
        );
        if (stalenessResult?.stale) {
          return {
            error: `File ${fileName} has been modified externally since it was last read. Please re-read the file before editing. Reason: ${stalenessResult.reason}`,
          };
        }
      }

      // === Atomic Read ===
      // Read the file with encoding detection for preservation
      const { content, encodingInfo, fileExists } = await readFileForEdit(file_path);

      if (!fileExists) {
        return {
          error: `File ${file_path} does not exist. Use write_file to create new files.`,
        };
      }

      // === Multiple Match Protection ===
      // Find all occurrences with quote normalization fallback
      const occurrences = findOccurrences(content, old_string, true);

      if (occurrences.length === 0) {
        // No match found - provide helpful error with context
        const lines = content.split('\n');
        return {
          error: `No match found for old_string in ${fileName}.\n\nThe file has ${lines.length} lines. The old_string you provided was not found. Common causes:\n1. The text was already edited in a previous tool call\n2. Whitespace/indentation doesn't match exactly (use Read tool output, not what you remember)\n3. Quote style mismatch (curly vs straight quotes)\n\nPlease use the Read tool to verify the current file content.`,
        };
      }

      // Strict uniqueness check: reject ambiguous edits
      if (occurrences.length > 1 && !replace_all) {
        const locations = occurrences
          .slice(0, 3)
          .map((o) => {
            const lineNum = content.substring(0, o.index).split('\n').length;
            return `line ${lineNum}`;
          })
          .join(', ');

        return {
          error: `Found ${occurrences.length} matches for old_string in ${fileName} (at ${locations}${occurrences.length > 3 ? '...' : ''}). The old_string must be unique unless you set replace_all to true. Provide more surrounding context to make the match unique, or use replace_all.`,
        };
      }

      // === Apply Replacement ===
      let newContent: string;
      let wasNormalized = false;

      if (replace_all) {
        // Replace all occurrences
        const firstOccurrence = occurrences[0];
        if (firstOccurrence && firstOccurrence.actualString !== old_string) {
          // Quote normalization was used
          wasNormalized = true;
        }

        // For replace_all, use the original content and replace each occurrence
        let result = content;
        // Replace from end to start to preserve indices
        for (let i = occurrences.length - 1; i >= 0; i--) {
          const occ = occurrences[i];
          if (!occ) continue;
          const before = result.substring(0, occ.index);
          const after = result.substring(occ.index + occ.actualString.length);
          let replacement = new_string;
          if (wasNormalized) {
            replacement = preserveQuoteStyle(occ.actualString, new_string);
          }
          result = before + replacement + after;
        }
        newContent = result;
      } else {
        // Single replacement
        const occurrence = occurrences[0];
        if (!occurrence) {
          return { error: 'No occurrence found for replacement' };
        }
        const before = content.substring(0, occurrence.index);
        const after = content.substring(occurrence.index + occurrence.actualString.length);

        let replacement = new_string;
        if (occurrence.actualString !== old_string) {
          // Quote normalization was used - preserve original quote style
          replacement = preserveQuoteStyle(occurrence.actualString, new_string);
          wasNormalized = true;
        }

        newContent = before + replacement + after;
      }

      // Verify the replacement actually changed something
      if (newContent === content) {
        return {
          error: 'Edit produced no changes. old_string and new_string result in the same content.',
        };
      }

      // === Restore Encoding ===
      // Restore line endings to match original file
      const contentToWrite = restoreLineEndings(newContent, encodingInfo.lineEnding);

      // === Atomic Write ===
      // Write the file, preserving encoding
      await writeTextFile(file_path, contentToWrite);

      // Update file read state to reflect our own modification
      if (context?.taskId) {
        try {
          const newStats = await import('@tauri-apps/plugin-fs').then((m) => m.stat(file_path));
          fileReadStateTracker.recordRead(
            context.taskId,
            file_path,
            newStats.mtime?.getTime() || Date.now(),
            true
          );
        } catch {
          // Non-critical: just update with current time
          fileReadStateTracker.recordRead(context.taskId, file_path, Date.now(), true);
        }
      }

      // Compute diff summary for the response
      const oldLines = content.split('\n').length;
      const newLines = newContent.split('\n').length;
      const lineDiff = newLines - oldLines;

      const editSummary = replace_all
        ? `Replaced ${occurrences.length} occurrences`
        : `Replaced 1 occurrence`;

      const encodingNote =
        encodingInfo.lineEnding !== 'lf'
          ? ` (preserved ${encodingInfo.lineEnding.toUpperCase()} line endings)`
          : '';

      const normalizationNote = wasNormalized ? ' (quote style normalized)' : '';

      return {
        output: `${editSummary} in ${fileName}${encodingNote}${normalizationNote}`,
        metadata: {
          fileName,
          occurrences: occurrences.length,
          lineDiff,
          encodingPreserved: encodingInfo.lineEnding !== 'lf' || encodingInfo.hasBOM,
        },
      };
    } catch (error) {
      logger.error(`Edit file error: ${file_path}`, error);
      return {
        error: `Failed to edit ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
