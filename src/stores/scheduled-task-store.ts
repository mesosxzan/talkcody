// src/stores/scheduled-task-store.ts

import { create } from 'zustand';
import { logger } from '@/lib/logger';
import { isTauriRuntime, tauriInvoke, tauriListen } from '@/lib/runtime-env';
import { generateId } from '@/lib/utils';
import { postJson } from '@/lib/web-platform';
import { getLocale, type SupportedLocale } from '@/locales';
import { useProviderStore } from '@/providers/stores/provider-store';
import { agentRegistry } from '@/services/agents/agent-registry';
import { executionService } from '@/services/execution-service';
import { messageService } from '@/services/message-service';
import { notificationService } from '@/services/notification-service';
import { previewSystemPrompt } from '@/services/prompt/preview';
import { scheduledTaskDeliveryService } from '@/services/scheduled-tasks/scheduled-task-delivery-service';
import { taskService } from '@/services/task-service';
import { getEffectiveWorkspaceRoot } from '@/services/workspace-root-service';
import { useSettingsStore } from '@/stores/settings-store';
import type { AgentToolSet, UIMessage } from '@/types/agent';
import type {
  CreateScheduledTaskInput,
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_NOTIFICATION_POLICY,
  DEFAULT_OFFLINE_POLICY,
  DEFAULT_RETRY_POLICY,
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskRunCompletePayload,
  ScheduledTaskSchedule,
  ScheduledTaskStatsSummary,
  ScheduledTaskTriggerEvent,
  UpdateScheduledTaskInput,
} from '@/types/scheduled-task';

interface ScheduledTaskState {
  tasks: ScheduledTask[];
  runs: Map<string, ScheduledTaskRun[]>;
  isLoading: boolean;
  stats: ScheduledTaskStatsSummary | null;
  cronPreview: Array<{ rawAt: number; jitteredAt: number; jitterMs: number }>;

  loadTasks: (projectId?: string) => Promise<void>;
  createTask: (data: CreateScheduledTaskInput) => Promise<ScheduledTask>;
  updateTask: (id: string, patch: UpdateScheduledTaskInput) => Promise<ScheduledTask>;
  deleteTask: (id: string) => Promise<void>;
  enableTask: (id: string) => Promise<ScheduledTask>;
  disableTask: (id: string) => Promise<ScheduledTask>;
  pauseTask: (id: string) => Promise<ScheduledTask>;
  resumeTask: (id: string) => Promise<ScheduledTask>;
  triggerNow: (id: string) => Promise<string>;
  loadRuns: (jobId: string) => Promise<void>;
  loadStats: () => Promise<void>;
  previewCron: (
    schedule: ScheduledTaskSchedule,
    executionPolicy?: { staggerMs?: number }
  ) => Promise<void>;
  syncOfflineRunner: (enabled: boolean) => Promise<void>;
  claimPendingRuns: () => Promise<void>;
  _onTrigger: (event: ScheduledTaskTriggerEvent) => Promise<void>;
}

function getTranslations() {
  const language = useSettingsStore.getState().language || 'en';
  return getLocale(language as SupportedLocale);
}

const DEFAULTS = {
  executionPolicy: { maxConcurrentRuns: 1, catchUp: false, staggerMs: -1 },
  retryPolicy: { maxAttempts: 2, backoffMs: [30_000, 60_000] },
  notificationPolicy: { notifyOnSuccess: false, notifyOnFailure: true },
  deliveryPolicy: { enabled: false },
  offlinePolicy: { enabled: false, minuteGranularity: 1 },
};

function scheduledInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime()) {
    return tauriInvoke<T>(command, args);
  }
  return postJson<T>(`/api/scheduled-tasks/${command}`, args ?? {});
}

