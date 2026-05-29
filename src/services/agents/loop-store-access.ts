// src/services/agents/loop-store-access.ts

import type { SupportedLocale } from '@/locales';
import { useProviderStore } from '@/providers/stores/provider-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import type { UIMessage } from '../../types/agent';

/**
 * Interface for accessing store state within the agent loop.
 * This abstracts away direct Zustand store access, enabling
 * dependency injection for testing and decoupling the core
 * agent loop from UI framework specifics.
 */
export interface LoopStoreAccess {
  /** Get reasoning effort level from settings */
  getReasoningEffort(): string;
  /** Check if LLM tracing is enabled */
  getTraceEnabled(): boolean;
  /** Get current language setting */
  getLanguage(): SupportedLocale;
  /** Update task metadata */
  updateTask(taskId: string, updates: Record<string, unknown>): void;
  /** Update task usage statistics */
  updateTaskUsage(taskId: string, usage: Record<string, unknown>): void;
  /** Get all messages for a task */
  getMessages(taskId: string): UIMessage[];
  /** Check if a model is available */
  isModelAvailable(model: string): boolean;
  /** Get provider model factory */
  getProviderModel(model: string): unknown;
  /** Get available models list */
  getAvailableModels(): unknown[];
  /** Get OAuth configuration */
  getOauthConfig(): { openaiIsConnected?: boolean } | undefined;
}

/**
 * Default implementation that delegates to Zustand stores.
 * This preserves existing behavior while allowing injection
 * of mock implementations for testing.
 */
export function createDefaultLoopStoreAccess(): LoopStoreAccess {
  return {
    getReasoningEffort: () => useSettingsStore.getState().getReasoningEffort(),
    getTraceEnabled: () => useSettingsStore.getState().getTraceEnabled?.() ?? true,
    getLanguage: () => (useSettingsStore.getState().language || 'en') as SupportedLocale,
    updateTask: (taskId, updates) => useTaskStore.getState().updateTask(taskId, updates),
    updateTaskUsage: (taskId, usage) => useTaskStore.getState().updateTaskUsage(taskId, usage),
    getMessages: (taskId) => useTaskStore.getState().getMessages(taskId),
    isModelAvailable: (model) => useProviderStore.getState().isModelAvailable(model),
    getProviderModel: (model) => useProviderStore.getState().getProviderModel(model),
    getAvailableModels: () => useProviderStore.getState().availableModels || [],
    getOauthConfig: () => useProviderStore.getState().oauthConfig,
  };
}
