import { relaunch } from '@tauri-apps/plugin-process';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { logger } from '@/lib/logger';

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
}

export interface DownloadProgress {
  downloaded: number;
  total?: number;
  percentage?: number;
}

export type UpdateProgressCallback = (progress: DownloadProgress) => void;

export class UpdateService {
  private static instance: UpdateService;
  private checkingForUpdate = false;
  private downloadingUpdate = false;

  private constructor() {}

  static getInstance(): UpdateService {
    if (!UpdateService.instance) {
      UpdateService.instance = new UpdateService();
    }
    return UpdateService.instance;
  }

  /**
   * Check if an update is available
   */
  async checkForUpdate(): Promise<Update | null> {
    if (this.checkingForUpdate) {
      logger.info('Update check already in progress');
      return null;
    }

    try {
      this.checkingForUpdate = true;
      logger.info('Checking for updates...');

      const update = await check();

      if (update) {
        logger.info(`Update available: ${update.version} (current: ${update.currentVersion})`);
        return update;
      } else {
        logger.info('No update available');
        return null;
      }
    } catch (error) {
      logger.error(`Failed to check for updates: ${error}`);
      throw new Error(`Failed to check for updates: ${error}`);
    } finally {
      this.checkingForUpdate = false;
    }
  }

  /**
   * Download and install update with progress tracking
   */
  async downloadAndInstall(update: Update, onProgress?: UpdateProgressCallback): Promise<void> {
    if (this.downloadingUpdate) {
      throw new Error('Update download already in progress');
    }

    try {
      this.downloadingUpdate = true;
      logger.info(`Starting update download: ${update.version}`);

      let downloaded = 0;
      let total: number | undefined;

      await update.downloadAndInstall((event: DownloadEvent) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength;
            logger.info(`Download started: ${total ? `${total} bytes` : 'unknown size'}`);
            if (onProgress && total) {
              onProgress({
                downloaded: 0,
                total,
                percentage: 0,
              });
            }
            break;

          case 'Progress':
            downloaded += event.data.chunkLength;
            logger.info(`Downloaded: ${downloaded} bytes`);
            if (onProgress) {
              onProgress({
                downloaded,
                total,
                percentage: total ? (downloaded / total) * 100 : undefined,
              });
            }
            break;

          case 'Finished':
            logger.info('Download complete');
            if (onProgress && total) {
              onProgress({
                downloaded: total,
                total,
                percentage: 100,
              });
            }
            break;
        }
      });

      logger.info('Update installed successfully');
    } catch (error) {
      logger.error(`Failed to download and install update: ${error}`);
      throw new Error(`Failed to download and install update: ${error}`);
    } finally {
      this.downloadingUpdate = false;
    }
  }

  /**
   * Check, download, and install update automatically
   */
  async checkAndUpdate(onProgress?: UpdateProgressCallback): Promise<boolean> {
    try {
      const update = await this.checkForUpdate();

      if (!update) {
        return false;
      }

      await this.downloadAndInstall(update, onProgress);
      return true;
    } catch (error) {
      logger.error(`Auto-update failed: ${error}`);
      throw error;
    }
  }

  /**
   * Restart the application
   */
  async restartApp(): Promise<void> {
    try {
      logger.info('Restarting application...');
      await relaunch();
    } catch (error) {
      logger.error(`Failed to restart application: ${error}`);
      throw new Error(`Failed to restart application: ${error}`);
    }
  }

  /**
   * Extract update information from Update object
   */
  getUpdateInfo(update: Update): UpdateInfo {
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      date: update.date,
      body: update.body,
    };
  }

  /**
   * Check if currently checking for updates
   */
  isCheckingForUpdate(): boolean {
    return this.checkingForUpdate;
  }

  /**
   * Check if currently downloading update
   */
  isDownloadingUpdate(): boolean {
    return this.downloadingUpdate;
  }
}

export const updateService = UpdateService.getInstance();
