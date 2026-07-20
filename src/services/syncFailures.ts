// Per-item content-sync failure tracker.
//
// Two jobs, one local table (`sync_item_failures`, migration 20):
//   1. OPERATOR DETAIL - record every per-item download failure immediately so
//      the Settings → Sync "items that failed to sync" panel can show the file
//      name + a friendly reason, surviving the per-cycle activity-log wipe.
//   2. STUDIO REPORT - once an item has failed 2 consecutive cycles (it survived
//      at least one automatic retry), promote it: enqueue a `sync_item_failed`
//      telemetry event. When it later downloads OK (or the content is removed in
//      studio), enqueue `sync_item_resolved`. Reporting is sparse by design
//      (grill-me cadence c): we re-report a still-failing item only when its
//      failure SIGNATURE changes (e.g. a 500 becomes a 403).
//
// The row is DELETED on resolve - studio keeps the durable history; locally we
// only ever track what is currently stuck. Every method is best-effort and
// swallows its own errors: a failure in the failure-tracker must never break a
// sync cycle.

import { getDb } from './db';
import { ApiError } from './api';
import { scrubPii, captureSyncItemFailed, captureSyncItemResolved } from './telemetry';
import type { WorkItem } from './syncOrchestrator';

// Promote to a studio-visible failure once an item has failed this many
// consecutive (attempted) cycles. 2 ⇒ it survived at least one auto-retry, so
// transient blips that self-heal next cycle never reach the admin.
const PROMOTE_AT = 2;

const MAX_MESSAGE_LEN = 1000;

// ─── stable per-item key (version-independent) ──────────────────────────────
//
// Tracks "is THIS item stuck", not "is this VERSION stuck": a scenario that
// failed at v4 and is now succeeding at v5 reconciles to the same row. The
// current version rides as a mutable attribute, never as part of the key.
export function syncItemKey(item: WorkItem): string {
  switch (item.kind) {
    case 'cards':
      return `cards:${item.clientId}`;
    case 'on_demand':
      return `on_demand:${item.clientId}`;
    case 'team_names':
      return `team_names:${item.clientId}`;
    case 'recovery_codes':
      return `recovery_codes:${item.clientId}`;
    case 'report_layouts':
      return 'report_layouts';
    case 'lan_networks':
      return 'lan_networks';
    case 'pattern':
      return `pattern:${item.uniqid}`;
    case 'scenario_meta':
      return `scenario_meta:${item.uniqid}`;
    case 'scenario_media':
      return `scenario_media:${item.uniqid}:${item.filename}`;
    case 'game_type_admin_video':
      return `gt_admin:${item.code}`;
    case 'game_type_override_video':
      return `gt_override:${item.code}`;
  }
}

function itemVersion(item: WorkItem): number | null {
  return 'remoteVersion' in item ? item.remoteVersion : null;
}

// ─── error extraction ───────────────────────────────────────────────────────

interface ExtractedError {
  errorType: string;
  httpStatus: number | null;
  message: string;
}

function extractError(err: unknown): ExtractedError {
  let errorType = 'unknown';
  let httpStatus: number | null = null;
  let message = 'failed with unknown error';

  if (err instanceof ApiError) {
    errorType = 'ApiError';
    httpStatus = err.status;
    message = err.message || `API error ${err.status}`;
  } else if (err instanceof Error) {
    errorType = err.constructor.name || 'Error';
    message = err.message || String(err);
  } else if (typeof err === 'string') {
    errorType = 'string';
    message = err;
  } else if (err === null) {
    errorType = 'null';
    message = 'null';
  } else if (err === undefined) {
    errorType = 'undefined';
    message = 'undefined';
  } else if (typeof err === 'object') {
    errorType = (err as object).constructor?.name || 'object';
    try {
      message = JSON.stringify(err);
    } catch {
      message = String(err);
    }
  } else {
    errorType = typeof err;
    message = String(err);
  }

  message = scrubPii(message).slice(0, MAX_MESSAGE_LEN);
  return { errorType, httpStatus, message };
}

// A compact signature of the failure mode. A change (e.g. 500 → 403, or a
// network error → parse error) re-reports the still-failing item to studio.
function errorSignature(e: ExtractedError): string {
  return `${e.errorType}|${e.httpStatus ?? ''}|${e.message}`;
}

