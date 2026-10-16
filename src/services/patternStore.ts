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
  // 1 when this pattern was imported from a local file (manual upload) rather
  // than synced from the cloud - keeps the sync tombstone from deleting it.
  is_local: boolean;
}

export interface PatternManifestRow {
  pattern_uniqid: string;
  name: string;
  game_type: string;
  version: number;
  is_default: boolean;
}

function rowOut(
  row: Omit<PatternRow, 'is_default' | 'is_local'> & { is_default: number; is_local?: number }
): PatternRow {
  return { ...row, is_default: Boolean(row.is_default), is_local: Boolean(row.is_local) };
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

// Station id → station "number" (the si_balises.station_name, e.g. "1") lookup
// delivered alongside the pattern by `download_pattern`. Assignment values are
// station ids; this resolves them to the human-facing number shown in details.
// Returns `{}` for patterns downloaded before the stations map was introduced
// (they re-populate on the next download).
export async function getStations(patternUniqid: string): Promise<Record<string, string>> {
  const data = await getData(patternUniqid);
  if (!data || typeof data !== 'object') return {};
  const raw = (data as { stations?: unknown }).stations;
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(raw as Record<string, unknown>)) {
    if (name !== null && name !== undefined) out[id] = String(name);
  }
  return out;
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

// Tracks: map each checkpoint's 1-based ORDINAL POSITION → the station key
// number(s) that count as a "hit" for that checkpoint. A checkpoint is binary
// (reached or not), so we bucket ALL routing stations of a pattern row
// regardless of `assignment_type` (tracks patterns may use a single
// `checkpoint_station` assignment or reuse the mystery `good_answer_station`
// label - either works here).
//
// The binding is POSITIONAL, not by item_index value: pattern rows are sorted
// by item_index and the Nth row binds to the Nth checkpoint. This is the
// contract the studio side already implements (`useTracksPatternStations`, which
// is what the author sees in the Checkpoints section) and what the launch
// modal's row-count guardrail assumes. Keying on the raw item_index instead -
// as this did until 2026-09-07 - broke every checkpoint from the first gap
// onwards whenever a pattern row had been deleted (`removeRow` in the pattern
// editor does NOT reindex, so indices go 1,2,3,4,6,7,…): studio showed the
// right stations, the game looked up ones that did not exist and scored the
// whole course as missed. Retours points 87 + 89.
export async function getTracksCheckpointStations(patternUniqid: string): Promise<Map<number, number[]>> {
  const routing = await getRouting(patternUniqid);
  const byItemIndex = new Map<number, number[]>();
  for (const r of routing) {
    const arr = byItemIndex.get(r.item_index) ?? [];
    arr.push(r.station_key_number);
    byItemIndex.set(r.item_index, arr);
  }
  const map = new Map<number, number[]>();
  Array.from(byItemIndex.keys())
    .sort((a, b) => a - b)
    .forEach((itemIndex, pos) => {
      map.set(pos + 1, byItemIndex.get(itemIndex)!);
    });
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
// and a 0.1 bump is detected by `listPendingDownloads` - same fix as scenarios.
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

// A pattern fetched from the LAN mother that this device's manifest doesn't
// list yet (newer than our last cloud sync, or imported on the mother). Creates
// the row only; an existing one is left to the manifest. A mother-imported
// pattern stays is_local so our cloud sync never tombstones it.
export async function insertFromPeerIfMissing(p: {
  pattern_uniqid: string;
  name?: string;
  game_type?: string;
  is_default?: boolean;
  is_local?: boolean;
  version: number;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT OR IGNORE INTO patterns (
       pattern_uniqid, name, game_type, pattern_slug, description, is_default,
       remote_version, local_version, pattern_data_json, last_manifest_seen_at,
       failed_attempts, is_local
     ) VALUES ($1, $2, $3, NULL, NULL, $4, $5, NULL, NULL, $6, 0, $7)`,
    [
      p.pattern_uniqid,
      p.name ?? p.pattern_uniqid,
      p.game_type ?? 'tracks',
      p.is_default ? 1 : 0,
      parseManifestVersion(p.version),
      new Date().toISOString(),
      p.is_local ? 1 : 0,
    ]
  );
}

// A downloaded pattern in the studio's download_pattern shape (plus manifest
// fields), to push to the LAN mother. null when not downloaded.
export async function exportForPeer(patternUniqid: string): Promise<{
  pattern_uniqid: string;
  name: string;
  game_type: string;
  pattern_slug: string | null;
  description: string | null;
  is_default: boolean;
  is_local: boolean;
  version: number;
  pattern_data: unknown;
  stations: Record<string, string> | null;
} | null> {
  const row = await get(patternUniqid);
  if (!row || row.local_version == null || !row.pattern_data_json) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(row.pattern_data_json);
  } catch {
    return null;
  }
  // `{ pattern_data, stations }` envelope; older rows hold the bare data.
  const env = parsed && typeof parsed === 'object' && 'pattern_data' in parsed
    ? (parsed as { pattern_data: unknown; stations?: Record<string, string> | null })
    : { pattern_data: parsed, stations: null };
  return {
    pattern_uniqid: row.pattern_uniqid,
    name: row.name,
    game_type: row.game_type,
    pattern_slug: row.pattern_slug ?? null,
    description: row.description ?? null,
    is_default: row.is_default,
    is_local: row.is_local,
    version: row.local_version,
    pattern_data: env.pattern_data,
    stations: env.stations ?? null,
  };
}

// Pattern downloads return a JSON payload (not files); store inline.
export async function markDownloaded(
  patternUniqid: string,
  version: number,
  payload: {
    pattern_slug?: string | null;
    description?: string | null;
    pattern_data?: unknown;
    stations?: Record<string, string> | null;
  }
): Promise<void> {
  const db = await getDb();
  // Persist as a `{ pattern_data, stations }` envelope. All readers (flatten,
  // clash parsing) already accept the `{ pattern_data: [...] }` shape, and the
  // stations map lets the details view show each station's number alongside id.
  const json =
    payload.pattern_data === undefined
      ? null
      : JSON.stringify({ pattern_data: payload.pattern_data, stations: payload.stations ?? null });
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
      json,
      patternUniqid,
    ]
  );
}

// Import a pattern from a local file (manual upload), fully downloaded and
// flagged is_local = 1 so the sync tombstone won't remove it. Stores the same
// `{ pattern_data, stations }` envelope cloud downloads use, so every reader
// (flatten/routing/clash) works unchanged.
export async function importLocal(
  p: {
    pattern_uniqid: string;
    name: string;
    game_type: string;
    version: number;
    is_default: boolean;
    pattern_slug?: string | null;
    description?: string | null;
    pattern_data: unknown;
    stations?: Record<string, string> | null;
  },
  seenAt: string
): Promise<void> {
  const db = await getDb();
  const json = JSON.stringify({ pattern_data: p.pattern_data, stations: p.stations ?? null });
  await db.execute(
    `INSERT INTO patterns (
       pattern_uniqid, name, game_type, pattern_slug, description, is_default,
       remote_version, local_version, pattern_data_json, last_manifest_seen_at,
       failed_attempts, is_local
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, 0, 1)
     ON CONFLICT(pattern_uniqid) DO UPDATE SET
       name = excluded.name,
       game_type = excluded.game_type,
       pattern_slug = excluded.pattern_slug,
       description = excluded.description,
       is_default = excluded.is_default,
       remote_version = excluded.remote_version,
       local_version = excluded.local_version,
       pattern_data_json = excluded.pattern_data_json,
       last_manifest_seen_at = excluded.last_manifest_seen_at,
       is_local = 1`,
    [
      p.pattern_uniqid,
      p.name,
      p.game_type,
      p.pattern_slug ?? null,
      p.description ?? null,
      p.is_default ? 1 : 0,
      p.version,
      json,
      seenAt,
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
// local SQLite cache - the pattern still exists in the user's cloud account,
// so the next sync cycle will re-add it (see `upsertFromManifest`). Used by
// the Cards & Patterns screen's per-pattern delete action.
export async function remove(patternUniqid: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM patterns WHERE pattern_uniqid = $1', [patternUniqid]);
}

export async function tombstoneMissing(keepUniqids: string[]): Promise<string[]> {
  const db = await getDb();
  // Only cloud-synced patterns are subject to tombstoning. Locally-imported
  // ones (is_local = 1) are never in the cloud manifest, so exclude them.
  const existing = await db.select<Array<{ pattern_uniqid: string }>>(
    'SELECT pattern_uniqid FROM patterns WHERE is_local = 0'
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
