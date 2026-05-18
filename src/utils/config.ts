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
}

const CONFIG_REL = 'config.json';
const DEFAULT_CONFIG: AppConfig = {
  language: 'english',
  fullscreenOnLaunch: false,
  autoLaunch: false,
  raspberryHost: '192.168.129.250',
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
