import { getDb } from './db';

export interface LayoutRow {
  id: number;
  game_type: string;
  remote_version: number;
  local_version: number | null;
  layout_data_json: string | null;
  last_manifest_seen_at: string;
  failed_attempts: number;
}

export interface LayoutManifestRow {
  id: number;
  game_type: string;
  version: number;
}

export async function list(filter?: { gameType?: string }): Promise<LayoutRow[]> {
  const db = await getDb();
  const where = filter?.gameType ? ' WHERE game_type = $1' : '';
  const args = filter?.gameType ? [filter.gameType] : [];
  return db.select<LayoutRow[]>(
    `SELECT * FROM layouts${where} ORDER BY game_type, remote_version DESC`,
    args
  );
}

export async function get(id: number): Promise<LayoutRow | null> {
  const db = await getDb();
  const rows = await db.select<LayoutRow[]>('SELECT * FROM layouts WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function getData(id: number): Promise<unknown | null> {
  const row = await get(id);
  if (!row || !row.layout_data_json) return null;
  try {
    return JSON.parse(row.layout_data_json);
  } catch {
    return null;
  }
}

export async function upsertFromManifest(rows: LayoutManifestRow[], seenAt: string): Promise<void> {
  const db = await getDb();
  for (const r of rows) {
    await db.execute(
      `INSERT INTO layouts (
         id, game_type, remote_version, local_version, layout_data_json,
         last_manifest_seen_at, failed_attempts
       ) VALUES ($1, $2, $3, NULL, NULL, $4, 0)
       ON CONFLICT(id) DO UPDATE SET
         game_type = excluded.game_type,
         remote_version = excluded.remote_version,
         last_manifest_seen_at = excluded.last_manifest_seen_at`,
      [r.id, r.game_type, r.version, seenAt]
    );
  }
}

export async function markDownloaded(id: number, version: number, layoutData: unknown): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE layouts SET
       local_version = $1,
       layout_data_json = $2,
       failed_attempts = 0
     WHERE id = $3`,
    [version, JSON.stringify(layoutData), id]
  );
}

export async function incrementFailedAttempts(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE layouts SET failed_attempts = failed_attempts + 1 WHERE id = $1',
    [id]
  );
}

export async function tombstoneMissing(keepIds: number[]): Promise<number[]> {
  const db = await getDb();
  const existing = await db.select<Array<{ id: number }>>('SELECT id FROM layouts');
  const keep = new Set(keepIds);
  const removed: number[] = [];
  for (const e of existing) {
    if (keep.has(e.id)) continue;
    await db.execute('DELETE FROM layouts WHERE id = $1', [e.id]);
    removed.push(e.id);
  }
  return removed;
}

export async function listPendingDownloads(): Promise<LayoutRow[]> {
  const db = await getDb();
  return db.select<LayoutRow[]>(
    `SELECT * FROM layouts
     WHERE local_version IS NULL OR local_version <> remote_version
     ORDER BY game_type, id`
  );
}

export async function count(filter?: { downloaded?: boolean }): Promise<number> {
  const db = await getDb();
  const where = filter?.downloaded === true
    ? ' WHERE local_version IS NOT NULL'
    : filter?.downloaded === false
      ? ' WHERE local_version IS NULL'
      : '';
  const rows = await db.select<Array<{ n: number }>>(
    `SELECT COUNT(*) AS n FROM layouts${where}`
  );
  return rows[0]?.n ?? 0;
}
