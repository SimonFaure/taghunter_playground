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
  readDir,
  remove,
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

export async function scenarioVersionDirAbs(uniqid: string, version: number): Promise<string> {
  const root = await mediaRootAbs();
  return join(root, 'scenarios', uniqid, `v${version}`);
}

export async function scenarioRootDirAbs(uniqid: string): Promise<string> {
  const root = await mediaRootAbs();
  return join(root, 'scenarios', uniqid);
}

export async function onDemandCardsFileAbs(): Promise<string> {
  const root = await mediaRootAbs();
  return join(root, 'cards', 'on_demand.json');
}

// Game-type media — admin (legacy Taghunter) variant.
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

// Game-type media — per-client override variant. The override is for the
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

export function scenarioVersionDirRel(uniqid: string, version: number): string {
  return `media/scenarios/${uniqid}/v${version}`;
}

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
    // semantic post-condition — "path is gone" — is met; treat as success.
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
// — and the scheme is `https` unless `dangerousUseHttpScheme` is set — while
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

// Walks media/scenarios/* and deletes any v{N} dir whose N doesn't equal the
// row's local_version. Run once at app launch, before the first sync cycle, so
// no gameplay session can be referencing a stale dir.
//
// Resilience: each scenario is pruned in its own try/catch so a single
// corrupted entry (e.g., a broken symlink, a missing dir whose name still
// appears in readDir output, a permissions hiccup) doesn't abort the whole
// prune and leave the rest of the media tree unswept. Tauri's plugin-fs
// surfaces "failed to get metadata of path" when `readDir` lists an entry
// but the subsequent `isDirectory` stat fails — that's exactly the kind of
// per-entry failure we want to skip past, not propagate.
export async function pruneStaleVersions(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<Array<{ uniqid: string; local_version: number | null }>>(
    'SELECT uniqid, local_version FROM scenarios'
  );
  const expected = new Map(rows.map((r) => [r.uniqid, r.local_version]));

  const scenariosRel = 'media/scenarios';
  if (!(await exists(scenariosRel, { baseDir: APP }))) return 0;

  let pruned = 0;
  const uniqDirs = await readDir(scenariosRel, { baseDir: APP });
  for (const u of uniqDirs) {
    try {
      if (!u.isDirectory) continue;
      const uniqid = u.name;
      const expectedVer = expected.get(uniqid);

      // Tombstoned scenario whose row is gone but media remains.
      if (expectedVer === undefined) {
        await removeRecursive(`${scenariosRel}/${uniqid}`);
        pruned++;
        continue;
      }

      const versionDirs = await readDir(`${scenariosRel}/${uniqid}`, { baseDir: APP });
      for (const v of versionDirs) {
        try {
          if (!v.isDirectory) continue;
          if (!v.name.startsWith('v')) continue;
          const ver = Number(v.name.slice(1));
          if (Number.isNaN(ver)) continue;
          if (ver !== expectedVer) {
            await removeRecursive(`${scenariosRel}/${uniqid}/${v.name}`);
            pruned++;
          }
        } catch (err) {
          console.warn(
            `[contentFs] prune: skipped corrupted version entry ${scenariosRel}/${uniqid}/${v.name}:`,
            err,
          );
        }
      }
    } catch (err) {
      console.warn(
        `[contentFs] prune: skipped corrupted scenario dir ${scenariosRel}/${u.name}:`,
        err,
      );
    }
  }

  // Cards no longer live on disk — the row-based `cards` table replaced
  // the per-version CSV file. Anything left in media/cards/v*.csv is
  // residue from a pre-migration-7 install and gets cleaned up by
  // pruneStaleCardsCsv() at startup.
  return pruned;
}

// One-shot cleanup: remove any media/cards/v*.csv files left over from
// the pre-Unit-4 CSV-based card flow. Idempotent — does nothing on fresh
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
  await db.execute('DELETE FROM patterns');
  await db.execute('DELETE FROM layouts');
  await db.execute('DELETE FROM cards_state');
  await db.execute('DELETE FROM cards');
  await db.execute('DELETE FROM name_pools_state');
  await removeRecursive('media');
}
