import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactionManager, type CompactionResult } from './compaction-manager';
import type { LoopStoreAccess } from './loop-store-access';
import { modelTypeService } from '../../providers/models/model-type-service';
import { taskFileService } from '../task-file-service';

// ── Mocks ────────────────────────────────────────────────────

vi.mock('@/providers/models/model-type-service', () => ({
  modelTypeService: {
    resolveModelTypeChainSync: vi.fn(() => ['gpt-4o-mini', 'claude-3-haiku']),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/locales', () => ({
  getLocale: vi.fn(() => ({
    LLMService: {
      errors: {
        contextTooLongCompactionFailed: 'Context too long, compaction failed.',
      },
    },
  })),
}));

vi.mock('@/services/context/context-compactor', () => {
  return {
    ContextCompactor: class MockContextCompactor {
      compactMessages = vi.fn();
      createCompressedMessages = vi.fn();
      validateCompressedMessages = vi.fn();
    },
  };
});

vi.mock('@/services/task-file-service', () => ({
  taskFileService: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock('@/lib/message-convert', () => ({
  convertToAnthropicFormat: vi.fn(),
}));

vi.mock('./llm-response-chaining', () => ({
  invalidateResponsesChain: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────

function createMockStoreAccess(overrides: Partial<LoopStoreAccess> = {}): LoopStoreAccess {
  return {
    getReasoningEffort: vi.fn(() => 'medium'),
    getTraceEnabled: vi.fn(() => false),
    getLanguage: vi.fn(() => 'en'),
    updateTask: vi.fn(),
    updateTaskUsage: vi.fn(),
    getMessages: vi.fn(() => []),
    isModelAvailable: vi.fn(() => true),
    getProviderModel: vi.fn(),
    getAvailableModels: vi.fn(() => []),
    getOauthConfig: vi.fn(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('CompactionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── getDefaultCompressionConfig ───────────────────────────────

  describe('getDefaultCompressionConfig', () => {
    it('returns a valid compression config', () => {
      const storeAccess = createMockStoreAccess();
      const manager = new CompactionManager('task-1', storeAccess);
      const config = manager.getDefaultCompressionConfig();

      expect(config.enabled).toBe(true);
      expect(config.preserveRecentMessages).toBe(6);
      expect(config.compressionModel).toBe('gpt-4o-mini');
      expect(config.compressionFallbackModels).toEqual(['claude-3-haiku']);
      expect(config.compressionThreshold).toBe(0.8);
    });

    it('sets compressionModel to empty string when no model is resolved', () => {
      const resolveSpy = vi.spyOn(modelTypeService, 'resolveModelTypeChainSync').mockReturnValueOnce(
        [] as unknown as ReturnType<typeof modelTypeService.resolveModelTypeChainSync>
      );

      const storeAccess = createMockStoreAccess();
      const manager = new CompactionManager('task-1', storeAccess);
      const config = manager.getDefaultCompressionConfig();

      expect(config.compressionModel).toBe('');
      expect(config.compressionFallbackModels).toEqual([]);
      resolveSpy.mockRestore();
    });
  });

  // ── handleContextLengthExceeded ───────────────────────────────

  describe('handleContextLengthExceeded', () => {
    it('returns compact when autoCompactionAttempts is 0', () => {
      const storeAccess = createMockStoreAccess();
      const manager = new CompactionManager('task-1', storeAccess);

      const result: CompactionResult = manager.handleContextLengthExceeded(0);

      expect(result.action).toBe('compact');
      if (result.action === 'compact') {
        expect(result.newAttempts).toBe(1);
      }
    });

    it('returns fail when autoCompactionAttempts is 1', () => {
      const storeAccess = createMockStoreAccess();
      const manager = new CompactionManager('task-1', storeAccess);

      const result: CompactionResult = manager.handleContextLengthExceeded(1);

      expect(result.action).toBe('fail');
      if (result.action === 'fail') {
        expect(result.errorMessage).toBe('Context too long, compaction failed.');
      }
    });

    it('returns fail for any value >= MAX_AUTO_COMPACTIONS', () => {
      const storeAccess = createMockStoreAccess();
      const manager = new CompactionManager('task-1', storeAccess);

      const result = manager.handleContextLengthExceeded(5);

      expect(result.action).toBe('fail');
    });

    it('uses storeAccess to get language for error message', () => {
      const getLanguage = vi.fn(() => 'en');
      const storeAccess = createMockStoreAccess({ getLanguage });
      const manager = new CompactionManager('task-1', storeAccess);

      // Trigger the fail path so language is accessed
      manager.handleContextLengthExceeded(1);

      expect(getLanguage).toHaveBeenCalled();
    });
  });

  describe('session memory sidecar', () => {
    it('saves session memory sidecar together with compacted messages', async () => {
      const storeAccess = createMockStoreAccess();
      const manager = new CompactionManager('task-1', storeAccess);

      await manager.saveCompactedMessages(
        [
          { role: 'system', content: 'System prompt' },
          {
            role: 'user',
            content:
              '[Previous conversation summary]\n\nThis session is continuing after context compaction. The summary below covers the earlier portion of the work.\n\n1. Primary Request and Intent:\nContinue implementing session memory\n\nResume directly from the latest active task. Treat preserved recent messages as the most current source of truth if they are more recent than the summary. Do not restart solved work or ask the user to repeat context unless the preserved messages show that clarification is still needed.',
          },
        ],
        12,
        345,
        {
          systemPrompt: 'System prompt',
        }
      );

      expect(taskFileService.writeFile).toHaveBeenCalledTimes(2);
      expect(taskFileService.writeFile).toHaveBeenNthCalledWith(
        2,
        'context',
        'task-1',
        'session-memory.json',
        expect.stringContaining('"summary":"1. Primary Request and Intent:\\nContinue implementing session memory"')
      );
    });

    it('rebuilds compacted context from session memory when main cache is unavailable', async () => {
      vi.mocked(taskFileService.readFile)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          JSON.stringify({
            summary: '1. Primary Request and Intent:\nShip the feature',
            sourceUIMessageCount: 9,
            lastRequestTokens: 777,
            systemPrompt: 'System prompt',
            updatedAt: Date.now(),
          })
        );

      const storeAccess = createMockStoreAccess();
      const manager = new CompactionManager('task-1', storeAccess);
      const result = await manager.loadCompactedMessages();

      expect(result).not.toBeNull();
      expect(result?.sourceUIMessageCount).toBe(9);
      expect(result?.lastRequestTokens).toBe(777);
      expect(result?.messages[0]).toEqual({ role: 'system', content: 'System prompt' });
      expect(result?.messages[1].content).toContain('[Previous conversation summary]');
      expect(result?.messages[1].content).toContain('Ship the feature');
      expect(result?.messages[2].content).toContain('latest active task');
    });
  });
});
