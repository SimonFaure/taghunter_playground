import { getDb } from './db';

/**
 * The set of admin-managed translation rows we expect to receive from the
 * studio manifest. Used by `tombstoneMissing` to safely delete cached rows
 * for keys no longer present (admin deleted) without affecting unrelated
 * tables.
 */
export const KNOWN_TRANSLATION_KEYS = ['tagquest_translations'] as const;
export type TranslationKey = (typeof KNOWN_TRANSLATION_KEYS)[number];

export interface TranslationRow {
  key: string;
  value_json: string;
  remote_version: number;
  last_manifest_seen_at: string;
}

export interface TranslationManifestRow {
  key: string;
  value: unknown;
  version: number;
}

export async function upsertFromManifest(
  rows: TranslationManifestRow[],
  seenAt: string,
): Promise<void> {
  if (!rows || rows.length === 0) return;
  const db = await getDb();
  for (const r of rows) {
    await db.execute(
      `INSERT INTO admin_translations (key, value_json, remote_version, last_manifest_seen_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         remote_version = excluded.remote_version,
         last_manifest_seen_at = excluded.last_manifest_seen_at`,
      [r.key, JSON.stringify(r.value ?? null), r.version, seenAt],
    );
  }
}

export async function tombstoneMissing(keepKeys: readonly string[]): Promise<string[]> {
  const db = await getDb();
  const keep = new Set(keepKeys);
  const existing = await db.select<Array<{ key: string }>>(
    'SELECT key FROM admin_translations',
  );
  const removed: string[] = [];
  for (const e of existing) {
    if (keep.has(e.key)) continue;
    await db.execute('DELETE FROM admin_translations WHERE key = $1', [e.key]);
    removed.push(e.key);
  }
  return removed;
}

export async function get(key: string): Promise<TranslationRow | null> {
  const db = await getDb();
  const rows = await db.select<TranslationRow[]>(
    'SELECT * FROM admin_translations WHERE key = $1',
    [key],
  );
  return rows[0] ?? null;
}

export async function getValue<T = unknown>(key: string): Promise<T | null> {
  const row = await get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}
