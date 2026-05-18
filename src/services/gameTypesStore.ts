import { exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { getDb } from './db';
import {
  assetUrl,
  gameTypeAdminVersionDirAbs,
  gameTypeAdminVersionDirRel,
  gameTypeClientVersionDirAbs,
  gameTypeClientVersionDirRel,
  removeRecursive,
} from './contentFs';

// Two related tables drive a single resolved "play this video on first bip"
// flow:
//   - game_types: admin (Taghunter) defaults shipped to every client.
//   - game_type_overrides: this client's own upload that supersedes the
//     admin video at runtime, but never deletes it on disk.
//
// At runtime the playground resolves the override first; falls back to the
// admin row if the override is missing or unsynced. Both are versioned
// independently — sync downloads each freshly when its own
// `remote_version != local_version`.

export interface GameTypeRow {
  code: string;
  name: string;
  supports_tutorial_video: boolean;
  supports_intro_video: boolean;
  tutorial_video_filename: string | null;
  remote_version: number;
  local_version: number | null;
  tutorial_subtitles: Record<string, string>;
  failed_attempts: number;
}

export interface GameTypeOverrideRow {
  game_type_code: string;
  tutorial_video_filename: string | null;
  remote_version: number;
  local_version: number | null;
  tutorial_subtitles: Record<string, string>;
  failed_attempts: number;
}

export interface GameTypeManifestRow {
  code: string;
  name: string;
  supports_tutorial_video: boolean;
  supports_intro_video: boolean;
  tutorial_video_filename: string | null;
  tutorial_video_version: number;
  tutorial_subtitles: Record<string, string>;
}

export interface GameTypeOverrideManifestRow {
  game_type_code: string;
  tutorial_video_filename: string | null;
  tutorial_video_version: number;
  tutorial_subtitles: Record<string, string>;
}

function parseSubtitles(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function rowOut(row: {
  code: string;
  name: string;
  supports_tutorial_video: number;
  supports_intro_video: number;
  tutorial_video_filename: string | null;
  remote_version: number;
  local_version: number | null;
  tutorial_subtitles_json: string | null;
  failed_attempts: number;
}): GameTypeRow {
  return {
    code: row.code,
    name: row.name,
    supports_tutorial_video: Boolean(row.supports_tutorial_video),
    supports_intro_video: Boolean(row.supports_intro_video),
    tutorial_video_filename: row.tutorial_video_filename,
    remote_version: row.remote_version,
    local_version: row.local_version,
    tutorial_subtitles: parseSubtitles(row.tutorial_subtitles_json),
    failed_attempts: row.failed_attempts,
  };
}

function overrideRowOut(row: {
  game_type_code: string;
  tutorial_video_filename: string | null;
  remote_version: number;
  local_version: number | null;
  tutorial_subtitles_json: string | null;
  failed_attempts: number;
}): GameTypeOverrideRow {
  return {
    game_type_code: row.game_type_code,
    tutorial_video_filename: row.tutorial_video_filename,
    remote_version: row.remote_version,
    local_version: row.local_version,
    tutorial_subtitles: parseSubtitles(row.tutorial_subtitles_json),
    failed_attempts: row.failed_attempts,
  };
}

export async function listGameTypes(): Promise<GameTypeRow[]> {
  const db = await getDb();
  const rows = await db.select<Parameters<typeof rowOut>[0][]>(
    'SELECT * FROM game_types ORDER BY code'
  );
  return rows.map(rowOut);
}

export async function getGameType(code: string): Promise<GameTypeRow | null> {
  const db = await getDb();
  const rows = await db.select<Parameters<typeof rowOut>[0][]>(
    'SELECT * FROM game_types WHERE code = $1',
    [code]
  );
  return rows.length ? rowOut(rows[0]) : null;
}

export async function getOverride(code: string): Promise<GameTypeOverrideRow | null> {
  const db = await getDb();
  const rows = await db.select<Parameters<typeof overrideRowOut>[0][]>(
    'SELECT * FROM game_type_overrides WHERE game_type_code = $1',
    [code]
  );
  return rows.length ? overrideRowOut(rows[0]) : null;
}

export async function upsertGameTypesFromManifest(
  rows: GameTypeManifestRow[]
): Promise<void> {
  const db = await getDb();
  for (const r of rows) {
    await db.execute(
      `INSERT INTO game_types (
         code, name, supports_tutorial_video, supports_intro_video,
         tutorial_video_filename, remote_version, local_version,
         tutorial_subtitles_json, failed_attempts
       ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, 0)
       ON CONFLICT(code) DO UPDATE SET
         name = excluded.name,
         supports_tutorial_video = excluded.supports_tutorial_video,
         supports_intro_video = excluded.supports_intro_video,
         tutorial_video_filename = excluded.tutorial_video_filename,
         remote_version = excluded.remote_version,
         tutorial_subtitles_json = excluded.tutorial_subtitles_json`,
      [
        r.code,
        r.name,
        r.supports_tutorial_video ? 1 : 0,
        r.supports_intro_video ? 1 : 0,
        r.tutorial_video_filename,
        r.tutorial_video_version,
        JSON.stringify(r.tutorial_subtitles || {}),
      ]
    );
  }
}

export async function upsertOverridesFromManifest(
  rows: GameTypeOverrideManifestRow[]
): Promise<void> {
  const db = await getDb();
  for (const r of rows) {
    await db.execute(
      `INSERT INTO game_type_overrides (
         game_type_code, tutorial_video_filename, remote_version, local_version,
         tutorial_subtitles_json, failed_attempts
       ) VALUES ($1, $2, $3, NULL, $4, 0)
       ON CONFLICT(game_type_code) DO UPDATE SET
         tutorial_video_filename = excluded.tutorial_video_filename,
         remote_version = excluded.remote_version,
         tutorial_subtitles_json = excluded.tutorial_subtitles_json`,
      [
        r.game_type_code,
        r.tutorial_video_filename,
        r.tutorial_video_version,
        JSON.stringify(r.tutorial_subtitles || {}),
      ]
    );
  }
}

export async function tombstoneMissingGameTypes(keepCodes: string[]): Promise<void> {
  const db = await getDb();
  const existing = await db.select<Array<{ code: string }>>('SELECT code FROM game_types');
  const keep = new Set(keepCodes);
  for (const e of existing) {
    if (keep.has(e.code)) continue;
    await db.execute('DELETE FROM game_types WHERE code = $1', [e.code]);
    await removeRecursive(`media/game_types/${e.code}`);
  }
}

export async function tombstoneMissingOverrides(keepCodes: string[]): Promise<void> {
  const db = await getDb();
  const existing = await db.select<Array<{ game_type_code: string }>>(
    'SELECT game_type_code FROM game_type_overrides'
  );
  const keep = new Set(keepCodes);
  for (const e of existing) {
    if (keep.has(e.game_type_code)) continue;
    await db.execute('DELETE FROM game_type_overrides WHERE game_type_code = $1', [
      e.game_type_code,
    ]);
    await removeRecursive(`media/game_types/${e.game_type_code}/client`);
  }
}

export async function markAdminDownloaded(code: string, version: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE game_types SET local_version = $1, failed_attempts = 0 WHERE code = $2',
    [version, code]
  );
}

export async function markOverrideDownloaded(code: string, version: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE game_type_overrides SET local_version = $1, failed_attempts = 0 WHERE game_type_code = $2',
    [version, code]
  );
}

