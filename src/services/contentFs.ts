// Filesystem layout helpers for content sync.
//
// Layout under appDataDir():
//   media/
//     scenarios/{uniqid}/v{N}/
//       game-data.json
//       images/...
//       sounds/...
//       videos/...
//       levels/...
//     cards/
//       v{N}.csv
//       on_demand.csv

import {
  exists,
  mkdir,
  open,
  readDir,
  remove,
  rename,
  writeFile,
  writeTextFile,
  BaseDirectory,
} from '@tauri-apps/plugin-fs';
import { convertFileSrc } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import { getDb } from './db';

const APP = BaseDirectory.AppData;

// ---------- absolute path helpers (for plugin-fs APIs) ----------

export async function mediaRootAbs(): Promise<string> {
  const root = await appDataDir();
  return join(root, 'media');
}

// Legacy per-scenario root (pre-CAS). Still referenced by scenarioStore's
// tombstone/delete cleanup to remove any leftover legacy dir on upgraded
// installs; the version-dir helpers it sat alongside were removed with the CAS
// migration (media now lives in the content-addressed blob pool).

export async function onDemandCardsFileAbs(): Promise<string> {
  const root = await mediaRootAbs();
  return join(root, 'cards', 'on_demand.json');
}

// Game-type media - admin (legacy Taghunter) variant.
// Layout: media/game_types/<code>/v<N>/{tutorial.<ext>, subtitles/<lang>.vtt}
export async function gameTypeAdminVersionDirAbs(code: string, version: number): Promise<string> {
  const root = await mediaRootAbs();
  return join(root, 'game_types', code, `v${version}`);
}
export function gameTypeAdminVersionDirRel(code: string, version: number): string {
  return `media/game_types/${code}/v${version}`;
}
export function gameTypeAdminRootDirRel(code: string): string {
  return `media/game_types/${code}`;
}

// Game-type media - per-client override variant. The override is for the
// currently-authed client; the server filters by client_id so we only ever
// see our own. Filesystem path uses a single `client/` segment locally
// (no client_id in the path) because there is only one logged-in client.
export async function gameTypeClientVersionDirAbs(code: string, version: number): Promise<string> {
  const root = await mediaRootAbs();
  return join(root, 'game_types', code, 'client', `v${version}`);
}
export function gameTypeClientVersionDirRel(code: string, version: number): string {
  return `media/game_types/${code}/client/v${version}`;
}
export function gameTypeClientRootDirRel(code: string): string {
  return `media/game_types/${code}/client`;
}

// ---------- relative paths (for BaseDirectory.AppData APIs) ----------

export function scenarioRootDirRel(uniqid: string): string {
  return `media/scenarios/${uniqid}`;
}

export function onDemandCardsFileRel(): string {
  return `media/cards/on_demand.json`;
}

// Merged team-name pools (global ∪ this client's), grouped audience -> language
// -> [names]. Written by the sync orchestrator, read at team creation by both
// the cloud-mode draw (TS) and the LAN mother (Rust, same absolute path).
export function teamNamesFileRel(): string {
  return `media/name_pools/team_names.json`;
}

export async function teamNamesFileAbs(): Promise<string> {
  const root = await mediaRootAbs();
  return join(root, 'name_pools', 'team_names.json');
}

// ---------- content-addressed blob pool ----------
//
// Every scenario file (media AND game-data.json) is stored once under
//   media/blobs/{first2}/{content_hash}
// keyed by its SHA-256. Unchanged files across scenario revisions - and across
// scenarios - share one blob, so a content change only ever downloads the bytes
// that actually changed. The scenario_files SQLite table maps
// (uniqid, rel_path) -> content_hash; the Rust protocol handler + getGameData
// resolve through it into this pool. Design: project_scenario_incremental_sync_cas.

const BLOBS_REL = 'media/blobs';
const BLOBS_TMP_REL = 'media/blobs/.tmp';

export function blobPathRel(hash: string): string {
  return `${BLOBS_REL}/${hash.slice(0, 2)}/${hash}`;
}

export async function blobPathAbs(hash: string): Promise<string> {
  const root = await mediaRootAbs();
  return join(root, 'blobs', hash.slice(0, 2), hash);
}

export async function blobExists(hash: string): Promise<boolean> {
  return exists(blobPathRel(hash), { baseDir: APP });
}

// A unique temp path for an in-flight blob download. `token` must be unique
// per concurrent download (the orchestrator uses hash + a monotonic counter)
// so two workers fetching the same missing blob don't clobber each other's
// partial file before the verify+rename step.
export function blobTmpPathRel(token: string): string {
  return `${BLOBS_TMP_REL}/${token}`;
}

