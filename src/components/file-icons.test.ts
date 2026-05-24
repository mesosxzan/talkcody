/**
 * Tests for file-icons configuration
 */

import { describe, expect, it } from 'vitest';
import { getFileIcon, getFolderIcon } from './file-icons';

describe('file-icons', () => {
  describe('getFileIcon', () => {
    it('should return correct icon for JavaScript files', () => {
      const result = getFileIcon('app.js');
      expect(result.color).toBe('text-yellow-500');
    });

    it('should return correct icon for TypeScript files', () => {
      const result = getFileIcon('app.ts');
      expect(result.color).toBe('text-blue-600');
    });

    it('should return correct icon for TSX files', () => {
      const result = getFileIcon('component.tsx');
      expect(result.color).toBe('text-blue-500');
    });

    it('should return correct icon for Python files', () => {
      const result = getFileIcon('script.py');
      expect(result.color).toBe('text-green-500');
    });

    it('should return correct icon for Rust files', () => {
      const result = getFileIcon('main.rs');
      expect(result.color).toBe('text-orange-600');
    });

    it('should return correct icon for JSON files', () => {
      const result = getFileIcon('data.json');
      expect(result.color).toBe('text-yellow-500');
    });

    it('should return correct icon for Markdown files', () => {
      const result = getFileIcon('README.md');
      expect(result.color).toBe('text-blue-400');
    });

    it('should return correct icon for special files - package.json', () => {
      const result = getFileIcon('package.json');
      expect(result.color).toBe('text-red-500');
    });

    it('should return correct icon for special files - tsconfig.json', () => {
      const result = getFileIcon('tsconfig.json');
      expect(result.color).toBe('text-blue-600');
    });

    it('should return correct icon for special files - .env', () => {
      const result = getFileIcon('.env');
      expect(result.color).toBe('text-yellow-500');
    });

    it('should return correct icon for special files - Cargo.toml', () => {
      const result = getFileIcon('Cargo.toml');
      expect(result.color).toBe('text-orange-600');
    });

    it('should return correct icon for test files', () => {
      const result = getFileIcon('app.test.ts');
      expect(result.color).toBe('text-green-500');
    });

    it('should return correct icon for spec files', () => {
      const result = getFileIcon('utils.spec.js');
      expect(result.color).toBe('text-green-500');
    });

    it('should return correct icon for SQL files', () => {
      const result = getFileIcon('query.sql');
      expect(result.color).toBe('text-blue-400');
    });

    it('should return default icon for unknown extensions', () => {
      const result = getFileIcon('file.unknown');
      expect(result.color).toBe('text-gray-500');
    });

    it('should return default icon for files without extension', () => {
      const result = getFileIcon('Makefile');
      expect(result.color).toBe('text-gray-500');
    });

    it('should handle case-insensitive extensions', () => {
      const result1 = getFileIcon('app.TS');
      const result2 = getFileIcon('app.ts');
      expect(result1.color).toBe(result2.color);
    });
  });

  describe('getFolderIcon', () => {
    it('should return correct icon for src folder', () => {
      const result = getFolderIcon('src', false);
      expect(result.color).toBe('text-blue-500');
    });

    it('should return correct icon for components folder', () => {
      const result = getFolderIcon('components', false);
      expect(result.color).toBe('text-purple-500');
    });

    it('should return correct icon for test folder', () => {
      const result = getFolderIcon('test', false);
      expect(result.color).toBe('text-green-500');
    });

    it('should return correct icon for node_modules folder', () => {
      const result = getFolderIcon('node_modules', false);
      expect(result.color).toBe('text-green-500');
    });

    it('should return correct icon for .git folder', () => {
      const result = getFolderIcon('.git', false);
      expect(result.color).toBe('text-orange-500');
    });

    it('should return correct icon for docs folder', () => {
      const result = getFolderIcon('docs', false);
      expect(result.color).toBe('text-blue-400');
    });

    it('should return default folder icon for unknown folders', () => {
      const result = getFolderIcon('unknown-folder', false);
      expect(result.color).toBe('text-yellow-500');
    });

    it('should return open folder icon when isOpen is true for unknown folders', () => {
      const result = getFolderIcon('unknown-folder', true);
      expect(result.color).toBe('text-yellow-500');
    });

    it('should handle case-insensitive folder names', () => {
      const result1 = getFolderIcon('SRC', false);
      const result2 = getFolderIcon('src', false);
      expect(result1.color).toBe(result2.color);
    });

    it('should return correct icon for database folder', () => {
      const result = getFolderIcon('database', false);
      expect(result.color).toBe('text-blue-500');
    });

    it('should return correct icon for migrations folder', () => {
      const result = getFolderIcon('migrations', false);
      expect(result.color).toBe('text-blue-400');
    });
  });
});