// ─── row shape ──────────────────────────────────────────────────────────────

export interface SyncFailureRow {
  item_key: string;
  kind: WorkItem['kind'];
  label: string;
  version: number | null;
  error_type: string | null;
  error_message: string | null;
  http_status: number | null;
  consecutive_failures: number;
  first_failed_at: string | null;
  last_failed_at: string | null;
  reported_failed: number;
  reported_error_sig: string | null;
}

// ─── record a failure ───────────────────────────────────────────────────────

export async function recordFailure(item: WorkItem, err: unknown): Promise<void> {
  try {
    const db = await getDb();
    const key = syncItemKey(item);
    const e = extractError(err);
    const sig = errorSignature(e);
    const nowIso = new Date().toISOString();
    const version = itemVersion(item);

    const existing = await db.select<SyncFailureRow[]>(
      'SELECT * FROM sync_item_failures WHERE item_key = $1',
      [key],
    );

    let consecutive: number;
    let reportedFailed: number;
    let reportedSig: string | null;

    if (existing.length === 0) {
      consecutive = 1;
      reportedFailed = 0;
      reportedSig = null;
      await db.execute(
        `INSERT INTO sync_item_failures
           (item_key, kind, label, version, error_type, error_message, http_status,
            consecutive_failures, first_failed_at, last_failed_at, reported_failed, reported_error_sig)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8, 0, NULL)`,
        [key, item.kind, item.label, version, e.errorType, e.message, e.httpStatus, nowIso],
      );
    } else {
      const row = existing[0];
      consecutive = row.consecutive_failures + 1;
      reportedFailed = row.reported_failed;
      reportedSig = row.reported_error_sig;
      await db.execute(
        `UPDATE sync_item_failures
            SET label = $2, version = $3, error_type = $4, error_message = $5,
                http_status = $6, consecutive_failures = $7, last_failed_at = $8
          WHERE item_key = $1`,
        [key, item.label, version, e.errorType, e.message, e.httpStatus, consecutive, nowIso],
      );
    }

    // Promotion gate (grill-me Q1 / cadence c). Report on first promotion, then
    // only when the failure signature changes.
    if (consecutive >= PROMOTE_AT) {
      const firstFailedAt = existing.length ? existing[0].first_failed_at : nowIso;
      const shouldReport = reportedFailed === 0 || reportedSig !== sig;
      if (shouldReport) {
        await captureSyncItemFailed({
          item_key: key,
          kind: item.kind,
          label: item.label,
          version,
          error_type: e.errorType,
          http_status: e.httpStatus,
          error_message: e.message,
          consecutive_failures: consecutive,
          first_failed_at: firstFailedAt,
          last_failed_at: nowIso,
        });
        await db.execute(
          'UPDATE sync_item_failures SET reported_failed = 1, reported_error_sig = $2 WHERE item_key = $1',
          [key, sig],
        );
      }
    }
  } catch (innerErr) {
    console.warn('[syncFailures] recordFailure failed:', innerErr);
  }
}

// ─── record a success (item recovered) ──────────────────────────────────────

export async function recordSuccess(item: WorkItem): Promise<void> {
  try {
    const db = await getDb();
    const key = syncItemKey(item);
    const rows = await db.select<SyncFailureRow[]>(
      'SELECT reported_failed FROM sync_item_failures WHERE item_key = $1',
      [key],
    );
    if (rows.length === 0) return; // wasn't failing - nothing to clear.

    if (rows[0].reported_failed === 1) {
      await captureSyncItemResolved({ item_key: key, resolution: 'downloaded' });
    }
    await db.execute('DELETE FROM sync_item_failures WHERE item_key = $1', [key]);
  } catch (innerErr) {
    console.warn('[syncFailures] recordSuccess failed:', innerErr);
  }
}

