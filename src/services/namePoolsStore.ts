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

import { exists, readTextFile, writeTextFile, mkdir, BaseDirectory } from '@tauri-apps/plugin-fs';
import { teamNamesFileRel } from './contentFs';
import { apiCall } from './api';
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
// remote_version 0 means "no pools exist" - still worth one download to clear a
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

// audience -> language -> [names]
export type PoolsByAudience = Record<string, Record<string, string[]>>;

// On-disk shape (written by the sync orchestrator from playground.php
// `get_team_names`):
//   pools        - EFFECTIVE draw set (honors the own_only preference); read by
//                  the LAN mother (Rust) and the manual "Random name" button.
//   pools_global - the always-full default catalog (display only).
//   pools_client - the always-full per-client list (display only).
//   own_only     - the client's "use my own lists only" preference.
interface TeamNamesFile {
  version?: number;
  own_only?: boolean;
  pools?: PoolsByAudience;
  pools_global?: PoolsByAudience;
  pools_client?: PoolsByAudience;
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

// Client vs default breakdown of the candidate names for an (audience, language)
// pair. Bulk-assignment affordances ("Utiliser les noms de la liste") prefer the
// client's own list and only draw from the default catalog to COMPLETE when the
// client pool is too small for the team count.
export interface TieredPoolNames {
  /** The client's own list (the "custom name pool of the client"). */
  client: string[];
  /** The default/global catalog, used to complete a short client pool. */
  global: string[];
}

// Pick the best language slice from a `{ lang: [names] }` map - the requested
// language, else the first other language that has names (same fallback as
// listPoolNames). Empty when the map is missing or has no names anywhere.
function pickLangSlice(byLang: Record<string, string[]> | undefined, lang: string): string[] {
  if (!byLang) return [];
  if (byLang[lang]?.length) return byLang[lang];
  for (const l of Object.keys(byLang)) {
    if (byLang[l]?.length) return byLang[l];
  }
  return [];
}

// Return the client list and the default catalog SEPARATELY so callers can put
// the client names first and top up from the default pool. Reads the always-full
// pools_client / pools_global breakdown (independent of the own_only preference,
// which the requirement deliberately softens: custom names first, default only
// to complete). Falls back to the flat effective `pools` set (as the client
// tier) for older on-disk files that predate the breakdown.
export async function listPoolNamesTiered(audience: string, language: string): Promise<TieredPoolNames> {
  const json = (await getTeamNamesJson()) as TeamNamesFile | null;
  const lang = (language || '').toLowerCase();
  const client = pickLangSlice(json?.pools_client?.[audience], lang);
  const global = pickLangSlice(json?.pools_global?.[audience], lang);
  if (client.length === 0 && global.length === 0) {
    return { client: pickLangSlice(json?.pools?.[audience], lang), global: [] };
  }
  return { client, global };
}

// The full breakdown for the Settings → Team names tab: the default catalog and
// this client's own lists (both always complete, independent of the own_only
// preference), plus the current preference value. Missing file -> empty view.
export interface TeamNamesView {
  ownOnly: boolean;
  global: PoolsByAudience;
  client: PoolsByAudience;
}

export async function getTeamNamesView(): Promise<TeamNamesView> {
  const json = (await getTeamNamesJson()) as TeamNamesFile | null;
  return {
    ownOnly: Boolean(json?.own_only),
    global: json?.pools_global ?? {},
    client: json?.pools_client ?? {},
  };
}

// Pull the latest pools straight from studio and refresh the on-disk file. Used
// when the Team names tab opens so it always reflects the current catalog AND
// self-heals the file shape on devices whose last download predates the
// global/client breakdown (a plain PHP deploy doesn't bump the version, so the
// regular version-gated sync would never re-pull it). Throws when offline - the
// caller falls back to the local file.
export async function refreshFromServer(clientId: number): Promise<TeamNamesView> {
  const res = await apiCall<TeamNamesFile>('playground', 'get_team_names', { bearer: true });
  const file: TeamNamesFile = {
    version: res?.version,
    own_only: res?.own_only,
    pools: res?.pools,
    pools_global: res?.pools_global,
    pools_client: res?.pools_client,
  };
  await writeTeamNamesJson(file);
  if (typeof file.version === 'number') {
    await markDownloaded(clientId, file.version);
  }
  return {
    ownOnly: Boolean(file.own_only),
    global: file.pools_global ?? {},
    client: file.pools_client ?? {},
  };
}

// Overwrite the local team_names.json (used to apply a toggle immediately,
// without waiting for the next sync cycle to re-pull it).
async function writeTeamNamesJson(payload: unknown): Promise<void> {
  await mkdir('media/name_pools', { baseDir: BaseDirectory.AppData, recursive: true });
  await writeTextFile(teamNamesFileRel(), JSON.stringify(payload), {
    baseDir: BaseDirectory.AppData,
  });
}

// Persist the client-wide "use my own lists only" preference. Writes through to
// the studio (so the cloud add_team draw honors it too), then mirrors the fresh
// payload - already re-filtered server-side - onto disk so the LAN mother and
// the manual draw pick it up at once. Returns the new view for the UI.
export async function setOwnOnly(clientId: number, ownOnly: boolean): Promise<TeamNamesView> {
  const res = await apiCall<TeamNamesFile>('playground', 'set_team_names_own_only', {
    method: 'POST',
    bearer: true,
    body: { own_only: ownOnly },
  });
  // Write only the team-names shape to disk (the response also carries an
  // `auth_state` block that apiCall already consumed) so the on-disk file
  // matches what the get_team_names download produces.
  const file: TeamNamesFile = {
    version: res?.version,
    own_only: res?.own_only,
    pools: res?.pools,
    pools_global: res?.pools_global,
    pools_client: res?.pools_client,
  };
  await writeTeamNamesJson(file);
  if (typeof file.version === 'number') {
    await markDownloaded(clientId, file.version);
  }
  return {
    ownOnly: Boolean(file.own_only ?? ownOnly),
    global: file.pools_global ?? {},
    client: file.pools_client ?? {},
  };
}
