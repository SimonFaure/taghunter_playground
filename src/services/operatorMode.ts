// Operator-only device toggle flow.
//
// "Operator-only" (AppConfig.operatorOnlyDevice) makes a device manage/launch
// games without ever playing them: content sync downloads only each scenario's
// game-data + its single visual image and skips game-type tutorial videos
// (see syncOrchestrator). The device also can't self-participate in games and
// hides all reader/driver UI. Design: project_operator_only_device.
//
// Changing the setting funnels through applyOperatorModeChange so BOTH
// directions behave identically: persist the flag, reset every downloaded
// scenario + game-type video to needs-download, then kick a manual sync cycle.
// Turning it ON re-pulls slim (reclaiming disk); turning it OFF re-pulls the
// full media set. The reset is the same primitive either way, so there's no
// partial-media bookkeeping.

import { loadConfig, saveConfig } from '../utils/config';
import * as scenarioStore from './scenarioStore';
import * as gameTypesStore from './gameTypesStore';
import { runCycleNow } from './syncOrchestrator';
import { sendHeartbeat } from './telemetry';
import { invoke } from '@tauri-apps/api/core';

/**
 * Tell the LAN layer whether this device is operator-only. It rides every ping
 * to the mother (and is read directly when this device IS the mother), so no
 * device can push a game onto an operator-only one. Called at boot and on
 * every toggle.
 */
export async function syncOperatorPresence(): Promise<void> {
  try {
    await invoke('client_set_operator_only', { operatorOnly: await isOperatorOnly() });
  } catch {
    /* older native build / non-Tauri context - best-effort */
  }
}

export async function isOperatorOnly(): Promise<boolean> {
  try {
    return (await loadConfig()).operatorOnlyDevice === true;
  } catch {
    return false;
  }
}

/**
 * Apply a change to the operator-only setting. Persists the flag, resets all
 * downloaded scenarios + game-type videos so the next cycle re-downloads them
 * under the new policy, reports the flag to studio (forced heartbeat), then
 * triggers a sync cycle. Best-effort on the side-effects - the flag is always
 * persisted first so the policy is in force even if a later step throws.
 *
 * Callers (Settings) are responsible for the confirm prompt + the
 * "is a game active on this device?" guard. Onboarding calls saveConfig
 * directly (fresh device, nothing to reset) and does NOT use this funnel.
 */
export async function applyOperatorModeChange(next: boolean): Promise<void> {
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, operatorOnlyDevice: next });

  // Let live UI (Footer reader badge, etc.) react without a reload.
  try {
    window.dispatchEvent(new CustomEvent('operator-mode:changed', { detail: { operatorOnly: next } }));
  } catch { /* non-DOM context - ignore */ }
  void syncOperatorPresence();

  try {
    await scenarioStore.resetAllForRedownload();
    await gameTypesStore.resetVideosForRedownload();
  } catch (err) {
    console.error('[operatorMode] reset-for-redownload failed:', err);
  }

  // Reflect the new device role in studio immediately (bypasses the heartbeat's
  // app_version-equality gate). Best-effort.
  void sendHeartbeat(true);

  // Re-pull under the new policy. Manual trigger bypasses the debounce.
  try {
    await runCycleNow('manual');
  } catch (err) {
    console.error('[operatorMode] runCycleNow failed:', err);
  }
}
