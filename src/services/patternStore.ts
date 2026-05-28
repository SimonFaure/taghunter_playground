import { getDb } from './db';

export interface PatternRow {
  pattern_uniqid: string;
  name: string;
  game_type: string;
  pattern_slug: string | null;
  description: string | null;
  is_default: boolean;
  remote_version: number;
  local_version: number | null;
  pattern_data_json: string | null;
  last_manifest_seen_at: string;
  failed_attempts: number;
}

export interface PatternManifestRow {
  pattern_uniqid: string;
  name: string;
  game_type: string;
  version: number;
  is_default: boolean;
}

function rowOut(row: Omit<PatternRow, 'is_default'> & { is_default: number }): PatternRow {
  return { ...row, is_default: Boolean(row.is_default) };
}

export async function list(filter?: { isDefault?: boolean; gameType?: string }): Promise<PatternRow[]> {
  const db = await getDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter?.isDefault !== undefined) {
    where.push(`is_default = $${args.length + 1}`);
    args.push(filter.isDefault ? 1 : 0);
  }
  if (filter?.gameType) {
    where.push(`game_type = $${args.length + 1}`);
    args.push(filter.gameType);
  }
  const sql =
    'SELECT * FROM patterns' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY game_type, name COLLATE NOCASE ASC';
  const rows = await db.select<Parameters<typeof rowOut>[0][]>(sql, args);
  return rows.map(rowOut);
}

export async function get(patternUniqid: string): Promise<PatternRow | null> {
  const db = await getDb();
  const rows = await db.select<Parameters<typeof rowOut>[0][]>(
    'SELECT * FROM patterns WHERE pattern_uniqid = $1',
    [patternUniqid]
  );
  return rows.length ? rowOut(rows[0]) : null;
}

export async function getData(patternUniqid: string): Promise<unknown | null> {
  const row = await get(patternUniqid);
  if (!row || !row.pattern_data_json) return null;
  try {
    return JSON.parse(row.pattern_data_json);
  } catch {
    return null;
  }
}

export interface PatternRoutingItem {
  item_index: number;
  assignment_type: string;
  station_key_number: number;
}

// Studio writes pattern_data as `[{index, assignments: {key: value, ...}}]`.
// Older / ZIP-imported patterns may have stored the flat `pattern_items`
// shape directly. Accept both and emit the flat form callers actually use.
export function flattenAssignments(data: unknown): PatternRoutingItem[] {
  if (!data) return [];
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as { pattern_data?: unknown }).pattern_data)
      ? (data as { pattern_data: unknown[] }).pattern_data
      : null;
  if (!arr) return [];

  const out: PatternRoutingItem[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;

    if ('item_index' in r && 'assignment_type' in r) {
      const item_index = Number(r.item_index);
      const station_key_number = Number(r.station_key_number);
      if (Number.isFinite(item_index) && Number.isFinite(station_key_number)) {
        out.push({
          item_index,
          assignment_type: String(r.assignment_type),
          station_key_number,
        });
      }
      continue;
    }

    const index = Number(r.index);
    const assignments = r.assignments as Record<string, unknown> | undefined;
    if (!Number.isFinite(index) || !assignments || typeof assignments !== 'object') continue;
    for (const [key, val] of Object.entries(assignments)) {
      const station = Number(val);
      if (!Number.isFinite(station)) continue;
      out.push({ item_index: index, assignment_type: key, station_key_number: station });
    }
  }
  return out;
}

export async function getRouting(patternUniqid: string): Promise<PatternRoutingItem[]> {
  const data = await getData(patternUniqid);
  return flattenAssignments(data);
}

// Compatibility shape for legacy Mystery game-modal scoring loops, which
// expect `{enigma_id, good_answers[], wrong_answers[]}` (CSV-era format).
// Reconstructed from the routing rows: one good_answer_station + one
// wrong_answer_station per enigma index in Studio's current data model.
export interface PatternEnigma {
  id: string;
  pattern_id: string;
  enigma_id: string;
  good_answers: string[];
  wrong_answers: string[];
}

export async function getMysteryEnigmas(patternUniqid: string): Promise<PatternEnigma[]> {
  const routing = await getRouting(patternUniqid);
  const byEnigma = new Map<number, { good: string[]; wrong: string[] }>();
  for (const r of routing) {
    let bucket = byEnigma.get(r.item_index);
    if (!bucket) {
      bucket = { good: [], wrong: [] };
      byEnigma.set(r.item_index, bucket);
    }
    if (r.assignment_type === 'good_answer_station') {
      bucket.good.push(String(r.station_key_number));
    } else if (r.assignment_type === 'wrong_answer_station') {
      bucket.wrong.push(String(r.station_key_number));
    }
  }
  return Array.from(byEnigma.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([idx, bucket]) => ({
      id: String(idx),
      pattern_id: patternUniqid,
      enigma_id: String(idx),
      good_answers: bucket.good,
      wrong_answers: bucket.wrong,
    }));
}

