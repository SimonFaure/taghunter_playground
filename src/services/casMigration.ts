// One-shot, local, network-free migration from the legacy versioned-directory
// scenario layout (media/scenarios/{uniqid}/v{version}/…) to the
// content-addressed blob pool (media/blobs/{ab}/{hash}).
//
// For every already-downloaded scenario we hash each file in its current
// version dir, move it into the pool under its SHA-256, and write the
// scenario_files active-manifest rows - so the scenario keeps resolving (and
// stays playable OFFLINE) immediately after the upgrade, with zero bandwidth.
//
// We can't compute the studio's Tier-1 content_hash offline, so we stamp
// local_content_hash with a sentinel that is guaranteed to differ from any
// real (64-hex) remote hash. The first online sync therefore re-reconciles
// each scenario: its media blobs are already in the pool (the per-file SHA-256
// we stored matches the studio's, which hashes the same raw bytes), so only
// game-data.json is re-fetched (tiny) and re-keyed under the studio data_hash;
// commitManifest then sets the real local_content_hash. The provisional
// game-data blob becomes an orphan reclaimed by pruneOrphanBlobs.
//
// Gated by a schema_meta flag so it runs exactly once. Design:
// project_scenario_incremental_sync_cas.

import { exists, readDir, rename, remove, BaseDirectory } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import { getDb } from './db';
import * as scenarioStore from './scenarioStore';
import { blobPathRel, blobExists, ensureDir, removeRecursive } from './contentFs';

const APP = BaseDirectory.AppData;
const FLAG_KEY = 'cas_migrated';
const SENTINEL = 'cas-migrated'; // never equals a 64-hex studio hash → forces one reconcile

async function flagDone(): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<Array<{ value: string }>>(
    "SELECT value FROM schema_meta WHERE key = $1",
    [FLAG_KEY]
  );
  return rows.length > 0 && rows[0].value === '1';
}

async function setFlag(): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO schema_meta(key, value) VALUES ($1, '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
    [FLAG_KEY]
  );
}

// Recursively collect files under `relDir`, returning each file's path relative
// to `relDir` (forward-slash joined) - the rel_path used in the manifest.
async function listFilesRel(relDir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await readDir(relDir, { baseDir: APP });
  for (const e of entries) {
    const childRel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) {
      out.push(...(await listFilesRel(`${relDir}/${e.name}`, childRel)));
    } else if (e.isFile) {
      out.push(childRel);
    }
  }
  return out;
}

async function convertScenario(uniqid: string, localVersion: number, root: string): Promise<boolean> {
  const versionRel = `media/scenarios/${uniqid}/v${localVersion}`;
  if (!(await exists(versionRel, { baseDir: APP }))) return false;

  const relFiles = await listFilesRel(versionRel);
  if (relFiles.length === 0) return false;

  const manifest: scenarioStore.ManifestFile[] = [];
  for (const rel of relFiles) {
    const srcRel = `${versionRel}/${rel}`;
    const srcAbs = await join(root, srcRel);
    const hash = await invoke<string>('sha256_file', { path: srcAbs });
    if (await blobExists(hash)) {
      // Identical bytes already pooled (shared across scenarios/revisions).
      await remove(srcRel, { baseDir: APP });
    } else {
      await ensureDir(`media/blobs/${hash.slice(0, 2)}`);
      await rename(srcRel, blobPathRel(hash), { oldPathBaseDir: APP, newPathBaseDir: APP });
    }
    manifest.push({ rel_path: rel, content_hash: hash });
  }

  // Provisional commit: real blobs + manifest rows now resolve offline; the
  // sentinel local_content_hash makes the next online sync reconcile.
  await scenarioStore.commitManifest(uniqid, manifest, SENTINEL, localVersion);
  return true;
}

// Returns the number of scenarios converted (0 if already migrated / fresh).
export async function migrateToCasIfNeeded(): Promise<number> {
  if (await flagDone()) return 0;

  const db = await getDb();
  const root = await appDataDir();
  let converted = 0;

  try {
    const rows = await db.select<Array<{ uniqid: string; local_version: number | null }>>(
      'SELECT uniqid, local_version FROM scenarios WHERE local_version IS NOT NULL'
    );
    for (const r of rows) {
      if (r.local_version === null) continue;
      try {
        if (await convertScenario(r.uniqid, r.local_version, root)) converted++;
      } catch (err) {
        // A single bad scenario must not block the migration - it'll just
        // re-download fresh on the next sync (its blobs simply weren't pooled).
        console.warn(`[casMigration] scenario ${r.uniqid} convert failed:`, err);
      }
    }

    // Remove the entire legacy scenario tree: converted files were moved out,
    // and any leftover stale v{N} dirs are now garbage (replaces the old
    // pruneStaleVersions sweep). Blobs live under media/blobs and are untouched.
    await removeRecursive('media/scenarios');
  } catch (err) {
    console.error('[casMigration] failed:', err);
    // Don't set the flag - retry on next boot rather than leaving a half-done
    // conversion permanently marked complete.
    return converted;
  }

  await setFlag();
  console.info(`[casMigration] converted ${converted} scenario(s) to the blob pool.`);
  return converted;
}
