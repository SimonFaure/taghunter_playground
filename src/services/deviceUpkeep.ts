// Device upkeep, the device side of the top-bar Devices modal's "Update" and
// "Sync" actions:
//  - keeps the content half of this device's upkeep report current (what is
//    still to download, from the studio or from the mother) - the update half
//    is patched by updateService itself;
//  - runs the `sync_content` / `update_app` commands another device sends
//    (or this device's own row, run locally by the modal).
//
// A remote update downloads and installs, but never restarts a device where a
// game is running unless the operator insisted (`force`): it stops at "ready"
// and says why. Android still asks its operator to confirm the install.

import { listen } from '@tauri-apps/api/event';
import { on as onSyncEvent } from './syncEvents';
import { pendingContentReport, runCycleNow, type PendingUpdatesSummary } from './syncOrchestrator';
import { isLanSyncInFlight, lastMotherInventory, onLanSyncDone } from './peerContent';
import { isOnline } from './connectivity';
import {
  checkForUpdate,
  downloadUpdate,
  installAndRelaunch,
  isGameRunningHere,
  stagedUpdateVersion,
} from './updateService';
import { getUpkeep, patchContent, patchUpdate, setContent } from './upkeepState';

const RECOMPUTE_MS = 60 * 1000;

/** The names the modal lists: titles as they are, other kinds as `#kind`
 *  (`#subtitles:Name`) for the modal to translate. */
function itemNames(s: PendingUpdatesSummary): string[] {
  return [
    ...s.newScenarios,
    ...s.updatedScenarios,
    ...s.patternNames,
    ...s.videoNames,
    ...s.others.map((o) => (o.name ? `#${o.kind}:${o.name}` : `#${o.kind}`)),
  ];
}

let recomputing = false;
let recomputeAgain = false;
// Set while a remote sync runs, so a recompute mid-way keeps "syncing".
let remoteSyncing = false;
// The last sync failure, shown until a sync starts or nothing is left to get.
let lastError: string | null = null;

/** Refresh the content half of the upkeep report. Coalesced; never throws. */
export async function recomputeContent(): Promise<void> {
  if (recomputing) {
    recomputeAgain = true;
    return;
  }
  recomputing = true;
  try {
    do {
      recomputeAgain = false;
      const r = await pendingContentReport(lastMotherInventory()).catch((e) => {
        console.warn('[deviceUpkeep] pending content report failed:', e);
        return null;
      });
      if (!r) continue;
      const busy = r.busy || remoteSyncing || isLanSyncInFlight();
      const pending = r.summary.total;
      const needed = pending > 0 || r.motherNewer;
      // Nothing left to get: an earlier failure no longer matters.
      if (!needed) lastError = null;
      setContent({
        phase: busy ? 'syncing' : lastError ? 'error' : needed ? 'pending' : 'up_to_date',
        pending,
        names: itemNames(r.summary),
        from_mother: r.fromMother,
        mother_newer: r.motherNewer,
        declined: r.declined,
        online: isOnline(),
        error: lastError,
        checked_at: new Date().toISOString(),
      });
    } while (recomputeAgain);
  } finally {
    recomputing = false;
  }
}

/** Sync content now - a manual sync: opens this session's sync consent, and
 *  without internet syncs with the LAN (mother or satellites). */
export async function syncContentNow(): Promise<void> {
  if (remoteSyncing) return;
  remoteSyncing = true;
  lastError = null;
  patchContent({ phase: 'syncing', error: null });
  try {
    const route = await runCycleNow('manual');
    if (route === 'none') lastError = 'no_source';
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  } finally {
    remoteSyncing = false;
  }
  await recomputeContent();
}

let updating = false;

/**
 * Check, download and install the newest app version. Stops at "ready" when a
 * game runs here, unless `force`. Desktop: installing restarts the app (this
 * never returns then). Never throws: the outcome lands in the upkeep report.
 */
export async function updateAppNow(opts: { force?: boolean } = {}): Promise<void> {
  if (updating) return;
  updating = true;
  try {
    patchUpdate({ phase: 'checking', error: null, blocked: null });
    const status = await checkForUpdate();
    if (status.state === 'error') {
      patchUpdate({ phase: 'error', error: 'unreachable' });
      return;
    }
    if (status.state === 'up-to-date' || !status.canSelfUpdate) return;
    // Already in the installer cache (downloaded earlier, or handed over by a
    // satellite): install that one.
    if ((await stagedUpdateVersion()) !== status.latestVersion) await downloadUpdate(() => {});
    else patchUpdate({ phase: 'ready' });
    if (!opts.force && (await isGameRunningHere())) {
      patchUpdate({ phase: 'ready', blocked: 'game_running' });
      return;
    }
    await installAndRelaunch();
  } catch (e) {
    // downloadUpdate / installAndRelaunch already recorded their failure.
    if (getUpkeep().update.phase !== 'error') {
      patchUpdate({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    updating = false;
  }
}

/**
 * Keep the report current and answer the Devices modal's commands. Call once
 * from the App, after the orchestrator has started. Returns the unlisten.
 */
export function installDeviceUpkeep(): () => void {
  let cancelled = false;
  const offs: Array<() => void> = [];
  const keep = (fn: () => void) => {
    if (cancelled) fn();
    else offs.push(fn);
  };

  const soon = () => void recomputeContent();
  offs.push(
    onSyncEvent('cycle:started', () => {
      lastError = null;
      soon();
    }),
    onSyncEvent('cycle:failed', (p) => {
      // auth_invalid has its own screen; a recoverable failure is worth showing.
      if (p.recoverable) lastError = p.reason;
      soon();
    })
  );
  for (const ev of ['cycle:finished', 'updates:available', 'updates:resolved', 'content:updated'] as const) {
    offs.push(onSyncEvent(ev, soon));
  }
  offs.push(onLanSyncDone(soon));
  const boot = setTimeout(soon, 5_000);
  const timer = setInterval(soon, RECOMPUTE_MS);
  offs.push(() => {
    clearTimeout(boot);
    clearInterval(timer);
  });

  void listen<{ kind: string; payload?: { force?: boolean } }>('taghunter://lan-command', (event) => {
    if (cancelled) return;
    const cmd = event.payload;
    if (cmd.kind === 'sync_content') void syncContentNow();
    else if (cmd.kind === 'update_app') void updateAppNow({ force: cmd.payload?.force === true });
  }).then(keep);

  return () => {
    cancelled = true;
    for (const fn of offs) fn();
  };
}
