import { getDb } from './db';
import type { ReportLayout } from './reportLayout';
import { isReportLayout } from './reportLayout';

// Synced per-game-type mission-report PDF layout DEFAULTS (admin-owned, global).
// Studio is the source of truth (playground.php get_report_layouts); this caches
// the latest set locally so the report renderer can use the studio-designed
// default offline. Per-scenario overrides do NOT live here - they ride in the
// scenario game_data and win over these defaults (see reportLayout.resolve...).
//
// Single global version (no client scope), tracked in report_layouts_state like
// recovery_codes_state but with id pinned to 1.

const STATE_ID = 1;

/** The synced default layout for a game type, or null if none cached/valid. */
export async function getSyncedLayout(gameType: string): Promise<ReportLayout | null> {
  const db = await getDb();
  const rows = await db.select<{ layout_json: string }[]>(
    'SELECT layout_json FROM report_layouts WHERE game_type = $1',
    [gameType.toLowerCase()],
  );
  if (!rows.length) return null;
  try {
    const parsed = JSON.parse(rows[0].layout_json);
    return isReportLayout(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Replace the whole synced set (one row per game type). The version is
 * recorded separately in report_layouts_state by the sync caller. */
// Every synced layout by game type (to push to the LAN mother).
export async function listAll(): Promise<Record<string, unknown>> {
  const db = await getDb();
  const rows = await db.select<Array<{ game_type: string; layout_json: string }>>(
    'SELECT game_type, layout_json FROM report_layouts'
  );
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.game_type] = JSON.parse(r.layout_json);
    } catch {
      /* skip a corrupt row */
    }
  }
  return out;
}

export async function replaceLayouts(
  layouts: Record<string, unknown>,
  _version: number,
): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM report_layouts');
  for (const [gameType, layout] of Object.entries(layouts ?? {})) {
    if (!isReportLayout(layout)) continue;
    await db.execute(
      'INSERT INTO report_layouts (game_type, layout_json) VALUES ($1, $2)',
      [gameType.toLowerCase(), JSON.stringify(layout)],
    );
  }
}

// ───────────────────────── sync state (report_layouts_state) ─────────────────

export interface ReportLayoutsStateRow {
  id: number;
  remote_version: number | null;
  local_version: number | null;
  fetched_at: string | null;
  failed_attempts: number;
}

export async function getState(): Promise<ReportLayoutsStateRow | null> {
  const db = await getDb();
  const rows = await db.select<ReportLayoutsStateRow[]>(
    'SELECT * FROM report_layouts_state WHERE id = $1',
    [STATE_ID],
  );
  return rows.length ? rows[0] : null;
}

/** Record studio's advertised version. Preserves local_version. */
export async function upsertFromManifest(payload: { report_layouts_version: number | null }): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO report_layouts_state (id, remote_version, local_version, fetched_at, failed_attempts)
     VALUES ($1, $2, NULL, NULL, 0)
     ON CONFLICT(id) DO UPDATE SET remote_version = excluded.remote_version`,
    [STATE_ID, payload.report_layouts_version],
  );
}

export async function markDownloaded(version: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE report_layouts_state SET local_version = $1, fetched_at = $2, failed_attempts = 0 WHERE id = $3',
    [version, new Date().toISOString(), STATE_ID],
  );
}

export async function incrementFailedAttempts(): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE report_layouts_state SET failed_attempts = failed_attempts + 1 WHERE id = $1',
    [STATE_ID],
  );
}

/** Pull needed when studio's version differs from what we last persisted. */
export async function needsDownload(): Promise<boolean> {
  const row = await getState();
  if (!row || row.remote_version === null || row.remote_version === 0) return false;
  return row.local_version === null || row.local_version !== row.remote_version;
}
