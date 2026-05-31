// src/hooks/use-locale.ts
import { useCallback, useMemo } from 'react';
import {
  detectBrowserLanguage,
  getLocale,
  getSupportedLocales,
  isValidLocale,
  type LocaleDefinition,
  type SupportedLocale,
} from '@/locales';
import { useSettingsStore } from '@/stores/settings-store';

interface UseLocaleReturn {
  locale: SupportedLocale;
  t: LocaleDefinition;
  setLocale: (locale: SupportedLocale) => Promise<void>;
  supportedLocales: Array<{ code: SupportedLocale; name: string }>;
}

/**
 * Sync the current locale to the Tauri backend so that the native menu bar
 * can be rebuilt with the correct language strings.
 * This is a no-op when running in a non-Tauri environment (e.g. browser).
 */
async function syncLocaleToBackend(locale: string): Promise<void> {
  try {
    // Dynamic import so the module doesn't crash in non-Tauri environments
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('update_menu_locale', { locale });
  } catch {
    // Silently ignore – not running in Tauri or command not available
  }
}

/**
 * Sync locale to the backend on first load.
 * Called once when the locale hook is first used.
 */
let initialSyncDone = false;
function syncInitialLocale(locale: string): void {
  if (initialSyncDone) return;
  initialSyncDone = true;
  syncLocaleToBackend(locale);
}

export function useLocale(): UseLocaleReturn {
  const language = useSettingsStore((state) => state.language);
  const setLanguage = useSettingsStore((state) => state.setLanguage);

  const locale = useMemo((): SupportedLocale => {
    if (language && isValidLocale(language)) {
      return language;
    }
    return detectBrowserLanguage();
  }, [language]);

  const t = useMemo(() => {
    return getLocale(locale);
  }, [locale]);

  // Sync initial locale to backend
  syncInitialLocale(locale);

  const setLocale = useCallback(
    async (newLocale: SupportedLocale) => {
      await setLanguage(newLocale);
      // Sync the new locale to the Tauri backend for native menu bar i18n
      await syncLocaleToBackend(newLocale);
    },
    [setLanguage]
  );

  const supportedLocales = useMemo(() => getSupportedLocales(), []);

  return {
    locale,
    t,
    setLocale,
    supportedLocales,
  };
}

export function useTranslation(): LocaleDefinition {
  const { t } = useLocale();
  return t;
}
