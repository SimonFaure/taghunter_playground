// Decoder for the coded hotspot start failures (`HOTSPOT_ERR:<code>|<detail>`,
// hotspot.rs windows_impl). Windows answers a bare "Unknown" when the Wi-Fi
// driver cannot host an access point - the operator needs to hear that in
// their language, with what to try, not the WinRT status dump (which stays
// available as `detail` for support).

import { invoke } from '@tauri-apps/api/core';
import type { TFunction } from 'i18next';

const CODED_RE = /HOTSPOT_ERR:([A-Za-z0-9_]+)\|([\s\S]*)$/;

const KNOWN_CODES = new Set([
  'unknown',
  'wifi_off',
  'no_profile',
  'capability_DisabledByHardwareLimitation',
  'capability_DisabledByGroupPolicy',
]);

export interface HotspotError {
  code: string;
  message: string;
  detail: string;
}

/** Null when `raw` is not a coded hotspot failure. */
export function describeHotspotError(raw: string, t: TFunction): HotspotError | null {
  const m = CODED_RE.exec(raw);
  if (!m) return null;
  const code = m[1];
  const key = KNOWN_CODES.has(code)
    ? code
    : code.startsWith('capability_')
      ? 'capability_other'
      : 'unknown';
  return {
    code,
    message: t(`devicesLan:hotspotErr_${key}`),
    detail: m[2].trim(),
  };
}

/** Failures where no retry will help: an external router is the way out. */
export function hotspotErrorSuggestsRouter(code: string): boolean {
  return code === 'unknown' || code.startsWith('capability_');
}

export function openWindowsHotspotSettings(): Promise<void> {
  return invoke('open_windows_hotspot_settings');
}
