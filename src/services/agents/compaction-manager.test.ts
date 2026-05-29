import { describe, expect, it, vi } from 'vitest';
import { CompactionManager, type CompactionResult } from './compaction-manager';
import type { LoopStoreAccess } from './loop-store-access';
import { modelTypeService } from '@/providers/models/model-type-service';

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
});
