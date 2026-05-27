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
import type { LogoAnimation } from './logoEffect';

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
  // Logo screen ambient animation. The effect hugs the logo's alpha
  // silhouette via filter: drop-shadow (so a transparent logo glows by its
  // shape, an opaque one by its rectangle). `logoScreenGlowColor` tints every
  // effect — the breathing halo and the shimmer sheen alike. See logoEffect.ts.
  logoScreenAnimation?: LogoAnimation;
  logoScreenGlowColor?: string;
  // "Use PIN to exit" kiosk gates. When set, leaving the protected screen
  // requires the device PIN (verified non-mutatingly via pinStore.peekVerifyPin
  // — no lockout). Per-device local prefs, default off.
  //   - game: every exit from a running game (visible Back buttons, the
  //     leaderboard, and opening the 4-tap operator panel).
  //   - logo: dismissing the launch/standby logo screen.
  //   - fullscreen: pressing F11 to LEAVE fullscreen (the only in-app exit).
  //     Bypassed when no device PIN is set, so a brand-new device can't get
  //     trapped in a fullscreen login screen.
  requirePinToExitGame?: boolean;
  requirePinToExitLogo?: boolean;
  requirePinToExitFullscreen?: boolean;
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
  logoScreenAnimation: 'pulse',
  logoScreenGlowColor: '#FFFFFF',
  requirePinToExitGame: false,
  requirePinToExitLogo: false,
  requirePinToExitFullscreen: false,
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