export const useScheduledTaskStore = create<ScheduledTaskState>((set, get) => ({
  tasks: [],
  runs: new Map(),
  isLoading: false,
  stats: null,
  cronPreview: [],

  loadTasks: async (projectId?: string) => {
    set({ isLoading: true });
    try {
      const tasks = await scheduledInvoke<ScheduledTask[]>('list_scheduled_tasks', {
        projectId: projectId ?? null,
      });
      set({ tasks });
    } catch (err) {
      logger.error('[ScheduledTaskStore] loadTasks error:', err);
    } finally {
      set({ isLoading: false });
    }
  },

  createTask: async (data: CreateScheduledTaskInput) => {
    const task = await scheduledInvoke<ScheduledTask>('create_scheduled_task', {
      request: {
        name: data.name,
        description: data.description ?? null,
        projectId: data.projectId || null,
        schedule: data.schedule,
        scheduleNlText: data.scheduleNlText ?? null,
        payload: data.payload,
        executionPolicy: {
          ...DEFAULTS.executionPolicy,
          ...data.executionPolicy,
        },
        retryPolicy: {
          ...DEFAULTS.retryPolicy,
          ...data.retryPolicy,
        },
        notificationPolicy: {
          ...DEFAULTS.notificationPolicy,
          ...data.notificationPolicy,
        },
        deliveryPolicy: {
          ...DEFAULTS.deliveryPolicy,
          ...data.deliveryPolicy,
        },
        offlinePolicy: {
          ...DEFAULTS.offlinePolicy,
          ...data.offlinePolicy,
        },
      },
    });
    set((state) => ({ tasks: [task, ...state.tasks] }));
    if (task.offlinePolicy?.enabled) {
      await get().syncOfflineRunner(true);
    }
    return task;
  },

  updateTask: async (id: string, patch: UpdateScheduledTaskInput) => {
    const request: Record<string, unknown> = { ...patch };
    // Ensure projectId is explicitly included so Rust can distinguish
    // between "not provided" (undefined → skip) and "clear it" (null → set to null).
    if (patch.projectId !== undefined) {
      request.projectId = patch.projectId;
    }
    const updated = await scheduledInvoke<ScheduledTask>('update_scheduled_task', {
      id,
      request,
    });
    set((state) => ({ tasks: state.tasks.map((t) => (t.id === id ? updated : t)) }));
    await get().syncOfflineRunner(get().tasks.some((task) => task.offlinePolicy?.enabled));
    return updated;
  },

  deleteTask: async (id: string) => {
    await scheduledInvoke<void>('delete_scheduled_task', { id });
    set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) }));
    await get().syncOfflineRunner(
      get().tasks.some((task) => task.id !== id && task.offlinePolicy?.enabled)
    );
  },

  enableTask: async (id: string) => get().updateTask(id, { status: 'enabled' }),
  disableTask: async (id: string) => get().updateTask(id, { status: 'disabled' }),
  pauseTask: async (id: string) => {
    const updated = await scheduledInvoke<ScheduledTask>('pause_scheduled_task', { id });
    set((state) => ({ tasks: state.tasks.map((t) => (t.id === id ? updated : t)) }));
    return updated;
  },
  resumeTask: async (id: string) => {
    const updated = await scheduledInvoke<ScheduledTask>('resume_scheduled_task', { id });
    set((state) => ({ tasks: state.tasks.map((t) => (t.id === id ? updated : t)) }));
    await get().syncOfflineRunner(get().tasks.some((task) => task.offlinePolicy?.enabled));
    return updated;
  },

  triggerNow: async (id: string) =>
    scheduledInvoke<string>('trigger_scheduled_task_now', { jobId: id }),

  loadRuns: async (jobId: string) => {
    try {
      const runs = await scheduledInvoke<ScheduledTaskRun[]>('list_scheduled_task_runs', {
        jobId,
        limit: 50,
      });
      set((state) => {
        const next = new Map(state.runs);
        next.set(jobId, runs);
        return { runs: next };
      });
    } catch (err) {
      logger.error('[ScheduledTaskStore] loadRuns error:', err);
    }
  },

  loadStats: async () => {
    try {
      const stats = await scheduledInvoke<ScheduledTaskStatsSummary>('get_scheduled_task_stats');
      set({ stats });
    } catch (err) {
      logger.error('[ScheduledTaskStore] loadStats error:', err);
    }
  },

  previewCron: async (
    schedule: ScheduledTaskSchedule,
    executionPolicy?: { staggerMs?: number }
  ) => {
    try {
      const cronPreview = await scheduledInvoke<
        Array<{ rawAt: number; jitteredAt: number; jitterMs: number }>
      >('preview_scheduled_task_cron', {
        schedule,
        executionPolicy: {
          ...DEFAULTS.executionPolicy,
          ...(executionPolicy ?? {}),
        },
        count: 5,
      });
      set({ cronPreview });
    } catch (err) {
      logger.error('[ScheduledTaskStore] previewCron error:', err);
      set({ cronPreview: [] });
    }
  },

  syncOfflineRunner: async (enabled: boolean) => {
    try {
      if (isTauriRuntime()) {
        await tauriInvoke('scheduled_task_runner_sync', { enabled });
      }
    } catch (err) {
      logger.error('[ScheduledTaskStore] syncOfflineRunner error:', err);
    }
  },

  claimPendingRuns: async () => {
    try {
      const runs = await scheduledInvoke<ScheduledTaskRun[]>('claim_scheduled_task_runs');
      const tasks = get().tasks;
      for (const run of runs) {
        const job = tasks.find((task) => task.id === run.scheduledTaskId);
        if (!job) continue;
        await get()._onTrigger({
          jobId: job.id,
          runId: run.id,
          payload: job.payload,
          projectId: job.projectId,
        });
      }
    } catch (err) {
      logger.error('[ScheduledTaskStore] claimPendingRuns error:', err);
    }
  },

  _onTrigger: async (event: ScheduledTaskTriggerEvent) => {
    const { jobId, runId, payload, projectId } = event;
    logger.info('[ScheduledTaskStore] Job triggered:', { jobId, runId, payload, projectId });

    let createdTaskId: string | null = null;
    try {
      const settingsState = useSettingsStore.getState();
      if (settingsState.isInitialized !== true) {
        await settingsState.initialize?.();
      }

      const providerStore = useProviderStore.getState();
      if (providerStore.isInitialized !== true) {
        await providerStore.initialize();
      }

      // 1. Resolve agent - use same logic as chat-box.tsx
      const agentId = payload.agentId || settingsState.getAgentId();
      let agent = await agentRegistry.getWithResolvedTools(agentId);
      if (!agent) {
        logger.warn('[ScheduledTaskStore] Agent not found, falling back to planner', { agentId });
        agent = await agentRegistry.getWithResolvedTools('planner');
      }

      // 2. Get model from agent or settings
      const resolvedAgentModel = (agent as (typeof agent & { model?: string }) | undefined)?.model;
      const resolvedFallbackModels =
        (agent as (typeof agent & { fallbackModels?: string[] }) | undefined)?.fallbackModels ?? [];
      const requestedModel = (
        payload.model ??
        resolvedAgentModel ??
        settingsState.model ??
        ''
      ).trim();
      let model = requestedModel;

      if (!model) {
        const fallback =
          providerStore.getAvailableModel()?.key ?? providerStore.availableModels[0]?.key ?? '';
        if (!fallback) {
          throw new Error(
            'No model is configured and no models are available. Configure API keys in Settings → Models.\n定时任务未配置模型且当前没有可用模型，请在 设置 → 模型 中配置 API Key。'
          );
        }
        model = fallback;
        logger.warn('[ScheduledTaskStore] No model configured; using fallback model', {
          jobId,
          runId,
          fallbackModel: model,
        });
      }

      if (!providerStore.isModelAvailable(model)) {
        const fallback =
          providerStore.getAvailableModel()?.key ?? providerStore.availableModels[0]?.key ?? '';
        if (fallback && providerStore.isModelAvailable(fallback)) {
          logger.warn('[ScheduledTaskStore] Model not available; using fallback model', {
            jobId,
            runId,
            requestedModel: model,
            fallbackModel: fallback,
          });
          model = fallback;
        }
      }

      if (!providerStore.isModelAvailable(model)) {
        const t = getTranslations();
        const providerHint =
          providerStore.availableModels.length === 0
            ? 'no models available'
            : `available models: ${providerStore.availableModels
                .slice(0, 5)
                .map((m) => m.key)
                .join(', ')}${providerStore.availableModels.length > 5 ? ', ...' : ''}`;
        throw new Error(
          `${t.LLMService.errors.noProvider(model || requestedModel || 'unknown', 'unknown')}\n` +
            `Reason: ${providerHint}\n` +
            `原因：${providerHint}`
        );
      }

      // 3. Create task with projectId to ensure workspace is set correctly
      createdTaskId = await taskService.createTask(payload.message, {
        projectId: projectId ?? undefined,
      });

      logger.info('[ScheduledTaskStore] Task created:', {
        taskId: createdTaskId,
        projectId,
        agentId,
        model,
      });

      // 4. Build system prompt - use same logic as chat-box.tsx and task-queue-service.ts
      let systemPrompt: string | undefined;
      if (agent) {
        if (typeof agent.systemPrompt === 'function') {
          systemPrompt = await Promise.resolve(agent.systemPrompt());
        } else if (agent.systemPrompt) {
          systemPrompt = agent.systemPrompt;
        }

        // Handle dynamic prompt - same as chat-box.tsx
        if (agent.dynamicPrompt?.enabled) {
          try {
            const root = await getEffectiveWorkspaceRoot(createdTaskId);
            const { finalSystemPrompt } = await previewSystemPrompt({
              agent: agent,
              workspaceRoot: root,
              taskId: createdTaskId,
            });
            systemPrompt = finalSystemPrompt;
            logger.info('[ScheduledTaskStore] Dynamic prompt composed for scheduled task');
          } catch (error) {
            logger.warn('[ScheduledTaskStore] Failed to compose dynamic prompt:', error);
          }
        }
      }

      const tools = agent?.tools ?? {};

      // 5. Add user message
      const userChatMessage: UIMessage = {
        id: generateId(),
        role: 'user',
        content: payload.message,
        timestamp: new Date(),
        assistantId: agentId,
      };
      await messageService.addUserMessage(createdTaskId, payload.message, {
        agentId,
      });

      // 6. Start execution - use same logic as chat-box.tsx and task-queue-service.ts
      await executionService.startExecution({
        taskId: createdTaskId,
        messages: [userChatMessage],
        model,
        fallbackModels: resolvedFallbackModels.length > 0 ? resolvedFallbackModels : undefined,
        systemPrompt,
        tools,
        agentId,
        isNewTask: true,
        userMessage: payload.message,
      });

      const currentJob = get().tasks.find((task) => task.id === jobId);
      const deliveryResult = await scheduledTaskDeliveryService.deliver({
        policy: currentJob?.deliveryPolicy,
        title: currentJob?.name ?? 'Scheduled Task',
        body: payload.message,
      });

      if (currentJob?.notificationPolicy?.notifyOnSuccess) {
        await notificationService.notifyScheduledTaskResult({
          taskName: currentJob.name,
          success: true,
          body: payload.message,
        });
      }

      const completePayload: ScheduledTaskRunCompletePayload = {
        jobId,
        runId,
        taskId: createdTaskId,
        success: true,
        deliveryStatus: deliveryResult.status,
        deliveryError: deliveryResult.error,
      };
      await scheduledInvoke<void>('report_scheduled_task_run_complete', {
        payload: completePayload,
      });
      const updated = await scheduledInvoke<ScheduledTask[]>('list_scheduled_tasks', {
        projectId: null,
      });
      set({ tasks: updated });
      await get().loadStats();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('[ScheduledTaskStore] Execution failed:', errMsg);
      const currentJob = get().tasks.find((task) => task.id === jobId);
      if (currentJob?.notificationPolicy?.notifyOnFailure) {
        await notificationService.notifyScheduledTaskResult({
          taskName: currentJob.name,
          success: false,
          body: errMsg,
        });
      }
      const failPayload: ScheduledTaskRunCompletePayload = {
        jobId,
        runId,
        taskId: createdTaskId,
        success: false,
        error: errMsg,
      };
      try {
        await scheduledInvoke<void>('report_scheduled_task_run_complete', { payload: failPayload });
      } catch (reportErr) {
        logger.error('[ScheduledTaskStore] Failed to report run failure:', reportErr);
      }
      await get().loadStats();
    }
  },
}));

let listenerInitialized = false;

export async function initScheduledTaskListener(): Promise<void> {
  if (listenerInitialized) return;
  listenerInitialized = true;

  if (isTauriRuntime()) {
    await tauriListen<ScheduledTaskTriggerEvent>('scheduled-task-trigger', (payload) => {
      useScheduledTaskStore.getState()._onTrigger(payload);
    });
  }

  await useScheduledTaskStore.getState().loadTasks();
  await useScheduledTaskStore.getState().loadStats();
  await useScheduledTaskStore.getState().claimPendingRuns();

  logger.info('[ScheduledTaskStore] Event listener registered');
}
