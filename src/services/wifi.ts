import { invoke } from '@tauri-apps/api/core';

// Returns the SSID the device is currently associated with, or null when the
// platform call fails or the device is not connected to Wi-Fi. The footer
// uses this only as tooltip flavour text — connection state itself is driven
// by the mother-ping state machine in useMotherConnection.
export async function getCurrentSsid(): Promise<string | null> {
  try {
    return (await invoke<string | null>('get_wifi_ssid')) ?? null;
  } catch {
    return null;
  }
}
