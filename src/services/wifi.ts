import { invoke } from '@tauri-apps/api/core';

// Returns the SSID the device is currently associated with, or null when the
// platform call fails or the device is not connected to Wi-Fi. The footer
// uses this only as tooltip flavour text - connection state itself is driven
// by the mother-ping state machine in useMotherConnection.
export async function getCurrentSsid(): Promise<string | null> {
  try {
    return (await invoke<string | null>('get_wifi_ssid')) ?? null;
  } catch {
    return null;
  }
}

// List Wi-Fi SSIDs currently in range (Windows/mac/Linux). Returns [] on mobile
// or any failure - the auto-connect engine treats "empty" as "can't see the
// target", which simply means it won't attempt a join (no error path).
export async function scanWifi(): Promise<string[]> {
  try {
    return (await invoke<string[]>('scan_wifi')) ?? [];
  } catch {
    return [];
  }
}

// Join a Wi-Fi network by SSID + WPA2 passphrase. Throws on failure (caller
// surfaces the manual-join fallback). Not supported on mobile.
export async function connectWifi(ssid: string, password: string): Promise<void> {
  await invoke('connect_wifi', { ssid, password });
}

