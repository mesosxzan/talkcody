import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentLoopState, ResponsesChainState } from '@/types/agent';
import { ResponsesChainManager } from './responses-chain-manager';

// ── Mocks ────────────────────────────────────────────────────

const mockApplyTransportFallbackEvent = vi.fn();
const mockApplyResponseMetadataEvent = vi.fn(() => true);
const mockCommitResponsesChainBaseline = vi.fn();

vi.mock('./llm-response-chaining', () => ({
  applyTransportFallbackEvent: (...args: unknown[]) => mockApplyTransportFallbackEvent(...args),
  applyResponseMetadataEvent: (...args: unknown[]) => mockApplyResponseMetadataEvent(...args),
  commitResponsesChainBaseline: (...args: unknown[]) => mockCommitResponsesChainBaseline(...args),
}));

const mockCloseResponsesSession = vi.fn();

vi.mock('@/services/llm/llm-client', () => ({
  llmClient: {
    closeResponsesSession: (...args: unknown[]) => mockCloseResponsesSession(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Helpers ──────────────────────────────────────────────────

function createLoopState(overrides: Partial<AgentLoopState> = {}): AgentLoopState {
  return {
    messages: [],
    currentIteration: 0,
    isComplete: false,
    lastRequestTokens: 0,
    ...overrides,
  };
}

function createResponsesChainState(
  overrides: Partial<ResponsesChainState> = {}
): ResponsesChainState {
  return {
    enabled: true,
    provider: 'openai-subscription',
    transportPreference: 'auto',
    transportSessionId: 'session-123',
    baselineMessageCount: 0,
    fallbackCount: 0,
    broken: false,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('ResponsesChainManager', () => {
  let manager: ResponsesChainManager;

  beforeEach(() => {
    manager = new ResponsesChainManager();
    vi.clearAllMocks();
  });

  // ── finalizeResponsesChainTurn ────────────────────────────────

  describe('finalizeResponsesChainTurn', () => {
    it('applies transport fallback when event is provided', () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState(),
      });
      const transportFallbackEvent = {
        type: 'transport-fallback' as const,
        reason: 'timeout',
        from: 'websocket' as const,
        to: 'http-sse' as const,
      };

      manager.finalizeResponsesChainTurn(loopState, null, transportFallbackEvent, false, 5);

      expect(mockApplyTransportFallbackEvent).toHaveBeenCalledWith(loopState, transportFallbackEvent);
    });

    it('does not apply transport fallback when event is null', () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState(),
      });

      manager.finalizeResponsesChainTurn(loopState, null, null, false, 5);

      expect(mockApplyTransportFallbackEvent).not.toHaveBeenCalled();
    });

    it('applies response metadata when not falling back to stateless and event exists', () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState(),
      });
      const responseMetadataEvent = {
        type: 'response-metadata' as const,
        responseId: 'resp-1',
        provider: 'openai-subscription',
        transport: 'websocket' as const,
        continuationAccepted: true,
      };

      manager.finalizeResponsesChainTurn(loopState, responseMetadataEvent, null, false, 3);

      expect(mockApplyResponseMetadataEvent).toHaveBeenCalledWith(loopState, responseMetadataEvent);
    });

    it('does not apply response metadata when didFallbackToStateless is true', () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState(),
      });
      const responseMetadataEvent = {
        type: 'response-metadata' as const,
        responseId: 'resp-1',
        provider: 'openai-subscription',
        transport: 'websocket' as const,
        continuationAccepted: true,
      };

      manager.finalizeResponsesChainTurn(loopState, responseMetadataEvent, null, true, 3);

      expect(mockApplyResponseMetadataEvent).not.toHaveBeenCalled();
    });

    it('does not apply response metadata when event is null', () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState(),
      });

      manager.finalizeResponsesChainTurn(loopState, null, null, false, 3);

      expect(mockApplyResponseMetadataEvent).not.toHaveBeenCalled();
    });

    it('commits baseline with correct parameters', () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState(),
      });
      const responseMetadataEvent = {
        type: 'response-metadata' as const,
        responseId: 'resp-1',
        provider: 'openai-subscription',
        transport: 'websocket' as const,
        continuationAccepted: true,
      };

      mockApplyResponseMetadataEvent.mockReturnValueOnce(true);

      manager.finalizeResponsesChainTurn(loopState, responseMetadataEvent, null, false, 10);

      // shouldCommitResponseMetadataBaseline = !didFallbackToStateless && didApplyResponseMetadata && !broken
      expect(mockCommitResponsesChainBaseline).toHaveBeenCalledWith(loopState, true, 10);
    });

    it('does not commit metadata baseline when chain is broken', () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState({ broken: true }),
      });
      const responseMetadataEvent = {
        type: 'response-metadata' as const,
        responseId: 'resp-1',
        provider: 'openai-subscription',
        transport: 'websocket' as const,
        continuationAccepted: true,
      };

      mockApplyResponseMetadataEvent.mockReturnValueOnce(true);

      manager.finalizeResponsesChainTurn(loopState, responseMetadataEvent, null, false, 5);

      // shouldCommitResponseMetadataBaseline = shouldApply && didApply && !broken => false
      expect(mockCommitResponsesChainBaseline).toHaveBeenCalledWith(loopState, false, 5);
    });
  });

  // ── closeResponsesChainSession ────────────────────────────────

  describe('closeResponsesChainSession', () => {
    it('calls llmClient.closeResponsesSession with the sessionId override', async () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState({ transportSessionId: 'state-session' }),
      });

      await manager.closeResponsesChainSession(loopState, 'override-session');

      expect(mockCloseResponsesSession).toHaveBeenCalledWith('override-session');
    });

    it('falls back to loopState transportSessionId when no override', async () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState({ transportSessionId: 'state-session' }),
      });

      await manager.closeResponsesChainSession(loopState);

      expect(mockCloseResponsesSession).toHaveBeenCalledWith('state-session');
    });

    it('does nothing when no sessionId is available', async () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState({ transportSessionId: undefined }),
      });

      await manager.closeResponsesChainSession(loopState);

      expect(mockCloseResponsesSession).not.toHaveBeenCalled();
    });

    it('does nothing when loopState is null', async () => {
      await manager.closeResponsesChainSession(null);

      expect(mockCloseResponsesSession).not.toHaveBeenCalled();
    });

    it('does nothing when loopState is undefined', async () => {
      await manager.closeResponsesChainSession(undefined);

      expect(mockCloseResponsesSession).not.toHaveBeenCalled();
    });

    it('does nothing when sessionId is empty or whitespace', async () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState({ transportSessionId: '   ' }),
      });

      await manager.closeResponsesChainSession(loopState);

      expect(mockCloseResponsesSession).not.toHaveBeenCalled();
    });

    it('catches and logs errors from closeResponsesSession', async () => {
      mockCloseResponsesSession.mockRejectedValueOnce(new Error('Network error'));
      const loopState = createLoopState({
        responsesChain: createResponsesChainState({ transportSessionId: 'session-1' }),
      });

      // Should not throw
      await manager.closeResponsesChainSession(loopState);
    });
  });

  // ── prepareRetryableResponsesRequestRetry ─────────────────────

  describe('prepareRetryableResponsesRequestRetry', () => {
    it('applies transport fallback and closes session', async () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState({ transportSessionId: 'ws-1' }),
      });
      const transportFallbackEvent = {
        type: 'transport-fallback' as const,
        reason: 'timeout',
        from: 'websocket' as const,
        to: 'http-sse' as const,
      };

      await manager.prepareRetryableResponsesRequestRetry(
        loopState,
        null,
        transportFallbackEvent
      );

      expect(mockApplyTransportFallbackEvent).toHaveBeenCalledWith(loopState, transportFallbackEvent);
      expect(mockCloseResponsesSession).toHaveBeenCalledWith('ws-1');
    });

    it('uses responseMetadataEvent transportSessionId for closing when available', async () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState({ transportSessionId: 'ws-1' }),
      });
      const responseMetadataEvent = {
        type: 'response-metadata' as const,
        responseId: 'resp-1',
        provider: 'openai-subscription',
        transport: 'websocket' as const,
        continuationAccepted: true,
        transportSessionId: 'ws-from-metadata',
      };

      await manager.prepareRetryableResponsesRequestRetry(
        loopState,
        responseMetadataEvent,
        null
      );

      expect(mockCloseResponsesSession).toHaveBeenCalledWith('ws-from-metadata');
    });

    it('does not apply transport fallback when event is null', async () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState({ transportSessionId: 'ws-1' }),
      });

      await manager.prepareRetryableResponsesRequestRetry(loopState, null, null);

      expect(mockApplyTransportFallbackEvent).not.toHaveBeenCalled();
    });

    it('falls back to loopState session ID when responseMetadataEvent has no transportSessionId', async () => {
      const loopState = createLoopState({
        responsesChain: createResponsesChainState({ transportSessionId: 'ws-loop' }),
      });
      const responseMetadataEvent = {
        type: 'response-metadata' as const,
        responseId: 'resp-1',
        provider: 'openai-subscription',
        transport: 'websocket' as const,
        continuationAccepted: true,
      };

      await manager.prepareRetryableResponsesRequestRetry(
        loopState,
        responseMetadataEvent,
        null
      );

      // No transportSessionId on the event, falls back to loopState
      expect(mockCloseResponsesSession).toHaveBeenCalledWith('ws-loop');
    });
  });
});
