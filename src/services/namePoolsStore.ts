// name_pools_state row + sync orchestration for team-name pools.
//
// Team names themselves live on disk at media/name_pools/team_names.json
// (written by the sync orchestrator). This module owns the *sync metadata* in
// `name_pools_state` (remote_version / local_version) using the same
// incremental-version-compare pattern as cardsStore.ts.
//
// The auto-register / reuse-cards draw is server-side: in cloud mode the studio
// PHP `add_team` reads the studio DB; in LAN mode the Rust mother reads the JSON
// file at the same absolute path. This module keeps the mother's local copy
// fresh AND exposes `listPoolNames` so the UI can draw a name client-side for
// the manual "Random name" button in the launched-game team/player editor.

import { exists, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { teamNamesFileRel } from './contentFs';
import { getDb } from './db';

export interface NamePoolsStateRow {
  client_id: number;
  remote_version: number | null;
  local_version: number | null;
  fetched_at: string | null;
  failed_attempts: number;
}

export async function get(clientId: number): Promise<NamePoolsStateRow | null> {
  const db = await getDb();
  const rows = await db.select<NamePoolsStateRow[]>(
    'SELECT * FROM name_pools_state WHERE client_id = $1',
    [clientId]
  );
  return rows.length ? rows[0] : null;
}

// Record studio's reported version. Preserves local_version; creates on first sight.
export async function upsertFromManifest(
  clientId: number,
  payload: { team_names_version: number | null }
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO name_pools_state (client_id, remote_version, local_version, fetched_at, failed_attempts)
     VALUES ($1, $2, NULL, NULL, 0)
     ON CONFLICT(client_id) DO UPDATE SET remote_version = excluded.remote_version`,
    [clientId, payload.team_names_version]
  );
}

export async function markDownloaded(clientId: number, version: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE name_pools_state SET local_version = $1, fetched_at = $2, failed_attempts = 0 WHERE client_id = $3',
    [version, new Date().toISOString(), clientId]
  );
}

export async function incrementFailedAttempts(clientId: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE name_pools_state SET failed_attempts = failed_attempts + 1 WHERE client_id = $1',
    [clientId]
  );
}

// Pull needed when studio's remote_version differs from what we last persisted.
// remote_version 0 means "no pools exist" — still worth one download to clear a
// stale file, but only if we've never downloaded (local null) or it changed.
export async function needsTeamNamesDownload(clientId: number): Promise<boolean> {
  const row = await get(clientId);
  if (!row || row.remote_version === null) return false;
  return row.local_version === null || row.local_version !== row.remote_version;
}

export async function getTeamNamesJson(): Promise<unknown | null> {
  const rel = teamNamesFileRel();
  if (!(await exists(rel, { baseDir: BaseDirectory.AppData }))) return null;
  try {
    return JSON.parse(await readTextFile(rel, { baseDir: BaseDirectory.AppData }));
  } catch {
    return null;
  }
}

// On-disk shape (written by the sync orchestrator from playground.php
// `get_team_names`): { version, pools: { [audience]: { [language]: string[] } } }.
interface TeamNamesFile {
  version?: number;
  pools?: Record<string, Record<string, string[]>>;
}

// Candidate names for an (audience, language) pair, used by the manual
// "Random name" button. Prefers the requested language; if it has none, falls
// back to the first other language that does (so the button still works when a
// game's `language` meta doesn't line up with what the catalog actually holds).
// Returns [] when there's no pool file or no names for the audience at all.
export async function listPoolNames(audience: string, language: string): Promise<string[]> {
  const json = (await getTeamNamesJson()) as TeamNamesFile | null;
  const byLang = json?.pools?.[audience];
  if (!byLang) return [];
  const lang = (language || '').toLowerCase();
  if (byLang[lang]?.length) return byLang[lang];
  for (const l of Object.keys(byLang)) {
    if (byLang[l]?.length) return byLang[l];
  }
  return [];
}
