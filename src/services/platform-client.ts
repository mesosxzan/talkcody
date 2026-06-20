import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '@/lib/runtime-env';
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

export const platformClient = {
  buildDirectoryTree(rootPath: string, maxImmediateDepth?: number): Promise<FileNode> {
    if (isTauriRuntime()) {
      return invoke<FileNode>('build_directory_tree', { rootPath, maxImmediateDepth });
    }
    return postJson<FileNode>('/api/platform/directory-tree', { rootPath, maxImmediateDepth });
  },

  loadDirectoryChildren(dirPath: string): Promise<FileNode[]> {
    if (isTauriRuntime()) {
      return invoke<FileNode[]>('load_directory_children', { dirPath });
    }
    return postJson<FileNode[]>('/api/platform/directory-children', { dirPath });
  },

  async clearDirectoryCache(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke('clear_directory_cache');
      return;
    }
    await postJson<void>('/api/platform/directory-cache/clear');
  },

  async invalidateDirectoryPath(path: string): Promise<void> {
    if (isTauriRuntime()) {
      await invoke('invalidate_directory_path', { path });
      return;
    }
    await postJson<void>('/api/platform/directory-cache/invalidate', { path });
  },

  searchFiles(rootPath: string, query: string, maxResults?: number): Promise<FileSearchResult[]> {
    if (isTauriRuntime()) {
      return invoke<FileSearchResult[]>('search_files_fast', {
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

  searchFileContent(query: string, rootPath: string): Promise<SearchResult[]> {
    if (isTauriRuntime()) {
      return invoke<SearchResult[]>('search_file_content', { query, rootPath });
    }
    return postJson<SearchResult[]>('/api/platform/search-file-content', { query, rootPath });
  },

  readTextFile(path: string): Promise<string> {
    if (isTauriRuntime()) {
      return invoke<string>('read_text_file', { path });
    }
    return postJson<string>('/api/platform/read-text-file', { path });
  },

  async writeTextFile(path: string, content: string): Promise<void> {
    if (isTauriRuntime()) {
      await invoke('write_text_file', { path, content });
      return;
    }
    await postJson<void>('/api/platform/write-text-file', { path, content });
  },

  checkFileExists(path: string): Promise<boolean> {
    if (isTauriRuntime()) {
      return invoke<boolean>('check_file_exists', { path });
    }
    return postJson<boolean>('/api/platform/check-file-exists', { path });
  },

  git<T = unknown>(command: string, args: Record<string, unknown>): Promise<T> {
    if (isTauriRuntime()) {
      return invoke<T>(command, args);
    }
    return postJson<T>('/api/platform/git', { command, args });
  },
};