// Tracks: map each checkpoint index → the station key number(s) that count as
// a "hit" for that checkpoint. A checkpoint is binary (reached or not), so we
// bucket ALL routing stations by item_index regardless of `assignment_type`
// (tracks patterns may use a single `checkpoint_station` assignment or reuse
// the mystery `good_answer_station` label — either works here).
//
// NOTE (Slice C): this mapping is the one piece the design grill left open
// (checkpoint → station code). Verify against a real tracks pattern once one
// exists; the any-station-hit interpretation is intentionally liberal.
export async function getTracksCheckpointStations(patternUniqid: string): Promise<Map<number, number[]>> {
  const routing = await getRouting(patternUniqid);
  const map = new Map<number, number[]>();
  for (const r of routing) {
    const arr = map.get(r.item_index) ?? [];
    arr.push(r.station_key_number);
    map.set(r.item_index, arr);
  }
  return map;
}

export async function listGameTypes(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<Array<{ game_type: string }>>(
    'SELECT DISTINCT game_type FROM patterns ORDER BY game_type'
  );
  return rows.map(r => r.game_type);
}

// Versions may be semantic decimals (e.g. 1.0 → 1.1) delivered as strings (the
// studio column is VARCHAR). Parse to a float so `remote_version` stays numeric
// and a 0.1 bump is detected by `listPendingDownloads` — same fix as scenarios.
function parseManifestVersion(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

export async function upsertFromManifest(rows: PatternManifestRow[], seenAt: string): Promise<void> {
  const db = await getDb();
  for (const r of rows) {
    await db.execute(
      `INSERT INTO patterns (
         pattern_uniqid, name, game_type, pattern_slug, description, is_default,
         remote_version, local_version, pattern_data_json, last_manifest_seen_at,
         failed_attempts
       ) VALUES ($1, $2, $3, NULL, NULL, $4, $5, NULL, NULL, $6, 0)
       ON CONFLICT(pattern_uniqid) DO UPDATE SET
         name = excluded.name,
         game_type = excluded.game_type,
         is_default = excluded.is_default,
         remote_version = excluded.remote_version,
         last_manifest_seen_at = excluded.last_manifest_seen_at`,
      [r.pattern_uniqid, r.name, r.game_type, r.is_default ? 1 : 0, parseManifestVersion(r.version), seenAt]
    );
  }
}

// Pattern downloads return a JSON payload (not files); store inline.
export async function markDownloaded(
  patternUniqid: string,
  version: number,
  payload: {
    pattern_slug?: string | null;
    description?: string | null;
    pattern_data?: unknown;
  }
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE patterns SET
       local_version = $1,
       pattern_slug = $2,
       description = $3,
       pattern_data_json = $4,
       failed_attempts = 0
     WHERE pattern_uniqid = $5`,
    [
      version,
      payload.pattern_slug ?? null,
      payload.description ?? null,
      payload.pattern_data === undefined ? null : JSON.stringify(payload.pattern_data),
      patternUniqid,
    ]
  );
}

export async function incrementFailedAttempts(patternUniqid: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE patterns SET failed_attempts = failed_attempts + 1 WHERE pattern_uniqid = $1',
    [patternUniqid]
  );
}

// Locally remove a single pattern from this device. This only touches the
// local SQLite cache — the pattern still exists in the user's cloud account,
// so the next sync cycle will re-add it (see `upsertFromManifest`). Used by
// the Cards & Patterns screen's per-pattern delete action.
export async function remove(patternUniqid: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM patterns WHERE pattern_uniqid = $1', [patternUniqid]);
}

export async function tombstoneMissing(keepUniqids: string[]): Promise<string[]> {
  const db = await getDb();
  const existing = await db.select<Array<{ pattern_uniqid: string }>>(
    'SELECT pattern_uniqid FROM patterns'
  );
  const keep = new Set(keepUniqids);
  const removed: string[] = [];
  for (const e of existing) {
    if (keep.has(e.pattern_uniqid)) continue;
    await db.execute('DELETE FROM patterns WHERE pattern_uniqid = $1', [e.pattern_uniqid]);
    removed.push(e.pattern_uniqid);
  }
  return removed;
}

export async function listPendingDownloads(): Promise<PatternRow[]> {
  const db = await getDb();
  const rows = await db.select<Parameters<typeof rowOut>[0][]>(
    `SELECT * FROM patterns
     WHERE local_version IS NULL OR local_version <> remote_version
     ORDER BY is_default DESC, game_type, name COLLATE NOCASE ASC`
  );
  return rows.map(rowOut);
}

export async function count(filter?: { downloaded?: boolean }): Promise<number> {
  const db = await getDb();
  const where = filter?.downloaded === true
    ? ' WHERE local_version IS NOT NULL'
    : filter?.downloaded === false
      ? ' WHERE local_version IS NULL'
      : '';
  const rows = await db.select<Array<{ n: number }>>(
    `SELECT COUNT(*) AS n FROM patterns${where}`
  );
  return rows[0]?.n ?? 0;
}
