import { getDb } from './db';

// Client launch-time preferences (e.g. "play tutorial video by default" per
// game type). Inline-synced via the manifest, no separate download. Stored
// as a JSON blob keyed by the current logged-in client.

export interface GamePref {
  play_tutorial_default?: boolean;
  play_intro_default?: boolean;
}

export interface ClientPreferences {
  game_prefs?: Record<string, GamePref>;
  [k: string]: unknown;
}

export async function getPreferences(clientId: number): Promise<ClientPreferences> {
  const db = await getDb();
  const rows = await db.select<Array<{ preferences_json: string }>>(
    'SELECT preferences_json FROM client_preferences WHERE client_id = $1',
    [clientId]
  );
  if (!rows.length) return {};
  try {
    const parsed = JSON.parse(rows[0].preferences_json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ClientPreferences)
      : {};
  } catch {
    return {};
  }
}

export async function setFromManifest(
  clientId: number,
  prefs: ClientPreferences
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO client_preferences (client_id, preferences_json, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT(client_id) DO UPDATE SET
       preferences_json = excluded.preferences_json,
       updated_at = CURRENT_TIMESTAMP`,
    [clientId, JSON.stringify(prefs ?? {})]
  );
}

export async function getGamePref(
  clientId: number,
  gameTypeCode: string
): Promise<GamePref> {
  const prefs = await getPreferences(clientId);
  return prefs.game_prefs?.[gameTypeCode] ?? {};
}
