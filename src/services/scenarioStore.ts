import { readTextFile, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import {
  scenarioRootDirRel,
  removeRecursive,
  assetUrl,
  blobPathRel,
  blobPathAbs,
} from './contentFs';
import { getDb } from './db';

export interface ScenarioRow {
  uniqid: string;
  title: string;
  game_type: string;
  is_product: boolean;
  remote_version: number;
  local_version: number | null;
  // CAS sync (migration 23): content-hash gate. remote_content_hash is the
  // studio's Tier-1 hash; local_content_hash is the remote hash we last fully
  // reconciled our download against. remote_version/local_version are kept for
  // display + the "downloaded?" flag only.
  remote_content_hash: string | null;
  local_content_hash: string | null;
  last_manifest_seen_at: string;
  failed_attempts: number;
}

export interface ScenarioManifestRow {
  uniqid: string;
  title: string;
  game_type: string;
  version: number;
  content_hash: string | null;
  is_product: boolean;
}

// One entry of a scenario's active manifest: a logical path -> the blob hash.
export interface ManifestFile {
  rel_path: string;
  content_hash: string;
}

function rowOut(row: {
  uniqid: string;
  title: string;
  game_type: string;
  is_product: number;
  remote_version: number;
  local_version: number | null;
  remote_content_hash: string | null;
  local_content_hash: string | null;
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

// Read game-data.json from the blob pool, resolved via the active manifest
// (scenario_files row rel_path='game-data.json' -> data_hash -> blob).
//
// Defensive: returns null on missing row, missing/empty blob, or unparseable
// JSON instead of throwing - a not-yet-committed or interrupted scenario is
// treated as "not ready" rather than crashing the caller. The next sync cycle
// completes it when remote_content_hash differs.
export async function getGameData(uniqid: string): Promise<unknown | null> {
  const hash = await activeHash(uniqid, 'game-data.json');
  if (!hash) return null;
  const rel = blobPathRel(hash);
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

// The blob hash for one file in a scenario's active manifest, or null. Matches
// the rel_path exactly, falling back to a basename match (callers sometimes
// pass a `media/`- or subdir-prefixed reference while the manifest stores the
// bare studio filename - the same flat set the protocol handler resolves).
async function activeHash(uniqid: string, relPath: string): Promise<string | null> {
  const db = await getDb();
  const base = relPath.split('/').pop() ?? relPath;
  const rows = await db.select<Array<{ content_hash: string }>>(
    `SELECT content_hash FROM scenario_files
      WHERE uniqid = $1 AND (rel_path = $2 OR rel_path = $3)
      ORDER BY (rel_path = $2) DESC LIMIT 1`,
    [uniqid, relPath, base]
  );
  return rows.length ? rows[0].content_hash : null;
}

// All rel_paths in a scenario's active manifest (incl. 'game-data.json').
export async function listManifestPaths(uniqid: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<Array<{ rel_path: string }>>(
    'SELECT rel_path FROM scenario_files WHERE uniqid = $1',
    [uniqid]
  );
  return rows.map((r) => r.rel_path);
}

// Absolute filesystem path of the blob backing one manifest file, or null.
// For "reveal in folder" / native-open actions that need a real path rather
// than a webview URL. The blob filename is the content hash (no extension).
export async function getMediaBlobAbs(uniqid: string, relPath: string): Promise<string | null> {
  const hash = await activeHash(uniqid, relPath);
  if (!hash) return null;
  return blobPathAbs(hash);
}

// Builds a { filename -> blob URL } map for every media file in a scenario's
// active manifest (game-data.json excluded). Keys include both the manifest
// rel_path and its basename, so callers that key media by either resolve. Used
// by the test modals that pre-resolve a scenario's media set. Returns {} when
// the scenario isn't downloaded.
export async function listMediaUrlMap(uniqid: string): Promise<Record<string, string>> {
  const db = await getDb();
  const rows = await db.select<Array<{ rel_path: string; content_hash: string }>>(
    'SELECT rel_path, content_hash FROM scenario_files WHERE uniqid = $1',
    [uniqid]
  );
  const map: Record<string, string> = {};
  for (const r of rows) {
    if (r.rel_path === 'game-data.json') continue;
    const url = assetUrl(await blobPathAbs(r.content_hash));
    map[r.rel_path] = url;
    const base = r.rel_path.split('/').pop();
    if (base) map[base] = url;
  }
  return map;
}

// Webview-loadable URL for a media file, resolved through the active manifest
// into its blob. `relativeMediaPath` is e.g. 'foo.png' or 'sounds/start.mp3'.
// Returns null when the file isn't in the committed manifest (not downloaded,
// or filtered out on an operator-only device).
export async function getMediaPath(
  uniqid: string,
  relativeMediaPath: string
): Promise<string | null> {
  const hash = await activeHash(uniqid, relativeMediaPath);
  if (!hash) return null;
  return assetUrl(await blobPathAbs(hash));
}

// Scenario versions are semantic DECIMALS (studio bumps 1.0 → 1.1 → …) stored in
// a VARCHAR, so the manifest can deliver them as strings. Parse to a float so
// remote_version stays numeric: a 0.1 bump is then detected by
// listPendingDownloads (`local_version <> remote_version`) and produces a
// distinct version dir (`v1.1`). Storing the raw string risks integer-affinity
// coercion in SQLite and string/number compare quirks.
export function parseScenarioVersion(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
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
         remote_content_hash, local_content_hash, last_manifest_seen_at, failed_attempts
       ) VALUES ($1, $2, $3, $4, $5, NULL, $6, NULL, $7, 0)
       ON CONFLICT(uniqid) DO UPDATE SET
         title = excluded.title,
         game_type = excluded.game_type,
         is_product = excluded.is_product,
         remote_version = excluded.remote_version,
         remote_content_hash = excluded.remote_content_hash,
         last_manifest_seen_at = excluded.last_manifest_seen_at`,
      [r.uniqid, r.title, r.game_type, r.is_product ? 1 : 0, parseScenarioVersion(r.version), r.content_hash ?? null, seenAt]
    );
  }
}

// Atomically swap a scenario's active manifest to `files` and mark it
// reconciled at `remoteContentHash`. Called once all the scenario's target
// blobs are present in the pool.
//
// The plugin-sql layer can't bind a real transaction (see syncOrchestrator's
// manifest-apply note), so ordering is chosen to keep the scenario CONTINUOUSLY
// resolvable through the commit and to be crash-safe:
//   1. INSERT OR REPLACE every new row (blobs are immutable, so upserting a
//      row that already points at the same hash is a no-op; assets never 404
//      mid-commit the way a DELETE-first would).
//   2. DELETE only the rel_paths that are gone from the new manifest.
//   3. Flip local_content_hash LAST - a crash before this leaves the old hash,
//      so the gate re-triggers and the next cycle re-commits; a crash mid-write
//      leaves at worst a harmless superset of rows (extra rows reference
//      still-pooled blobs), never an empty/unresolvable set.
// local_version mirrors remote_version so the existing "downloaded?" UI works.
export async function commitManifest(
  uniqid: string,
  files: ManifestFile[],
  remoteContentHash: string,
  remoteVersion: number
): Promise<void> {
  const db = await getDb();
  for (const f of files) {
    await db.execute(
      'INSERT OR REPLACE INTO scenario_files (uniqid, rel_path, content_hash) VALUES ($1, $2, $3)',
      [uniqid, f.rel_path, f.content_hash]
    );
  }
  const keep = files.map((f) => f.rel_path);
  const placeholders = keep.map((_, i) => `$${i + 2}`).join(', ');
  await db.execute(
    `DELETE FROM scenario_files WHERE uniqid = $1${keep.length ? ` AND rel_path NOT IN (${placeholders})` : ''}`,
    [uniqid, ...keep]
  );
  await db.execute(
    'UPDATE scenarios SET local_content_hash = $1, local_version = $2, failed_attempts = 0 WHERE uniqid = $3',
    [remoteContentHash, remoteVersion, uniqid]
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
    await db.execute('DELETE FROM scenario_files WHERE uniqid = $1', [e.uniqid]);
    // Legacy per-scenario media dir (pre-CAS); now a no-op for fresh installs.
    // The scenario's blobs become orphans reclaimed by pruneOrphanBlobs at boot.
    await removeRecursive(scenarioRootDirRel(e.uniqid));
    removed.push(e.uniqid);
  }
  return removed;
}

// Items the orchestrator should (re)download: any row whose committed content
// hash is missing or differs from the studio's. Requires a remote_content_hash
// (the studio always supplies one; a NULL means an un-migrated/edge row we
// can't CAS-sync, so skip rather than churn).
export async function listPendingDownloads(): Promise<ScenarioRow[]> {
  const db = await getDb();
  const rows = await db.select<Parameters<typeof rowOut>[0][]>(
    `SELECT * FROM scenarios
     WHERE remote_content_hash IS NOT NULL
       AND (local_content_hash IS NULL OR local_content_hash <> remote_content_hash)
     ORDER BY is_product ASC, title COLLATE NOCASE ASC`
  );
  return rows.map(rowOut);
}

// Reset every scenario to "needs download": clears local_version + failed
// attempts and deletes all on-disk media roots. The rows stay (manifest
// metadata is preserved), so the next sync cycle re-downloads each scenario
// from scratch under the current download policy. Used by the Operator-only
// toggle (services/operatorMode.ts): turning it ON re-pulls slim (game-data +
// visual), turning it OFF re-pulls the full media set. Returns the count reset.
export async function resetAllForRedownload(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<Array<{ uniqid: string }>>('SELECT uniqid FROM scenarios');
  // Clear the active manifests + reconciliation markers so every scenario
  // re-evaluates. Blobs stay in the pool - the re-pull skips any blob already
  // present (dedup), so toggling operator-only is cheap; orphaned blobs are
  // reclaimed by pruneOrphanBlobs at the next boot.
  await db.execute('DELETE FROM scenario_files');
  await db.execute('UPDATE scenarios SET local_version = NULL, local_content_hash = NULL, failed_attempts = 0');
  return rows.length;
}

// Local delete behind the playground's "Delete scenario" button. Removes the
// scenario row and its on-disk media root.
//
// This is intentionally NOT permanent: the scenario stays in the studio
// manifest, so the next sync cycle's upsertFromManifest re-inserts the row
// and the orchestrator re-downloads it. Deleting therefore doubles as a
// "reset" - the re-inserted row starts at failed_attempts = 0, giving a
// scenario stuck on repeated download failures a clean retry. Works for any
// scenario regardless of game type or whether it ever finished downloading.
export async function deleteScenario(uniqid: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM scenarios WHERE uniqid = $1', [uniqid]);
  await db.execute('DELETE FROM scenario_files WHERE uniqid = $1', [uniqid]);
  await removeRecursive(scenarioRootDirRel(uniqid));
}
