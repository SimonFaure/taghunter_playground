// This device's upkeep report - its app-update state and its content-sync
// state - for the top-bar Devices modal on every device of the LAN.
//
// updateService patches the update half as it checks / downloads / installs;
// services/deviceUpkeep recomputes the content half. Every change is cached in
// Rust (`client_set_upkeep`), so the regular ~10s ping to the mother carries
// it, and a debounced out-of-band ping makes the change show within ~1s. The
// mother reads its own row from the Rust cache directly (list_fleet).
//
// Kept small on purpose (≈1 KB): it rides on every ping.

import { invoke } from '@tauri-apps/api/core';
import { pingMothersNow } from './screenState';

export type UpdatePhase =
  | 'unknown' // never checked (or the check reached nobody)
  | 'checking'
  | 'up_to_date'
  | 'available' // a newer version is out, not downloaded yet
  | 'downloading'
  | 'ready' // downloaded: restart to apply
  | 'installing'
  | 'store_only' // iOS / no APK: updates through the store only
  | 'error';

export interface UpkeepUpdate {
  phase: UpdatePhase;
  /** The newer version found, when there is one. */
  latest: string | null;
  /** 0-100 while downloading, when the size is known. */
  progress: number | null;
  /** Where the update comes from (studio / LAN mother / this device's cache). */
  source: 'cloud' | 'mother' | 'cache' | null;
  /** Why a ready update was not applied: a game runs here (a remote update
   *  never restarts it unasked), or the tablet waits for its operator to
   *  confirm Android's install screen. */
  blocked: 'game_running' | 'confirm_on_device' | null;
  error: string | null;
  /** This device's update channel ('stable' | 'test'). */
  channel: string | null;
}

export type ContentPhase = 'unknown' | 'up_to_date' | 'pending' | 'syncing' | 'error';

export interface UpkeepContent {
  phase: ContentPhase;
  /** Items still to download (scenarios, patterns, videos, lists...). */
  pending: number;
  /** A few of their names, for the modal ("Zanimos, Pattern A..."). */
  names: string[];
  /** Offline, routed to a mother: how many of them the mother can bring
   *  (null when there is no mother inventory to compare with). */
  from_mother: number | null;
  /** The mother saw the studio more recently than this device. */
  mother_newer: boolean;
  /** The operator answered "Plus tard" to this session's sync (or has not
   *  answered yet): nothing downloads in the background. */
  declined: boolean;
  online: boolean;
  error: string | null;
  checked_at: string | null;
}

export interface UpkeepReport {
  update: UpkeepUpdate;
  content: UpkeepContent;
  /** Ctrl+M sound mute is on (the operator can toggle it remotely). Absent
   *  from an older build. */
  muted?: boolean;
}

let report: UpkeepReport = {
  update: {
    phase: 'unknown',
    latest: null,
    progress: null,
    source: null,
    blocked: null,
    error: null,
    channel: null,
  },
  content: {
    phase: 'unknown',
    pending: 0,
    names: [],
    from_mother: null,
    mother_newer: false,
    declined: false,
    online: false,
    error: null,
    checked_at: null,
  },
};

const listeners = new Set<(r: UpkeepReport) => void>();
let lastPublished = '';
let pingTimer: ReturnType<typeof setTimeout> | null = null;

function publish(): void {
  for (const l of listeners) l(report);
  const json = JSON.stringify(report);
  if (json === lastPublished) return;
  lastPublished = json;
  void invoke('client_set_upkeep', { json }).catch(() => {});
  if (pingTimer) clearTimeout(pingTimer);
  pingTimer = setTimeout(() => {
    pingTimer = null;
    void pingMothersNow();
  }, 1000);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function patchUpdate(patch: Partial<UpkeepUpdate>): void {
  const next = { ...report.update, ...patch };
  if (next.error) next.error = clip(next.error, 160);
  // Progress only travels in 5% steps: a download must not ping every chunk.
  if (next.progress !== null) next.progress = Math.floor(next.progress / 5) * 5;
  report = { ...report, update: next };
  publish();
}

export function setContent(content: UpkeepContent): void {
  report = {
    ...report,
    content: {
      ...content,
      names: content.names.slice(0, 5).map((n) => clip(n, 60)),
      error: content.error ? clip(content.error, 160) : null,
    },
  };
  publish();
}

export function patchContent(patch: Partial<UpkeepContent>): void {
  setContent({ ...report.content, ...patch });
}

export function setMutedReport(muted: boolean): void {
  if (report.muted === muted) return;
  report = { ...report, muted };
  publish();
}

export function getUpkeep(): UpkeepReport {
  return report;
}

export function subscribeUpkeep(fn: (r: UpkeepReport) => void): () => void {
  listeners.add(fn);
  fn(report);
  return () => {
    listeners.delete(fn);
  };
}
