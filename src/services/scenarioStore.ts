import { readTextFile, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import {
  scenarioVersionDirAbs,
  scenarioVersionDirRel,
  scenarioRootDirRel,
  removeRecursive,
  assetUrl,
} from './contentFs';
import { join } from '@tauri-apps/api/path';
import { getDb } from './db';

export interface ScenarioRow {
  uniqid: string;
  title: string;
  game_type: string;
  is_product: boolean;
  remote_version: number;
  local_version: number | null;
  last_manifest_seen_at: string;
  failed_attempts: number;
}

export interface ScenarioManifestRow {
  uniqid: string;
  title: string;
  game_type: string;
  version: number;
  is_product: boolean;
}

function rowOut(row: {
  uniqid: string;
  title: string;
  game_type: string;
  is_product: number;
  remote_version: number;
  local_version: number | null;
  last_manifest_seen_at: string;
  failed_attempts: number;
}): ScenarioRow {
  return { ...row, is_product: Boolean(row.is_product) };
}

export async function list(filter?: { isProduct?: boolean; downloaded?: boolean }): Promise<ScenarioRow[]> {
  const db = await getDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter?.isProduct !== undefined) {
    where.push(`is_product = $${args.length + 1}`);
    args.push(filter.isProduct ? 1 : 0);
  }
  if (filter?.downloaded === true) where.push('local_version IS NOT NULL');
  if (filter?.downloaded === false) where.push('local_version IS NULL');
  const sql =
    'SELECT * FROM scenarios' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY title COLLATE NOCASE ASC';
  const rows = await db.select<Parameters<typeof rowOut>[0][]>(sql, args);
  return rows.map(rowOut);
}

export async function get(uniqid: string): Promise<ScenarioRow | null> {
  const db = await getDb();
  const rows = await db.select<Parameters<typeof rowOut>[0][]>(
    'SELECT * FROM scenarios WHERE uniqid = $1',
    [uniqid]
  );
  return rows.length ? rowOut(rows[0]) : null;
}

export async function count(filter?: { downloaded?: boolean }): Promise<number> {
  const db = await getDb();
  const where = filter?.downloaded === true
    ? ' WHERE local_version IS NOT NULL'
    : filter?.downloaded === false
      ? ' WHERE local_version IS NULL'
      : '';
  const rows = await db.select<Array<{ n: number }>>(
    `SELECT COUNT(*) AS n FROM scenarios${where}`
  );
  return rows[0]?.n ?? 0;
}

// Read game-data.json from the current downloaded version dir.
//
// Defensive: returns null on missing file, empty file, or unparseable JSON
// instead of throwing. A 0-byte / truncated file usually means a previous
// download was interrupted or the server returned an empty body — in that
// case we treat the scenario as "not ready" rather than crashing the caller.
// The next sync cycle will re-download if remote_version != local_version;
// if they match, the user can force a re-pull via "Sync now".
export async function getGameData(uniqid: string): Promise<unknown | null> {
  const row = await get(uniqid);
  if (!row || row.local_version === null) return null;
  const rel = `${scenarioVersionDirRel(uniqid, row.local_version)}/game-data.json`;
  if (!(await exists(rel, { baseDir: BaseDirectory.AppData }))) return null;
  const text = await readTextFile(rel, { baseDir: BaseDirectory.AppData });
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    console.warn(`[scenarioStore] game-data.json invalid for ${uniqid}:`, err);
    return null;
  }
}

// Returns a webview-loadable URL for a media file in the current version dir.
// `relativeMediaPath` is e.g. 'images/foo.png' or 'sounds/start.mp3'.
// Optional `versionOverride` lets a gameplay session pin to the version it
// snapshotted at start (Q12 — versioned paths must not race a mid-session bump).
export async function getMediaPath(
  uniqid: string,
  relativeMediaPath: string,
  versionOverride?: number
): Promise<string | null> {
  let version = versionOverride;
  if (version === undefined) {
    const row = await get(uniqid);
    if (!row || row.local_version === null) return null;
    version = row.local_version;
  }
  const dirAbs = await scenarioVersionDirAbs(uniqid, version);
  const fileAbs = await join(dirAbs, relativeMediaPath);
  return assetUrl(fileAbs);
}

// Bulk upsert from a manifest. Called inside the orchestrator's manifest
// transaction. Existing local_version is preserved; only remote_version and
// metadata are updated.
export async function upsertFromManifest(rows: ScenarioManifestRow[], seenAt: string): Promise<void> {
  const db = await getDb();
  for (const r of rows) {
    await db.execute(
      `INSERT INTO scenarios (
         uniqid, title, game_type, is_product, remote_version, local_version,
         last_manifest_seen_at, failed_attempts
       ) VALUES ($1, $2, $3, $4, $5, NULL, $6, 0)
       ON CONFLICT(uniqid) DO UPDATE SET
         title = excluded.title,
         game_type = excluded.game_type,
         is_product = excluded.is_product,
         remote_version = excluded.remote_version,
         last_manifest_seen_at = excluded.last_manifest_seen_at`,
      [r.uniqid, r.title, r.game_type, r.is_product ? 1 : 0, r.version, seenAt]
    );
  }
}

export async function markDownloaded(uniqid: string, version: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE scenarios SET local_version = $1, failed_attempts = 0 WHERE uniqid = $2',
    [version, uniqid]
  );
}

export async function incrementFailedAttempts(uniqid: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE scenarios SET failed_attempts = failed_attempts + 1 WHERE uniqid = $1',
    [uniqid]
  );
}

// Tombstone any scenario whose uniqid is not in `keepUniqids`. Removes the row
// AND its on-disk media root.
export async function tombstoneMissing(keepUniqids: string[]): Promise<string[]> {
  const db = await getDb();
  const existing = await db.select<Array<{ uniqid: string }>>('SELECT uniqid FROM scenarios');
  const keep = new Set(keepUniqids);
  const removed: string[] = [];
  for (const e of existing) {
    if (keep.has(e.uniqid)) continue;
    await db.execute('DELETE FROM scenarios WHERE uniqid = $1', [e.uniqid]);
    await removeRecursive(scenarioRootDirRel(e.uniqid));
    removed.push(e.uniqid);
  }
  return removed;
}

// Items the orchestrator should download: any row where local_version is NULL
// or differs from remote_version.
export async function listPendingDownloads(): Promise<ScenarioRow[]> {
  const db = await getDb();
  const rows = await db.select<Parameters<typeof rowOut>[0][]>(
    `SELECT * FROM scenarios
     WHERE local_version IS NULL OR local_version <> remote_version
     ORDER BY is_product ASC, title COLLATE NOCASE ASC`
  );
  return rows.map(rowOut);
}

// Local delete behind the playground's "Delete scenario" button. Removes the
// scenario row and its on-disk media root.
//
// This is intentionally NOT permanent: the scenario stays in the studio
// manifest, so the next sync cycle's upsertFromManifest re-inserts the row
// and the orchestrator re-downloads it. Deleting therefore doubles as a
// "reset" — the re-inserted row starts at failed_attempts = 0, giving a
// scenario stuck on repeated download failures a clean retry. Works for any
// scenario regardless of game type or whether it ever finished downloading.
export async function deleteScenario(uniqid: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM scenarios WHERE uniqid = $1', [uniqid]);
  await removeRecursive(scenarioRootDirRel(uniqid));
}
