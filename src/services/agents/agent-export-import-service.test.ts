/**
 * Tests for Agent Export Service
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentDefinition } from '@/types/agent';

// Mock Tauri APIs
vi.mock('@tauri-apps/api/path', () => ({
  join: vi.fn().mockResolvedValue('/test/path/agent.md'),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import { writeTextFile } from '@tauri-apps/plugin-fs';
import { save } from '@tauri-apps/plugin-dialog';
import { exportAgentToFile } from './agent-export-import-service';

describe('AgentExportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('exportAgentToFile', () => {
    it('should export agent to Markdown file with YAML frontmatter', async () => {
      const mockAgent: AgentDefinition = {
        id: 'test-agent',
        name: 'Test Agent',
        description: 'A test agent',
        modelType: 'main_model',
        systemPrompt: 'Test prompt content',
        tools: {
          readFile: {},
          writeFile: {},
        },
        hidden: false,
        isDefault: false,
      };

      vi.mocked(save).mockResolvedValue('/test/path/test_agent.md');
      vi.mocked(writeTextFile).mockResolvedValue(undefined);

      const result = await exportAgentToFile(mockAgent);

      expect(result).toBe(true);
      expect(save).toHaveBeenCalledWith({
        defaultPath: 'Test_Agent.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      expect(writeTextFile).toHaveBeenCalled();

      // Verify the written content is valid Markdown with frontmatter
      const writtenContent = vi.mocked(writeTextFile).mock.calls[0]?.[1] as string;
      expect(writtenContent).toContain('---');
      expect(writtenContent).toContain('name: "Test Agent"');
      expect(writtenContent).toContain('description: "A test agent"');
      expect(writtenContent).toContain('model: main_model');
      expect(writtenContent).toContain('tools:');
      expect(writtenContent).toContain('- readFile');
      expect(writtenContent).toContain('- writeFile');
      expect(writtenContent).toContain('Test prompt content');
    });

    it('should export agent with role and version', async () => {
      const mockAgent: AgentDefinition = {
        id: 'test-agent',
        name: 'Test Agent',
        modelType: 'main_model',
        systemPrompt: 'Test prompt',
        role: 'write',
        canBeSubagent: false,
        version: '1.0.0',
      };

      vi.mocked(save).mockResolvedValue('/test/path/test_agent.md');
      vi.mocked(writeTextFile).mockResolvedValue(undefined);

      const result = await exportAgentToFile(mockAgent);

      expect(result).toBe(true);

      const writtenContent = vi.mocked(writeTextFile).mock.calls[0]?.[1] as string;
      expect(writtenContent).toContain('role: write');
      expect(writtenContent).toContain('canBeSubagent: false');
      expect(writtenContent).toContain('version: "1.0.0"');
    });

    it('should export agent with dynamic prompt config', async () => {
      const mockAgent: AgentDefinition = {
        id: 'test-agent',
        name: 'Test Agent',
        modelType: 'main_model',
        systemPrompt: 'Test prompt',
        dynamicPrompt: {
          enabled: true,
          providers: ['git-status', 'file-context'],
          variables: {},
        },
      };

      vi.mocked(save).mockResolvedValue('/test/path/test_agent.md');
      vi.mocked(writeTextFile).mockResolvedValue(undefined);

      const result = await exportAgentToFile(mockAgent);

      expect(result).toBe(true);

      const writtenContent = vi.mocked(writeTextFile).mock.calls[0]?.[1] as string;
      expect(writtenContent).toContain('dynamicProviders:');
      expect(writtenContent).toContain('- git-status');
      expect(writtenContent).toContain('- file-context');
    });

    it('should return false when user cancels save dialog', async () => {
      const mockAgent: AgentDefinition = {
        id: 'test-agent',
        name: 'Test Agent',
        modelType: 'main_model',
        systemPrompt: 'Test prompt',
      };

      vi.mocked(save).mockResolvedValue(null);

      const result = await exportAgentToFile(mockAgent);

      expect(result).toBe(false);
      expect(writeTextFile).not.toHaveBeenCalled();
    });

    it('should handle function-based systemPrompt', async () => {
      const mockAgent: AgentDefinition = {
        id: 'test-agent',
        name: 'Test Agent',
        modelType: 'main_model',
        systemPrompt: () => Promise.resolve('Dynamic prompt content'),
      };

      vi.mocked(save).mockResolvedValue('/test/path/test_agent.md');
      vi.mocked(writeTextFile).mockResolvedValue(undefined);

      const result = await exportAgentToFile(mockAgent);

      expect(result).toBe(true);

      const writtenContent = vi.mocked(writeTextFile).mock.calls[0]?.[1] as string;
      expect(writtenContent).toContain('Dynamic prompt content');
    });

    it('should escape special characters in YAML strings', async () => {
      const mockAgent: AgentDefinition = {
        id: 'test-agent',
        name: 'Test "Agent"',
        description: 'A test agent\nwith newlines',
        modelType: 'main_model',
        systemPrompt: 'Test prompt',
      };

      vi.mocked(save).mockResolvedValue('/test/path/test_agent.md');
      vi.mocked(writeTextFile).mockResolvedValue(undefined);

      const result = await exportAgentToFile(mockAgent);

      expect(result).toBe(true);

      const writtenContent = vi.mocked(writeTextFile).mock.calls[0]?.[1] as string;
      expect(writtenContent).toContain('name: "Test \\"Agent\\"');
      expect(writtenContent).toContain('description: "A test agent\\nwith newlines"');
    });
  });
});