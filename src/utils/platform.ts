// Platform locks for the Android build (design: project_android_operator_tablet).
//
// The Android app is an operator TABLET only: it is always an operator-only
// device (never plays games, no SI reader) and never becomes the mother. Everything that depends on that reads isAndroid() so the
// rule lives in one place; loadConfig() also forces the matching config flags.

import { platform } from '@tauri-apps/plugin-os';

let cached: boolean | null = null;

export function isAndroid(): boolean {
  if (cached === null) {
    try {
      cached = platform() === 'android';
    } catch {
      cached = false;
    }
  }
  return cached;
}
