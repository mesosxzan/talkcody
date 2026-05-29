// src/services/agents/responses-chain-manager.ts

/**
 * Manages Responses API session lifecycle for the agent loop.
 * Extracted from LLMService to consolidate Responses Chain
 * session management and decouple from the core loop.
 */

import { logger } from '@/lib/logger';
import { llmClient } from '@/services/llm/llm-client';
import type { AgentLoopState } from '../../types/agent';
import {
  applyResponseMetadataEvent,
  applyTransportFallbackEvent,
  commitResponsesChainBaseline,
  type ResponseMetadataEvent,
  type TransportFallbackEvent,
} from './llm-response-chaining';

export class ResponsesChainManager {
  /**
   * Finalize a responses-chain turn after stream processing completes.
   * Applies transport fallback and response metadata events, then commits baseline.
   */
  finalizeResponsesChainTurn(
    loopState: AgentLoopState,
    responseMetadataEvent: ResponseMetadataEvent | null,
    transportFallbackEvent: TransportFallbackEvent | null,
    didFallbackToStateless: boolean,
    baselineMessageCount: number
  ): void {
    if (transportFallbackEvent) {
      applyTransportFallbackEvent(loopState, transportFallbackEvent);
    }

    const shouldApplyResponseMetadata = !didFallbackToStateless && !!responseMetadataEvent;
    const didApplyResponseMetadata =
      responseMetadataEvent && shouldApplyResponseMetadata
        ? applyResponseMetadataEvent(loopState, responseMetadataEvent)
        : false;
    const shouldCommitResponseMetadataBaseline =
      shouldApplyResponseMetadata && didApplyResponseMetadata && !loopState.responsesChain?.broken;

    commitResponsesChainBaseline(
      loopState,
      shouldCommitResponseMetadataBaseline,
      baselineMessageCount
    );
  }

  /**
   * Close the responses-chain websocket session.
   */
  async closeResponsesChainSession(
    loopState: AgentLoopState | null | undefined,
    sessionIdOverride?: string | null
  ): Promise<void> {
    const sessionId =
      sessionIdOverride?.trim() || loopState?.responsesChain?.transportSessionId?.trim();
    if (!sessionId) {
      return;
    }

    try {
      await llmClient.closeResponsesSession(sessionId);
    } catch (error) {
      logger.warn('[ResponsesChainManager] Failed to close responses websocket session', {
        sessionId,
        error,
      });
    }
  }

  /**
   * Prepare for a retryable responses request retry.
   * Applies transport fallback and closes the session.
   */
  async prepareRetryableResponsesRequestRetry(
    loopState: AgentLoopState,
    responseMetadataEvent: ResponseMetadataEvent | null,
    transportFallbackEvent: TransportFallbackEvent | null
  ): Promise<void> {
    const sessionIdToClose =
      responseMetadataEvent?.transportSessionId ??
      loopState.responsesChain?.transportSessionId ??
      null;

    if (transportFallbackEvent) {
      applyTransportFallbackEvent(loopState, transportFallbackEvent);
    }

    await this.closeResponsesChainSession(loopState, sessionIdToClose);
  }
}
