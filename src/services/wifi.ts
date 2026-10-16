import { invoke } from '@tauri-apps/api/core';

// Returns the SSID the device is currently associated with, or null when the
// platform call fails or the device is not connected to Wi-Fi. Display only
// (footer tooltip, Network page) - the app no longer manages Wi-Fi: devices join
// the shared router / venue network through Windows.
export async function getCurrentSsid(): Promise<string | null> {
  try {
    return (await invoke<string | null>('get_wifi_ssid')) ?? null;
  } catch {
    return null;
  }
}
