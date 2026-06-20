import { create } from 'zustand';
import { logger } from '@/lib/logger';
import { databaseService } from '@/services/database-service';
import { settingsManager } from '@/stores/settings-store';
import type { Project } from '@/types';

interface ProjectState {
  projects: Project[];
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
}

interface ProjectStore extends ProjectState {
  loadProjects: () => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  refreshProjects: () => Promise<void>;
  getRecentProjects: () => Project[];
  resetInitialized: () => void;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  isLoading: false,
  error: null,
  isInitialized: false,

  loadProjects: async () => {
    const { isLoading } = get();
    // Prevent concurrent loads. Allow re-fetch after delete/refresh
    // by letting the caller use refreshProjects() or resetInitialized().
    if (isLoading) return;

    try {
      set({ isLoading: true, error: null });
      const projects = await databaseService.getProjects();
      set({ projects, isLoading: false, isInitialized: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to load projects';
      logger.error('Failed to load projects:', errorMessage);
      set({ error: errorMessage, isLoading: false, isInitialized: true });
    }
  },

  deleteProject: async (id: string) => {
    try {
      await databaseService.deleteProject(id);

      // If the deleted project was the currently selected one, reset to default
      // so that the main window doesn't show a deleted project as active.
      if (settingsManager.getProject() === id) {
        await settingsManager.setProject('default');
      }

      set((state) => ({
        projects: state.projects.filter((p) => p.id !== id),
      }));

      logger.info(`Deleted project ${id} from store`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to delete project';
      logger.error(`Failed to delete project ${id}:`, errorMessage);
      set({ error: errorMessage });
      throw error;
    }
  },

  refreshProjects: async () => {
    try {
      set({ isLoading: true, error: null });
      const projects = await databaseService.getProjects();
      set({ projects, isLoading: false, isInitialized: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to refresh projects';
      logger.error('Failed to refresh projects:', errorMessage);
      set({ error: errorMessage, isLoading: false });
    }
  },

  getRecentProjects: () => {
    return [...get().projects].sort((a, b) => b.updated_at - a.updated_at);
  },

  resetInitialized: () => {
    set({ isInitialized: false });
  },
}));
