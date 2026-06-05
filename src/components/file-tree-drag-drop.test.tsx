// src/components/file-tree-drag-drop.test.tsx
/**
 * @fileoverview Tests for file tree drag and drop functionality
 * Tests the basic drag drop behavior
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileNode } from '@/types/file-system';
import { FileTree } from './file-tree';

// Mock dependencies
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn().mockResolvedValue(true),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));

vi.mock('@/services/repository-service', () => ({
  repositoryService: {
    moveFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    checkFileExists: vi.fn().mockResolvedValue(false),
    createFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/stores/git-store', () => ({
  useGitStore: vi.fn((selector) => {
    const state = {
      lastRefresh: Date.now(),
      getFileStatus: vi.fn().mockReturnValue(null),
    };
    return selector(state);
  }),
}));

vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: vi.fn((selector) => {
    const state = {
      language: 'en',
      setLanguage: vi.fn(),
    };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('FileTree Drag and Drop', () => {
  const mockFileTree: FileNode = {
    name: 'project',
    path: '/project',
    is_directory: true,
    children: [
      {
        name: 'src',
        path: '/project/src',
        is_directory: true,
        children: [
          {
            name: 'index.ts',
            path: '/project/src/index.ts',
            is_directory: false,
          },
          {
            name: 'utils',
            path: '/project/src/utils',
            is_directory: true,
            children: [
              {
                name: 'helper.ts',
                path: '/project/src/utils/helper.ts',
                is_directory: false,
              },
            ],
          },
        ],
      },
      {
        name: 'docs',
        path: '/project/docs',
        is_directory: true,
        children: [],
      },
      {
        name: 'README.md',
        path: '/project/README.md',
        is_directory: false,
      },
    ],
  };

  const defaultProps = {
    fileTree: mockFileTree,
    selectedFile: null,
    repositoryPath: '/project',
    expandedPaths: new Set(['/project', '/project/src']),
    onFileSelect: vi.fn(),
    onFileDelete: vi.fn(),
    onFileRename: vi.fn(),
    onFileCreate: vi.fn(),
    onRefresh: vi.fn(),
    onLoadChildren: vi.fn().mockResolvedValue([]),
    onToggleExpansion: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic Rendering', () => {
    it('should render file tree items as draggable', () => {
      render(<FileTree {...defaultProps} />);

      // Find draggable items
      const items = screen.getAllByRole('button');
      const draggableItems = items.filter((item) => item.draggable);

      expect(draggableItems.length).toBeGreaterThan(0);
    });

    it('should render file tree structure correctly', () => {
      render(<FileTree {...defaultProps} />);

      // Check that all visible items are rendered
      expect(screen.getAllByText('project').length).toBeGreaterThan(0);
      expect(screen.getAllByText('src').length).toBeGreaterThan(0);
      expect(screen.getAllByText('index.ts').length).toBeGreaterThan(0);
      expect(screen.getAllByText('README.md').length).toBeGreaterThan(0);
    });

    it('should have correct draggable attribute on items', () => {
      render(<FileTree {...defaultProps} />);

      // Find a file item
      const readmeItems = screen.getAllByRole('button').filter((btn) =>
        btn.textContent?.includes('README.md')
      );

      expect(readmeItems.length).toBeGreaterThan(0);
      const readmeItem = readmeItems[0];

      // Should be draggable
      expect(readmeItem.draggable).toBe(true);
    });
  });

  describe('Visual States', () => {
    it('should show selected state for selected file', () => {
      // Mock scrollIntoView
      Element.prototype.scrollIntoView = vi.fn();

      render(<FileTree {...defaultProps} selectedFile='/project/README.md' />);

      const readmeItems = screen.getAllByRole('button').filter((btn) =>
        btn.textContent?.includes('README.md')
      );

      expect(readmeItems.length).toBeGreaterThan(0);
      const readmeItem = readmeItems[0];

      // Should have selected class
      expect(readmeItem.className).toMatch(/bg-blue/);
    });
  });

  describe('Directory Structure', () => {
    it('should show directories with correct structure', () => {
      render(<FileTree {...defaultProps} />);

      // Check directories are shown
      const srcItems = screen.getAllByRole('button').filter((btn) =>
        btn.textContent?.includes('src')
      );

      expect(srcItems.length).toBeGreaterThan(0);
    });

    it('should show nested files correctly', () => {
      render(<FileTree {...defaultProps} expandedPaths={new Set(['/project', '/project/src', '/project/src/utils'])} />);

      // Check nested file is visible
      expect(screen.getAllByText('helper.ts').length).toBeGreaterThan(0);
    });
  });
});