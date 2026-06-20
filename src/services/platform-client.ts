import { isTauriRuntime, tauriInvoke } from '@/lib/runtime-env';
import { postJson } from '@/lib/web-platform';
import type { FileNode } from '@/types/file-system';

export interface SearchMatch {
  line_number: number;
  line_content: string;
  byte_offset: number;
}

export interface SearchResult {
  file_path: string;
  matches: SearchMatch[];
}

export interface FileSearchResult {
  name: string;
  path: string;
  is_directory: boolean;
  score: number;
}

export interface GlobSearchResult {
  path: string;
  canonical_path: string;
  is_directory: boolean;
  modified_time: number;
}

export const platformClient = {
  buildDirectoryTree(rootPath: string, maxImmediateDepth?: number): Promise<FileNode> {
    if (isTauriRuntime()) {
      return tauriInvoke<FileNode>('build_directory_tree', { rootPath, maxImmediateDepth });
    }
    return postJson<FileNode>('/api/platform/directory-tree', { rootPath, maxImmediateDepth });
  },

  loadDirectoryChildren(dirPath: string): Promise<FileNode[]> {
    if (isTauriRuntime()) {
      return tauriInvoke<FileNode[]>('load_directory_children', { dirPath });
    }
    return postJson<FileNode[]>('/api/platform/directory-children', { dirPath });
  },

  async clearDirectoryCache(): Promise<void> {
    if (isTauriRuntime()) {
      await tauriInvoke('clear_directory_cache');
      return;
    }
    await postJson<void>('/api/platform/directory-cache/clear');
  },

  async invalidateDirectoryPath(path: string): Promise<void> {
    if (isTauriRuntime()) {
      await tauriInvoke('invalidate_directory_path', { path });
      return;
    }
    await postJson<void>('/api/platform/directory-cache/invalidate', { path });
  },

  searchFiles(rootPath: string, query: string, maxResults?: number): Promise<FileSearchResult[]> {
    if (isTauriRuntime()) {
      return tauriInvoke<FileSearchResult[]>('search_files_fast', {
        query,
        rootPath,
        maxResults,
      });
    }
    return postJson<FileSearchResult[]>('/api/platform/search-files', {
      query,
      rootPath,
      maxResults,
    });
  },

  searchFileContent(
    query: string,
    rootPath: string,
    fileTypes?: string[] | null
  ): Promise<SearchResult[]> {
    if (isTauriRuntime()) {
      return tauriInvoke<SearchResult[]>('search_file_content', { query, rootPath, fileTypes });
    }
    return postJson<SearchResult[]>('/api/platform/search-file-content', {
      query,
      rootPath,
      fileTypes,
    });
  },

  searchFilesByGlob(
    pattern: string,
    path?: string,
    maxResults?: number
  ): Promise<GlobSearchResult[]> {
    if (isTauriRuntime()) {
      return tauriInvoke<GlobSearchResult[]>('search_files_by_glob', { pattern, path, maxResults });
    }
    return postJson<GlobSearchResult[]>('/api/platform/search-files-by-glob', {
      pattern,
      path,
      maxResults,
    });
  },

  listProjectFiles(directoryPath: string, recursive?: boolean, maxDepth?: number): Promise<string> {
    if (isTauriRuntime()) {
      return tauriInvoke<string>('list_project_files', { directoryPath, recursive, maxDepth });
    }
    return postJson<string>('/api/platform/list-files', { directoryPath, recursive, maxDepth });
  },

  readTextFile(path: string): Promise<string> {
    if (isTauriRuntime()) {
      return tauriInvoke<string>('read_text_file', { path });
    }
    return postJson<string>('/api/platform/read-text-file', { path });
  },

  async writeTextFile(path: string, content: string): Promise<void> {
    if (isTauriRuntime()) {
      await tauriInvoke('write_text_file', { path, content });
      return;
    }
    await postJson<void>('/api/platform/write-text-file', { path, content });
  },

  checkFileExists(path: string): Promise<boolean> {
    if (isTauriRuntime()) {
      return tauriInvoke<boolean>('check_file_exists', { path });
    }
    return postJson<boolean>('/api/platform/check-file-exists', { path });
  },

  git<T = unknown>(command: string, args: Record<string, unknown>): Promise<T> {
    if (isTauriRuntime()) {
      return tauriInvoke<T>(command, args);
    }
    return postJson<T>('/api/platform/git', { command, args });
  },
};