export async function incrementAdminFailedAttempts(code: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE game_types SET failed_attempts = failed_attempts + 1 WHERE code = $1',
    [code]
  );
}

export async function incrementOverrideFailedAttempts(code: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE game_type_overrides SET failed_attempts = failed_attempts + 1 WHERE game_type_code = $1',
    [code]
  );
}

export async function listPendingAdminDownloads(): Promise<GameTypeRow[]> {
  const db = await getDb();
  const rows = await db.select<Parameters<typeof rowOut>[0][]>(
    `SELECT * FROM game_types
     WHERE tutorial_video_filename IS NOT NULL
       AND (local_version IS NULL OR local_version <> remote_version)
     ORDER BY code`
  );
  return rows.map(rowOut);
}

export async function listPendingOverrideDownloads(): Promise<GameTypeOverrideRow[]> {
  const db = await getDb();
  const rows = await db.select<Parameters<typeof overrideRowOut>[0][]>(
    `SELECT * FROM game_type_overrides
     WHERE tutorial_video_filename IS NOT NULL
       AND (local_version IS NULL OR local_version <> remote_version)
     ORDER BY game_type_code`
  );
  return rows.map(overrideRowOut);
}

// Resolved tutorial video at runtime — override wins if present and downloaded.
// Returns null if neither admin nor override has a downloaded video.
export async function resolveTutorialVideoUrl(code: string): Promise<{
  videoUrl: string;
  subtitleUrls: Record<string, string>;
  variant: 'admin' | 'override';
  version: number;
} | null> {
  const override = await getOverride(code);
  if (override && override.tutorial_video_filename && override.local_version !== null) {
    const dirAbs = await gameTypeClientVersionDirAbs(code, override.local_version);
    const videoAbs = await join(dirAbs, override.tutorial_video_filename);
    const videoUrl = assetUrl(videoAbs);
    const subtitleUrls: Record<string, string> = {};
    for (const [lang, fname] of Object.entries(override.tutorial_subtitles)) {
      const subAbs = await join(dirAbs, 'subtitles', fname);
      if (await exists(`${gameTypeClientVersionDirRel(code, override.local_version)}/subtitles/${fname}`, { baseDir: BaseDirectory.AppData })) {
        subtitleUrls[lang] = assetUrl(subAbs);
      }
    }
    return { videoUrl, subtitleUrls, variant: 'override', version: override.local_version };
  }

  const admin = await getGameType(code);
  if (admin && admin.tutorial_video_filename && admin.local_version !== null) {
    const dirAbs = await gameTypeAdminVersionDirAbs(code, admin.local_version);
    const videoAbs = await join(dirAbs, admin.tutorial_video_filename);
    const videoUrl = assetUrl(videoAbs);
    const subtitleUrls: Record<string, string> = {};
    for (const [lang, fname] of Object.entries(admin.tutorial_subtitles)) {
      if (await exists(`${gameTypeAdminVersionDirRel(code, admin.local_version)}/subtitles/${fname}`, { baseDir: BaseDirectory.AppData })) {
        const subAbs = await join(dirAbs, 'subtitles', fname);
        subtitleUrls[lang] = assetUrl(subAbs);
      }
    }
    return { videoUrl, subtitleUrls, variant: 'admin', version: admin.local_version };
  }

  return null;
}

// Whether the playground has *any* tutorial video for this game type
// downloaded — either the override or the admin default.
export async function hasTutorialVideo(code: string): Promise<boolean> {
  const resolved = await resolveTutorialVideoUrl(code);
  return resolved !== null;
}