// Atomically place a verified temp file into the pool under its hash. If the
// blob already exists (a concurrent worker or a prior revision wrote it first),
// just drop the temp - content-addressed blobs are immutable, so the existing
// one is byte-identical. Returns true if this call created the blob.
export async function commitBlobFromTemp(tmpRel: string, hash: string): Promise<boolean> {
  const dest = blobPathRel(hash);
  if (await exists(dest, { baseDir: APP })) {
    await removeRecursive(tmpRel);
    return false;
  }
  await ensureDir(`${BLOBS_REL}/${hash.slice(0, 2)}`);
  await rename(tmpRel, dest, { oldPathBaseDir: APP, newPathBaseDir: APP });
  return true;
}

// ---------- write helpers ----------

export async function ensureDir(relPath: string): Promise<void> {
  if (!(await exists(relPath, { baseDir: APP }))) {
    await mkdir(relPath, { baseDir: APP, recursive: true });
  }
}

export async function writeJson(relPath: string, value: unknown): Promise<void> {
  const lastSlash = relPath.lastIndexOf('/');
  if (lastSlash > 0) await ensureDir(relPath.slice(0, lastSlash));
  await writeTextFile(relPath, JSON.stringify(value), { baseDir: APP });
}

export async function writeBinary(relPath: string, bytes: Uint8Array): Promise<void> {
  const lastSlash = relPath.lastIndexOf('/');
  if (lastSlash > 0) await ensureDir(relPath.slice(0, lastSlash));
  await writeFile(relPath, bytes, { baseDir: APP });
}

// Stream bytes to a file without ever holding the whole payload in memory.
// `pump` receives a `write` sink and should drive the download, calling
// write(chunk) per chunk. The file is created (truncating any existing one)
// and closed automatically. This is the memory-safe path for large media:
// buffering a multi-hundred-MB video into one Uint8Array OOMs the Android
// WebView heap (256 MB growth limit). The write loop handles partial writes,
// since FileHandle.write may not consume the whole chunk in one call.
export async function streamBinary<T>(
  relPath: string,
  pump: (write: (chunk: Uint8Array) => Promise<void>) => Promise<T>,
): Promise<T> {
  const lastSlash = relPath.lastIndexOf('/');
  if (lastSlash > 0) await ensureDir(relPath.slice(0, lastSlash));
  // truncate:true so a retry (withRetry wraps the whole stream) restarts from
  // an empty file rather than appending to a half-written one.
  const file = await open(relPath, {
    write: true,
    create: true,
    truncate: true,
    baseDir: APP,
  });
  try {
    return await pump(async (chunk) => {
      let off = 0;
      while (off < chunk.byteLength) {
        off += await file.write(chunk.subarray(off));
      }
    });
  } finally {
    await file.close();
  }
}

export async function writeText(relPath: string, content: string): Promise<void> {
  const lastSlash = relPath.lastIndexOf('/');
  if (lastSlash > 0) await ensureDir(relPath.slice(0, lastSlash));
  await writeTextFile(relPath, content, { baseDir: APP });
}

export async function removeRecursive(relPath: string): Promise<void> {
  if (!(await exists(relPath, { baseDir: APP }))) return;
  try {
    await remove(relPath, { baseDir: APP, recursive: true });
  } catch (err) {
    // "file not found / os error 2" can fire if the path (or a child) was
    // already deleted by another process, or if a child entry is a broken
    // symlink whose stat the recursive walk can't satisfy. Either way the
    // semantic post-condition - "path is gone" - is met; treat as success.
    const msg = err instanceof Error ? err.message : String(err);
    if (/os error 2|file not found|introuvable|no such file/i.test(msg)) {
      return;
    }
    throw err;
  }
}

// ---------- assetUrl: convert an absolute FS path to a webview-loadable URL ----------

export function assetUrl(absPath: string): string {
  return convertFileSrc(absPath);
}

// Custom URI-scheme protocols don't share one URL shape across platforms:
// Windows (WebView2) and Android serve them over `http(s)://<scheme>.localhost/`
// - and the scheme is `https` unless `dangerousUseHttpScheme` is set - while
// macOS/Linux/iOS use the native `<scheme>://` form. Getting this wrong fails
// the webview fetch: the native form on Windows is ERR_UNKNOWN_URL_SCHEME, and
// `http://` when Tauri expects `https://` escapes the webview entirely (the
// request leaves to the network and `*.localhost` 404s on a local web server).
// `convertFileSrc` already encodes Tauri's exact shape for this platform/build,
// so probe it once to derive the prefix. `scenario_protocol.rs` accepts both
// `https://scenario.localhost/<uniqid>/…` and native `scenario://<uniqid>/…`.
let scenarioUrlPrefixCache: string | null = null;
function scenarioUrlPrefix(): string {
  if (scenarioUrlPrefixCache === null) {
    const probe = convertFileSrc('probe', 'scenario');
    const httpForm = /^(https?):\/\//.exec(probe);
    scenarioUrlPrefixCache = httpForm
      ? `${httpForm[1]}://scenario.localhost/`
      : 'scenario://';
  }
  return scenarioUrlPrefixCache;
}

