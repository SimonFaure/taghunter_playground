// Windows settings a mother needs (retours sept. #20) - see src-tauri/src/win_health.rs.
import { invoke } from '@tauri-apps/api/core';

export interface WindowsHealth {
  sleep_ac_minutes: number | null;
  wifi_power_management: boolean | null;
  public_networks: string[];
  needs_fix: boolean;
}

export function checkWindowsHealth(): Promise<WindowsHealth> {
  return invoke<WindowsHealth>('mother_windows_health');
}

/** One UAC prompt. Resolves with the re-read state. */
export function fixWindowsHealth(): Promise<WindowsHealth> {
  return invoke<WindowsHealth>('mother_fix_windows_health');
}
