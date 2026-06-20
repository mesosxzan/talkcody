/**
 * Active Skills Configuration Service
 *
 * Manages active skills state using a JSON file in app data directory
 * This replaces database storage for better consistency with file-based skills
 */

import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { logger } from '@/lib/logger';
import { isTauriRuntime } from '@/lib/runtime-env';

/**
 * Active skills configuration structure
 */
interface ActiveSkillsConfig {
  /** Array of active skill IDs */
  activeSkills: string[];
  /** Timestamp of last update */
  lastUpdated: number;
}

/**
 * Active Skills Config Service
 */
const WEB_ACTIVE_SKILLS_KEY = 'talkcody-active-skills';

class ActiveSkillsConfigService {
  private configPath: string | null = null;

  private loadWebActiveSkills(): string[] {
    const raw = localStorage.getItem(WEB_ACTIVE_SKILLS_KEY);
    if (!raw) return [];
    const config = JSON.parse(raw) as ActiveSkillsConfig;
    return Array.isArray(config.activeSkills) ? config.activeSkills : [];
  }

  private saveWebActiveSkills(skillIds: string[]): void {
    const config: ActiveSkillsConfig = {
      activeSkills: skillIds,
      lastUpdated: Date.now(),
    };
    localStorage.setItem(WEB_ACTIVE_SKILLS_KEY, JSON.stringify(config));
  }

  /**
   * Get the path to the config file
   */
  private async getConfigPath(): Promise<string> {
    if (this.configPath) {
      return this.configPath;
    }

    const appData = await appDataDir();
    this.configPath = await join(appData, 'active-skills.json');
    return this.configPath;
  }

  /**
   * Ensure the config file exists
   */
  private async ensureConfigFile(): Promise<void> {
    const configPath = await this.getConfigPath();
    const fileExists = await exists(configPath);

    if (!fileExists) {
      logger.info('Creating active-skills.json file');
      await this.saveActiveSkills([]);
    }
  }

  /**
   * Load active skills from config file
   */
  async loadActiveSkills(): Promise<string[]> {
    try {
      if (!isTauriRuntime()) {
        return this.loadWebActiveSkills();
      }

      await this.ensureConfigFile();
      const configPath = await this.getConfigPath();
      const content = await readTextFile(configPath);
      const config: ActiveSkillsConfig = JSON.parse(content);

      logger.info(`Loaded ${config.activeSkills.length} active skills from config file`);
      return config.activeSkills;
    } catch (error) {
      logger.error('Failed to load active skills from config:', error);
      // Return empty array on error
      return [];
    }
  }

  /**
   * Save active skills to config file
   */
  async saveActiveSkills(skillIds: string[]): Promise<void> {
    try {
      if (!isTauriRuntime()) {
        this.saveWebActiveSkills(skillIds);
        return;
      }

      const configPath = await this.getConfigPath();
      const config: ActiveSkillsConfig = {
        activeSkills: skillIds,
        lastUpdated: Date.now(),
      };

      await writeTextFile(configPath, JSON.stringify(config, null, 2));
      logger.info(`Saved ${skillIds.length} active skills to config file`);
    } catch (error) {
      logger.error('Failed to save active skills to config:', error);
      throw error;
    }
  }

  /**
   * Add a skill to active list
   */
  async addActiveSkill(skillId: string): Promise<void> {
    const activeSkills = await this.loadActiveSkills();
    if (!activeSkills.includes(skillId)) {
      activeSkills.push(skillId);
      await this.saveActiveSkills(activeSkills);
    }
  }

  /**
   * Remove a skill from active list
   */
  async removeActiveSkill(skillId: string): Promise<void> {
    const activeSkills = await this.loadActiveSkills();
    const filtered = activeSkills.filter((id) => id !== skillId);
    if (filtered.length !== activeSkills.length) {
      await this.saveActiveSkills(filtered);
    }
  }

  /**
   * Check if a skill is active
   */
  async isSkillActive(skillId: string): Promise<boolean> {
    const activeSkills = await this.loadActiveSkills();
    return activeSkills.includes(skillId);
  }

  /**
   * Clear all active skills
   */
  async clearActiveSkills(): Promise<void> {
    await this.saveActiveSkills([]);
  }
}

// Singleton instance
export const activeSkillsConfigService = new ActiveSkillsConfigService();
