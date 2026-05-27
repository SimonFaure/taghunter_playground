// Local SQLite store for named, scenario-assigned saved launch presets.
//
// A "launch config" is the step-1 settings of the launch wizard (the
// GameConfig blob) MINUS the per-instance `name` and the per-session `teams`
// roster. It is keyed by (client_id, game_uniqid, name) — the name is the
// human-facing unique key per scenario, so saving over an existing name
// overwrites that row.
//
// Device-local only: no cloud/LAN sync, no server endpoint. Configs do not
// travel to other paired devices or other operators. Table created by
// migration v13 (lib.rs).

import { getDb } from './db';
import type { GameConfig } from '../components/LaunchGameModal';

// What we persist: everything from step 1 except the per-instance fields.
export type SavedLaunchConfig = Omit<GameConfig, 'name' | 'teams'>;

export interface LaunchConfigRow {
  id: number;
  name: string;
  game_uniqid: string;
  config: SavedLaunchConfig;
  created_at: string;
  updated_at: string;
}

interface LaunchConfigDbRow {
  id: number;
  name: string;
  game_uniqid: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

// Drop the per-instance fields so a saved config never carries a stale game
// name or a roster snapshot.
function toSavedConfig(config: GameConfig | SavedLaunchConfig): SavedLaunchConfig {
  const clone = { ...(config as GameConfig) } as Partial<GameConfig>;
  delete clone.name;
  delete clone.teams;
  return clone as SavedLaunchConfig;
}

function rowOut(row: LaunchConfigDbRow): LaunchConfigRow {
  let config: SavedLaunchConfig;
  try {
    config = JSON.parse(row.config_json) as SavedLaunchConfig;
  } catch {
    // Corrupt blob — surface an empty config rather than throwing; the
    // headless validator will treat it as critical drift and open the modal.
    config = {} as SavedLaunchConfig;
  }
  return {
    id: row.id,
    name: row.name,
    game_uniqid: row.game_uniqid,
    config,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// All configs for one scenario, most-recently-updated first.
export async function listForScenario(
  clientId: number,
  gameUniqid: string
): Promise<LaunchConfigRow[]> {
  const db = await getDb();
  const rows = await db.select<LaunchConfigDbRow[]>(
    `SELECT id, name, game_uniqid, config_json, created_at, updated_at
       FROM launch_configs
      WHERE client_id = $1 AND game_uniqid = $2
      ORDER BY updated_at DESC, id DESC`,
    [clientId, gameUniqid]
  );
  return rows.map(rowOut);
}

// uniqid -> count, for the whole client. Drives whether the Quick Launch
// split button renders on each scenario card.
export async function countsByScenario(clientId: number): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db.select<Array<{ game_uniqid: string; n: number }>>(
    `SELECT game_uniqid, COUNT(*) AS n
       FROM launch_configs
      WHERE client_id = $1
      GROUP BY game_uniqid`,
    [clientId]
  );
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.game_uniqid, r.n);
  return map;
}

export async function existsByName(
  clientId: number,
  gameUniqid: string,
  name: string
): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<Array<{ n: number }>>(
    `SELECT COUNT(*) AS n FROM launch_configs
      WHERE client_id = $1 AND game_uniqid = $2 AND name = $3`,
    [clientId, gameUniqid, name.trim()]
  );
  return (rows[0]?.n ?? 0) > 0;
}

// Insert or overwrite by name. The UNIQUE(client_id, game_uniqid, name) index
// powers the upsert; an existing name replaces its config_json and bumps
// updated_at (created_at is preserved).
export async function upsertByName(
  clientId: number,
  gameUniqid: string,
  name: string,
  config: GameConfig | SavedLaunchConfig
): Promise<void> {
  const db = await getDb();
  const json = JSON.stringify(toSavedConfig(config));
  await db.execute(
    `INSERT INTO launch_configs (client_id, game_uniqid, name, config_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, datetime('now'), datetime('now'))
     ON CONFLICT(client_id, game_uniqid, name) DO UPDATE SET
       config_json = excluded.config_json,
       updated_at  = datetime('now')`,
    [clientId, gameUniqid, name.trim(), json]
  );
}

export async function deleteConfig(clientId: number, id: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'DELETE FROM launch_configs WHERE client_id = $1 AND id = $2',
    [clientId, id]
  );
}
