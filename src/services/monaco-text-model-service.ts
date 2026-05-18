import { readTextFile } from '@tauri-apps/plugin-fs';
import type * as Monaco from 'monaco-editor';
import { logger } from '@/lib/logger';
import { repositoryService } from './repository-service';

/**
 * Normalize a file path from Monaco URI for cross-platform compatibility
 * Handles Windows paths that may have leading slash before drive letter
 * e.g., "/C:/Users/file.txt" -> "C:/Users/file.txt"
 */
function normalizeFilePathFromUri(uriPath: string): string {
  // On Windows, Monaco URI paths may have format like "/C:/path" or "C:/path"
  // We need to normalize to the actual file system path format

  // Check for Windows drive letter pattern with leading slash
  if (/^\/[a-zA-Z]:\//.test(uriPath)) {
    // Remove the leading slash: "/C:/path" -> "C:/path"
    return uriPath.substring(1);
  }

  // For Unix paths or already normalized Windows paths, return as-is
  return uriPath;
}

/**
 * Creates a custom textModelService that allows Monaco's peek widget
 * to resolve models across different files.
 *
 * This is required because Monaco Editor standalone mode's default
 * textModelService cannot find models by URI, which breaks peek
 * references and peek definition for cross-file navigation.
 *
 * See: https://github.com/microsoft/monaco-editor/issues/935
 */
export function createTextModelService(monaco: typeof Monaco) {
  return {
    createModelReference: async (uri: Monaco.Uri) => {
      logger.info('[TextModelService] createModelReference called for:', uri.toString());

      let model = monaco.editor.getModel(uri);

      // If model doesn't exist, try to create it from file
      if (!model) {
        try {
          const rawPath = uri.path;
          const filePath = normalizeFilePathFromUri(rawPath);
          logger.info(
            '[TextModelService] Model not found, loading from file:',
            filePath,
            '(raw:',
            rawPath,
            ')'
          );

          const content = await readTextFile(filePath);
          const fileName = repositoryService.getFileNameFromPath(filePath);
          const language = repositoryService.getLanguageFromExtension(fileName);

          model = monaco.editor.createModel(content, language, uri);
          logger.info('[TextModelService] Created model for:', filePath, 'language:', language);
        } catch (error) {
          logger.error('[TextModelService] Failed to load model for:', uri.toString(), error);
          throw new Error(`Cannot load model for ${uri.toString()}`);
        }
      } else {
        logger.info('[TextModelService] Found existing model for:', uri.toString());
      }

      return {
        object: {
          textEditorModel: model,
        },
        dispose: () => {
          // Don't dispose the model here - it may be reused
        },
      };
    },
  };
}