// ─── reconcile obsolete rows ────────────────────────────────────────────────
//
// Called during manifest-apply with the set of item keys that are STILL pending
// download this cycle. Any failure row whose key is no longer pending left the
// work list without succeeding - i.e. the content was unassigned/removed in
// studio. Treat as resolved-by-removal so the admin's view doesn't show it
// stuck forever.
export async function reconcileObsolete(pendingKeys: Set<string>): Promise<void> {
  try {
    const db = await getDb();
    const rows = await db.select<SyncFailureRow[]>(
      'SELECT item_key, kind, reported_failed FROM sync_item_failures',
    );
    for (const row of rows) {
      if (pendingKeys.has(row.item_key)) continue;
      // scenario_media items aren't in the manifest-time work list - they're
      // discovered when their parent scenario_meta downloads. So a media row is
      // still "pending" (will be re-attempted this cycle) iff its parent
      // scenario is pending. Only when the parent is gone too is it obsolete.
      if (row.kind === 'scenario_media') {
        const uniqid = row.item_key.split(':')[1];
        if (uniqid && pendingKeys.has(`scenario_meta:${uniqid}`)) continue;
      }
      if (row.reported_failed === 1) {
        await captureSyncItemResolved({ item_key: row.item_key, resolution: 'removed' });
      }
      await db.execute('DELETE FROM sync_item_failures WHERE item_key = $1', [row.item_key]);
    }
  } catch (innerErr) {
    console.warn('[syncFailures] reconcileObsolete failed:', innerErr);
  }
}

// Called from the post-pool sweep when a scenario is marked fully downloaded.
// Clears any lingering scenario_media failure rows for it - covering the rare
// case where a media file was REMOVED from the scenario across a version bump
// while it happened to be in a failed state (recordSuccess clears each file as
// it succeeds, so in the normal path there's nothing left here). Reports
// resolved for any rows studio saw.
export async function recordScenarioComplete(uniqid: string): Promise<void> {
  try {
    const db = await getDb();
    const prefix = `scenario_media:${uniqid}:`;
    const rows = await db.select<SyncFailureRow[]>(
      'SELECT item_key, reported_failed FROM sync_item_failures',
    );
    for (const row of rows) {
      if (!row.item_key.startsWith(prefix)) continue;
      if (row.reported_failed === 1) {
        await captureSyncItemResolved({ item_key: row.item_key, resolution: 'downloaded' });
      }
      await db.execute('DELETE FROM sync_item_failures WHERE item_key = $1', [row.item_key]);
    }
  } catch (innerErr) {
    console.warn('[syncFailures] recordScenarioComplete failed:', innerErr);
  }
}

// ─── read for the operator UI ───────────────────────────────────────────────

export async function listCurrentFailures(): Promise<SyncFailureRow[]> {
  try {
    const db = await getDb();
    return await db.select<SyncFailureRow[]>(
      'SELECT * FROM sync_item_failures ORDER BY last_failed_at DESC',
    );
  } catch (innerErr) {
    console.warn('[syncFailures] listCurrentFailures failed:', innerErr);
    return [];
  }
}

// ─── friendly reason mapping (UI helper) ────────────────────────────────────
//
// Maps the stored structured error to an i18n key (+ params) so the panel can
// render a localized, human reason; the raw error_message stays available on
// expand for support. Keys live in i18n/locales/<lng>/sync.json.
export function describeSyncFailure(row: SyncFailureRow): { key: string; params?: Record<string, unknown> } {
  const status = row.http_status;
  if (status !== null) {
    if (status >= 500) return { key: 'sync:reasonServerError', params: { status } };
    if (status === 403) return { key: 'sync:reasonAccessDenied' };
    if (status === 404) return { key: 'sync:reasonNotFound' };
    if (status === 408) return { key: 'sync:reasonTimeout' };
    return { key: 'sync:reasonHttp', params: { status } };
  }
  const type = row.error_type ?? '';
  const msg = (row.error_message ?? '').toLowerCase();
  if (type === 'TimeoutError' || msg.includes('timed out') || msg.includes('timeout')) {
    return { key: 'sync:reasonTimeout' };
  }
  if (type === 'TypeError' || msg.includes('network') || msg.includes('fetch')) {
    return { key: 'sync:reasonNetwork' };
  }
  if (msg.includes('disk') || msg.includes('space') || msg.includes('write') || msg.includes('os error')) {
    return { key: 'sync:reasonDisk' };
  }
  if (type === 'SyntaxError' || msg.includes('json') || msg.includes('parse')) {
    return { key: 'sync:reasonCorrupted' };
  }
  return { key: 'sync:reasonGeneric', params: { message: row.error_message ?? '' } };
}