// `scenario://{uniqid}/{relPath}` (or `http://scenario.localhost/{uniqid}/...`
// on Windows/Android) resolves on the Rust side to the matching file under
// media/scenarios/{uniqid}/v{local_version}/{relPath}. Per-request version
// lookup means callers never need to re-mint URLs after a sync cycle.
// Encodes path segments individually so spaces and other reserved chars in
// filenames round-trip; the protocol handler percent-decodes on receipt.
//
// Legacy-data tolerance: scenario layout / media fields in the studio DB
// historically stored *full Supabase Storage URLs* (e.g.
// `https://....supabase.co/storage/v1/object/public/game-media/<uuid>/foo.png`)
// rather than bare filenames. Post-Phase-0 the playground resolves everything
// locally, so a URL-shaped filename produces a nonsense `scenario://uniqid/
// https%3A/.../foo.png` path that misses the on-disk file. Strip any
// http(s):// prefix and use just the trailing filename component.
export function scenarioAssetUrl(uniqid: string, relPath: string): string {
  if (!uniqid || !relPath) return '';
  const cleaned = stripLegacyMediaUrl(relPath);
  const encoded = cleaned
    .split('/')
    .filter((s) => s.length > 0)
    .map(encodeURIComponent)
    .join('/');
  return `${scenarioUrlPrefix()}${encodeURIComponent(uniqid)}/${encoded}`;
}

function stripLegacyMediaUrl(input: string): string {
  if (input.startsWith('http://') || input.startsWith('https://')) {
    const segs = input.split('/').filter((s) => s.length > 0);
    return segs[segs.length - 1] || input;
  }
  return input;
}

// ---------- pruning ----------

// Boot-time mark-and-sweep for the content-addressed blob pool. A blob is
// reachable iff some active scenario_files row references its hash (dedup means
// one blob can back many scenarios/revisions). Anything unreferenced is orphan
// garbage from a superseded scenario revision and gets deleted. Runs at app
// launch, before the first sync cycle, so no in-flight gameplay session can be
// resolving a blob we're about to remove (mirrors pruneStaleVersions' timing).
// Replaces pruneStaleVersions in the CAS model. Returns the count removed.
export async function pruneOrphanBlobs(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<Array<{ content_hash: string }>>(
    'SELECT DISTINCT content_hash FROM scenario_files'
  );
  const referenced = new Set(rows.map((r) => r.content_hash));

  if (!(await exists(BLOBS_REL, { baseDir: APP }))) return 0;

  // Interrupted-download temp files are never referenced - always clear them.
  await removeRecursive(BLOBS_TMP_REL);

  let pruned = 0;
  const shards = await readDir(BLOBS_REL, { baseDir: APP });
  for (const shard of shards) {
    try {
      if (!shard.isDirectory || shard.name === '.tmp') continue;
      const shardRel = `${BLOBS_REL}/${shard.name}`;
      const blobs = await readDir(shardRel, { baseDir: APP });
      for (const b of blobs) {
        try {
          if (!b.isFile) continue;
          if (referenced.has(b.name)) continue;
          await remove(`${shardRel}/${b.name}`, { baseDir: APP });
          pruned++;
        } catch (err) {
          console.warn(`[contentFs] prune: skipped blob ${shardRel}/${b.name}:`, err);
        }
      }
    } catch (err) {
      console.warn(`[contentFs] prune: skipped blob shard ${shard.name}:`, err);
    }
  }
  return pruned;
}

// One-shot cleanup: remove any media/cards/v*.csv files left over from
// the pre-Unit-4 CSV-based card flow. Idempotent - does nothing on fresh
// installs. Runs alongside pruneStaleVersions() at app boot.
export async function pruneStaleCardsCsv(): Promise<number> {
  const cardsRel = 'media/cards';
  if (!(await exists(cardsRel, { baseDir: APP }))) return 0;
  let pruned = 0;
  const entries = await readDir(cardsRel, { baseDir: APP });
  for (const e of entries) {
    if (!e.isFile) continue;
    if (!/^v\d+\.csv$/.test(e.name)) continue;
    await remove(`${cardsRel}/${e.name}`, { baseDir: APP });
    pruned++;
  }
  return pruned;
}

// Different-owner login wipe. Clears all content tables and removes media root.
// Called from auth.ts when isDifferentOwner() returns true.
export async function wipeAllContent(): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM scenarios');
  await db.execute('DELETE FROM scenario_files');
  await db.execute('DELETE FROM patterns');
  await db.execute('DELETE FROM layouts');
  await db.execute('DELETE FROM cards_state');
  await db.execute('DELETE FROM cards');
  await db.execute('DELETE FROM name_pools_state');
  await removeRecursive('media');
}
