import { exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { getDb } from './db';
import {
  assetUrl,
  gameTypeAdminVersionDirAbs,
  gameTypeAdminVersionDirRel,
  gameTypeClientVersionDirAbs,
  gameTypeClientVersionDirRel,
  localGameTypeDirAbs,
  localGameTypeDirRel,
  removeRecursive,
  streamBinary,
} from './contentFs';

// Two related tables drive a single resolved "play this video on first bip"
// flow:
//   - game_types: admin (Taghunter) defaults shipped to every client.
//   - game_type_overrides: this client's own upload that supersedes the
//     admin video at runtime, but never deletes it on disk.
//
// At runtime the playground resolves the override first; falls back to the
// admin row if the override is missing or unsynced. Both are versioned
// independently - sync downloads each freshly when its own
// `remote_version != local_version`.
//
// A third, purely LOCAL source sits on top of those two:
//   - local_game_type_videos: a file the operator imported on THIS device from
//     Settings > Videos. It never leaves the device (no upload to studio, no
//     propagation to satellites) and is unversioned, so it wins over both
//     synced variants until the operator removes it.

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

// Operator-imported tutorial video, local to this device.
export interface LocalGameTypeVideoRow {
  game_type_code: string;
  filename: string;
  size_bytes: number;
  created_at: string;
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

// Reset every game-type tutorial video (admin + per-client override) to "needs
// download": clears local_version + failed attempts and deletes the on-disk
// video roots. Rows stay (manifest metadata preserved). Used by the
// Operator-only toggle (services/operatorMode.ts): ON skips these on the next
// cycle (so they stay gone), OFF re-downloads them. Returns rows reset.
// Operator-imported local videos are deliberately NOT touched: there is no
// remote copy to pull them back from, so clearing them would destroy the file.
export async function resetVideosForRedownload(): Promise<number> {
  const db = await getDb();
  const codes = await db.select<Array<{ code: string }>>('SELECT code FROM game_types');
  for (const c of codes) {
    // `media/game_types/<code>` holds both the admin and client (override) video
    // version dirs - removing the root clears both variants in one shot.
    await removeRecursive(`media/game_types/${c.code}`);
  }
  await db.execute('UPDATE game_types SET local_version = NULL, failed_attempts = 0');
  await db.execute('UPDATE game_type_overrides SET local_version = NULL, failed_attempts = 0');
  return codes.length;
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

// ─────────────────────────── operator-imported (local) tutorial videos ──
//
// The file is copied into media/local_game_types/<code>/<filename> and the row
// below records which name to look for. One video per game type - importing a
// second one replaces the first.

function localRowOut(row: {
  game_type_code: string;
  filename: string;
  size_bytes: number;
  created_at: string;
}): LocalGameTypeVideoRow {
  return {
    game_type_code: row.game_type_code,
    filename: row.filename,
    size_bytes: row.size_bytes,
    created_at: row.created_at,
  };
}

export async function listLocalVideos(): Promise<LocalGameTypeVideoRow[]> {
  const db = await getDb();
  const rows = await db.select<Parameters<typeof localRowOut>[0][]>(
    'SELECT * FROM local_game_type_videos ORDER BY game_type_code'
  );
  return rows.map(localRowOut);
}

export async function getLocalVideo(code: string): Promise<LocalGameTypeVideoRow | null> {
  const db = await getDb();
  const rows = await db.select<Parameters<typeof localRowOut>[0][]>(
    'SELECT * FROM local_game_type_videos WHERE game_type_code = $1',
    [code.toLowerCase()]
  );
  return rows.length ? localRowOut(rows[0]) : null;
}

// Strip anything that could escape the per-game-type directory or upset the
// asset protocol, while keeping the extension (the <video> element picks its
// decoder off the file's own bytes, but a sane name keeps the folder readable
// when the operator opens it from the settings page).
function sanitizeVideoFilename(name: string): string {
  const bare = name.split(/[\\/]/).pop() || 'tutorial.mp4';
  const cleaned = bare.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'tutorial.mp4';
}

// Copy `file` into this device's local store for `code`, replacing whatever was
// there. Streams chunk-by-chunk: tutorial videos run to hundreds of MB and
// buffering one into a single Uint8Array blows the Android WebView heap.
// `onProgress` reports bytes written so the UI can show a bar.
export async function saveLocalVideo(
  code: string,
  file: File,
  onProgress?: (written: number, total: number) => void
): Promise<LocalGameTypeVideoRow> {
  code = code.toLowerCase();
  const filename = sanitizeVideoFilename(file.name);
  const dirRel = localGameTypeDirRel(code);

  // Drop any previous import first - a different extension would otherwise
  // leave an orphan file sitting next to the new one.
  await removeRecursive(dirRel);

  const total = file.size;
  let written = 0;
  await streamBinary(`${dirRel}/${filename}`, async (write) => {
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await write(value);
      written += value.byteLength;
      onProgress?.(written, total);
    }
  });

  const db = await getDb();
  await db.execute(
    `INSERT INTO local_game_type_videos (game_type_code, filename, size_bytes)
     VALUES ($1, $2, $3)
     ON CONFLICT(game_type_code) DO UPDATE SET
       filename = excluded.filename,
       size_bytes = excluded.size_bytes,
       created_at = CURRENT_TIMESTAMP`,
    [code, filename, total]
  );

  const saved = await getLocalVideo(code);
  if (!saved) throw new Error('local video row missing after save');
  return saved;
}

export async function removeLocalVideo(code: string): Promise<void> {
  code = code.toLowerCase();
  const db = await getDb();
  await db.execute('DELETE FROM local_game_type_videos WHERE game_type_code = $1', [code]);
  await removeRecursive(localGameTypeDirRel(code));
}

// Resolved tutorial video at runtime. Precedence, highest first:
//   local    - imported by the operator on this device (Settings > Videos)
//   override - this client's own upload, synced from studio
//   admin    - the Tag Hunter default, synced from studio
// Returns null when none of the three has a playable file on disk.
export async function resolveTutorialVideoUrl(code: string): Promise<{
  videoUrl: string;
  subtitleUrls: Record<string, string>;
  variant: 'local' | 'admin' | 'override';
  version: number;
} | null> {
  // `game_types.code` is canonically lowercase ('mystery', 'tagquest', …), but
  // launched games carry the DISPLAY-cased game_type ('Mystery', 'TagQuest'),
  // and that's what the operator-video / first-bip callers pass through. The
  // WHERE code = ? lookups are case-sensitive, so normalize here or every
  // capitalized code silently resolves to "no tutorial video".
  code = code.toLowerCase();

  // Operator's own import beats anything synced. It carries no subtitles (the
  // picker only takes a video file) and no version - `0` stands for "unversioned".
  const local = await getLocalVideo(code);
  if (local) {
    const dirRel = localGameTypeDirRel(code);
    if (await exists(`${dirRel}/${local.filename}`, { baseDir: BaseDirectory.AppData })) {
      const dirAbs = await localGameTypeDirAbs(code);
      const videoAbs = await join(dirAbs, local.filename);
      return { videoUrl: assetUrl(videoAbs), subtitleUrls: {}, variant: 'local', version: 0 };
    }
  }

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
// downloaded - either the override or the admin default.
export async function hasTutorialVideo(code: string): Promise<boolean> {
  const resolved = await resolveTutorialVideoUrl(code);
  return resolved !== null;
}
