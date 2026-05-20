// Slim Tauri-FS-backed local preferences. Content-sync state (cards version,
// billing, last sync time, email) all moved to SQLite (auth_user, cards_state,
// scenarioStore.lastCycle*). What's left is genuine app-local prefs that don't
// belong to any cloud-synced concept.

import {
  exists,
  readTextFile,
  writeTextFile,
  BaseDirectory,
} from '@tauri-apps/plugin-fs';

export interface AppConfig {
  language: 'english' | 'french';
  fullscreenOnLaunch?: boolean;
  autoLaunch?: boolean;
  raspberryHost?: string;
  // Launch logo screen — a branded screen shown instead of the home page
  // at startup. All three are per-device local prefs. `logoScreenLogoFile`
  // is the filename of a custom logo copied into AppData (null = use the
  // bundled TagHunter fallback).
  logoScreenOnLaunch?: boolean;
  logoScreenBgColor?: string;
  logoScreenLogoFile?: string | null;
}

const CONFIG_REL = 'config.json';
const DEFAULT_CONFIG: AppConfig = {
  language: 'english',
  fullscreenOnLaunch: false,
  autoLaunch: false,
  raspberryHost: '192.168.129.250',
  logoScreenOnLaunch: false,
  logoScreenBgColor: '#000000',
  logoScreenLogoFile: null,
};

export const loadConfig = async (): Promise<AppConfig> => {
  try {
    if (!(await exists(CONFIG_REL, { baseDir: BaseDirectory.AppData }))) {
      return { ...DEFAULT_CONFIG };
    }
    const text = await readTextFile(CONFIG_REL, { baseDir: BaseDirectory.AppData });
    const parsed = JSON.parse(text);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (err) {
    console.error('[Config] load failed, returning defaults:', err);
    return { ...DEFAULT_CONFIG };
  }
};

export const saveConfig = async (config: AppConfig): Promise<void> => {
  await writeTextFile(CONFIG_REL, JSON.stringify(config, null, 2), {
    baseDir: BaseDirectory.AppData,
  });
};
