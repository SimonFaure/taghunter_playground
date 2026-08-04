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
  language: 'english' | 'french' | 'spanish';
  fullscreenOnLaunch?: boolean;
  autoLaunch?: boolean;
  // Windows-only: start the LAN Wi-Fi hotspot (mother AP) automatically at app
  // boot so satellite devices reconnect on their own. Uses the stable creds
  // from lanCredentials (auto-generated on first use). See App.tsx boot wiring.
  //
  // DEPRECATED by `beMotherWhenAvailable` (mother/hotspot role rework). Still
  // read at boot until the new model's boot wiring lands; loadConfig migrates a
  // `true` value into `beMotherWhenAvailable`. New code should prefer the latter.
  startHotspotOnLaunch?: boolean;
  // Mother/hotspot role rework: this device is *willing* to be the mother. When
  // set, the device runs `becomeMother` at app boot (subject to the LAN fence -
  // it stands down and follows an already-live mother instead of starting a
  // second server). Multiple devices may have this on (E1, "preferred mother":
  // whoever boots first wins, the rest fall in behind). The network-source
  // sub-choice (hotspot vs external router) is persisted separately in
  // lanCredentials (`getNetworkSource`). Per-device, default off.
  beMotherWhenAvailable?: boolean;
  raspberryHost?: string;
  // Launch logo screen - a branded screen shown instead of the home page
  // at startup. All three are per-device local prefs. `logoScreenLogoFile`
  // is the filename of a custom logo copied into AppData (null = use the
  // bundled TagHunter fallback).
  logoScreenOnLaunch?: boolean;
  logoScreenBgColor?: string;
  logoScreenLogoFile?: string | null;
  // Logo screen ambient animation. The effect hugs the logo's alpha
  // silhouette via filter: drop-shadow (so a transparent logo glows by its
  // shape, an opaque one by its rectangle). `logoScreenGlowColor` tints every
  // effect - the breathing halo and the shimmer sheen alike. See logoEffect.ts.
  logoScreenAnimation?: LogoAnimation;
  logoScreenGlowColor?: string;
  // "Use PIN to exit" kiosk gates. When set, leaving the protected screen
  // requires the device PIN (verified non-mutatingly via pinStore.peekVerifyPin
  // - no lockout). Per-device local prefs, default off.
  //   - game: every exit from a running game (visible Back buttons, the
  //     leaderboard, and opening the 4-tap operator panel).
  //   - logo: dismissing the launch/standby logo screen.
  //   - fullscreen: pressing F11 to LEAVE fullscreen (the only in-app exit).
  //     Bypassed when no device PIN is set, so a brand-new device can't get
  //     trapped in a fullscreen login screen.
  requirePinToExitGame?: boolean;
  requirePinToExitLogo?: boolean;
  requirePinToExitFullscreen?: boolean;
  // Video subtitles: when on, tutorial/intro videos start with the subtitle
  // track matching the current app language pre-selected (if that language has
  // a subtitle file). Operators can still change/disable subtitles per playback
  // via the in-player selector. Default on.
  useSubtitlesByDefault?: boolean;
  // Operator-only device: this machine is used purely to manage/launch games,
  // never to play them. When on, content sync downloads only each scenario's
  // game-data + its single visual image (no other media, no game-type tutorial
  // videos) to save disk; self-participation in games is disabled and all
  // reader/driver hardware UI is hidden. Per-device, default off. Set from
  // Settings→Preferences or the first-launch onboarding step. See
  // services/operatorMode.ts for the toggle (reset-and-resync) flow.
  operatorOnlyDevice?: boolean;
}

const CONFIG_REL = 'config.json';
const DEFAULT_CONFIG: AppConfig = {
  language: 'english',
  fullscreenOnLaunch: false,
  autoLaunch: false,
  startHotspotOnLaunch: false,
  beMotherWhenAvailable: false,
  raspberryHost: '192.168.129.250',
  logoScreenOnLaunch: false,
  logoScreenBgColor: '#000000',
  logoScreenLogoFile: null,
  logoScreenAnimation: 'pulse',
  logoScreenGlowColor: '#FFFFFF',
  requirePinToExitGame: false,
  requirePinToExitLogo: false,
  requirePinToExitFullscreen: false,
  useSubtitlesByDefault: true,
  operatorOnlyDevice: false,
};

export const loadConfig = async (): Promise<AppConfig> => {
  try {
    if (!(await exists(CONFIG_REL, { baseDir: BaseDirectory.AppData }))) {
      return { ...DEFAULT_CONFIG };
    }
    const text = await readTextFile(CONFIG_REL, { baseDir: BaseDirectory.AppData });
    const parsed = JSON.parse(text);
    const merged = { ...DEFAULT_CONFIG, ...parsed };
    // Mother/hotspot role rework migration: a device that opted into
    // "start hotspot on launch" was effectively a willing hotspot-mode mother,
    // so carry it into the new preference (only when the new field is absent, so
    // an explicit later choice is never overwritten).
    if (parsed.beMotherWhenAvailable === undefined && parsed.startHotspotOnLaunch) {
      merged.beMotherWhenAvailable = true;
    }
    return merged;
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

// Window event fired by flows that change the config OUTSIDE a settings panel
// (e.g. NotMotherPanel flipping beMotherWhenAvailable), so panels holding a
// copy in state (DefaultRolesPanel) can re-read instead of showing stale
// toggles. Dispatch with `window.dispatchEvent(new Event(CONFIG_CHANGED_EVENT))`.
export const CONFIG_CHANGED_EVENT = 'taghunter:config-changed';
