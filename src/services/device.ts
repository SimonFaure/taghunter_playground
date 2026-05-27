import { getVersion } from '@tauri-apps/api/app';
import { platform, version as osVersion, hostname } from '@tauri-apps/plugin-os';
import type Database from '@tauri-apps/plugin-sql';
import { getDb } from './db';

export interface DeviceMetadata {
  device_uniq: string;
  device_label: string;
  os: string;
  os_version: string;
  app_version: string;
}

let cachedMetadata: DeviceMetadata | null = null;

export async function getDeviceMetadata(): Promise<DeviceMetadata> {
  if (cachedMetadata) return cachedMetadata;

  const db = await getDb();

  let uniq = await readSchemaMeta(db, 'device_uniq');
  if (!uniq) {
    uniq = crypto.randomUUID();
    await writeSchemaMeta(db, 'device_uniq', uniq);
  }

  let p = 'unknown';
  let v = 'unknown';
  try { p = platform(); } catch { /* keep default */ }
  try { v = osVersion(); } catch { /* keep default */ }
  const h = await hostname().catch(() => null);
  const appVersion = await getVersion().catch(() => 'unknown');

  cachedMetadata = {
    device_uniq: uniq,
    device_label: h || normalizePlatform(p) + ' device',
    os: normalizePlatform(p),
    os_version: v,
    app_version: appVersion,
  };

  return cachedMetadata;
}

function normalizePlatform(raw: string): string {
  switch (raw) {
    case 'windows': return 'Windows';
    case 'macos': return 'macOS';
    case 'linux': return 'Linux';
    case 'ios': return 'iOS';
    case 'android': return 'Android';
    default: return raw;
  }
}

async function readSchemaMeta(db: Database, key: string): Promise<string | null> {
  const rows = await db.select<{ value: string }[]>(
    'SELECT value FROM schema_meta WHERE key = $1',
    [key]
  );
  return rows.length > 0 ? rows[0].value : null;
}

async function writeSchemaMeta(db: Database, key: string, value: string): Promise<void> {
  await db.execute(
    'INSERT INTO schema_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

// Friendly, user-set name for THIS device (assigned in Settings → My Devices).
// It lives server-side, so we cache the resolved value locally and let the
// footer read it instantly and offline. Falls back to the OS hostname when the
// user hasn't set one (see Footer).
const DISPLAY_NAME_KEY = 'device_display_name';

export async function getCachedDeviceDisplayName(): Promise<string | null> {
  const db = await getDb();
  return readSchemaMeta(db, DISPLAY_NAME_KEY);
}

export async function setCachedDeviceDisplayName(name: string | null): Promise<void> {
  const db = await getDb();
  const trimmed = name?.trim();
  if (trimmed) {
    await writeSchemaMeta(db, DISPLAY_NAME_KEY, trimmed);
  } else {
    await db.execute('DELETE FROM schema_meta WHERE key = $1', [DISPLAY_NAME_KEY]);
  }
}
