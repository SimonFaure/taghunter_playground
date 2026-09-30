// OS launch-on-boot registration (tauri-plugin-autostart, desktop only).
//
// The saved `autoLaunch` preference and the OS registration (on Windows the
// HKCU\...\CurrentVersion\Run value) can drift apart: the Tauri NSIS
// uninstaller deletes the Run value on every non-/UPDATE uninstall - including
// the "uninstall first" step of a manual reinstall - while config.json in
// AppData survives, so the toggle still reads ON but nothing is registered.
// A user can also remove it from Task Manager > Startup apps. So we reconcile
// against the OS state (isEnabled) instead of only acting when the toggle
// changes: at every boot and on every Settings Save.
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { isAndroid } from './platform';

export async function syncAutostart(wanted: boolean): Promise<void> {
  // The plugin is not registered on mobile (lib.rs #[cfg(desktop)]).
  if (isAndroid()) return;
  try {
    // enable() is idempotent and always rewrites the value, so calling it
    // unconditionally also re-points a stale exe path and clears a Task
    // Manager "Disabled" override (isEnabled ignores the stored path).
    if (wanted) await enable();
    else if (await isEnabled()) await disable();
  } catch (e) {
    console.error('[autostart] sync failed:', e);
  }
}
