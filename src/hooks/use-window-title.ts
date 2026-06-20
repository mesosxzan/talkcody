// src/hooks/use-window-title.ts
// Reactively synchronizes the Tauri window title to reflect the currently
// selected project name — VSCode-style: "{projectName} - {baseAppTitle}"
//
// - Uses `useSettingsStore` to watch the selected project id (`project` field).
// - Looks up the project name from `useProjectStore.projects`.
// - Falls back to the configured window title (`document.title`, set by Tauri
//   at startup) when no project is resolved.
// - Guards against stale async updates on rapid project switches.

import { useEffect, useRef } from 'react';
import { logger } from '@/lib/logger';
import { isTauriRuntime } from '@/lib/runtime-env';
import { useProjectStore } from '@/stores/project-store';
import { DEFAULT_PROJECT, useSettingsStore } from '@/stores/settings-store';

/**
 * The base app title is captured once from `document.title` so we always use
 * the value Tauri configured (e.g. "TalkCody" in prod, "TalkCody Dev" in dev).
 */
function getBaseTitle(): string {
  return document.title || 'TalkCody';
}

/**
 * Hook that reactively updates the Tauri window title whenever the selected
 * project changes. Mount once inside AppContent.
 */
export function useWindowTitle(): void {
  const selectedProjectId = useSettingsStore((state) => state.project);
  const projects = useProjectStore((state) => state.projects);

  // Used to discard stale async operations after a newer one has started.
  const updateIdRef = useRef(0);
  // Track the previous selectedProjectId to detect genuine changes
  // (user switching projects) vs. projects list being updated after a delete.
  const prevProjectIdRef = useRef<string | null>(null);

  useEffect(() => {
    const currentUpdateId = ++updateIdRef.current;

    const syncTitle = async () => {
      try {
        if (!isTauriRuntime()) return;

        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const baseTitle = getBaseTitle();

        // No project selected or default project — use base title only.
        if (!selectedProjectId || selectedProjectId === DEFAULT_PROJECT) {
          if (currentUpdateId !== updateIdRef.current) return;
          await getCurrentWindow().setTitle(baseTitle);
          prevProjectIdRef.current = selectedProjectId;
          return;
        }

        // Fast path: project already in the cached list.
        const found = projects.find((p) => p.id === selectedProjectId);
        if (found) {
          if (currentUpdateId !== updateIdRef.current) return;
          await getCurrentWindow().setTitle(`${found.name} - ${baseTitle}`);
          prevProjectIdRef.current = selectedProjectId;
          return;
        }

        // Slow path: project not in cache.
        // Only trigger a DB refresh when the selected project ID actually changed
        // (i.e. user switched to a different project). When the ID is the same but
        // the project disappeared from the list (deleted elsewhere), skip refresh to
        // avoid an infinite loop: refreshProjects → projects changes → re-trigger.
        if (selectedProjectId !== prevProjectIdRef.current) {
          prevProjectIdRef.current = selectedProjectId;
          await useProjectStore.getState().refreshProjects();

          // After refresh, look up again.
          const refreshed = useProjectStore
            .getState()
            .projects.find((p) => p.id === selectedProjectId);

          if (currentUpdateId !== updateIdRef.current) return;

          if (refreshed) {
            await getCurrentWindow().setTitle(`${refreshed.name} - ${baseTitle}`);
          } else {
            // Project not found — fall back to base title.
            await getCurrentWindow().setTitle(baseTitle);
          }
        } else {
          // Project already once refreshed and still missing — use base title.
          if (currentUpdateId !== updateIdRef.current) return;
          await getCurrentWindow().setTitle(baseTitle);
        }
      } catch (err) {
        logger.error('[useWindowTitle] Failed to update window title:', err);
      }
    };

    syncTitle();
  }, [selectedProjectId, projects]);
}
