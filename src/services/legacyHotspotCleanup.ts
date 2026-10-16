// One-shot cleanup after the mother hotspot was retired (2026-09-30).
//
// Devices now join a shared router / venue network through Windows; the app no
// longer raises a Wi-Fi hotspot nor manages Wi-Fi. A PC upgrading from a
// hotspot-era build can still have Windows' Mobile Hotspot running (it survives
// restarts) and auto-connect WLAN profiles the old auto-join engine wrote for
// the mother's SSID. This runs once per device at boot (schema_meta flag):
// stops OUR hotspot, deletes those profiles, clears the retired keys, and - only
// on a device that actually used the hotspot - asks for the one-time notice.
//
// Remove together with `legacy_net_cleanup.rs` once the fleet has upgraded.

import { invoke } from '@tauri-apps/api/core';
import { getDb } from './db';

const DONE_KEY = 'legacy_hotspot_cleanup_done';
const NOTICE_KEY = 'hotspot_removed_notice_pending';

// Every schema_meta key the hotspot / Wi-Fi auto-join stack used to write.
const RETIRED_KEYS = [
  'lan_network_source',
  'hotspot_ssid',
  'hotspot_password',
  'lan_router_ssid',
  'lan_router_password',
  'preferred_hotspot_ssid',
  'static_ip_for_ssid',
  'onboarding_hotspot',
  'lan_networks_cursor',
];

interface CleanupReport {
  hotspot_stopped: boolean;
  hotspot_error: string | null;
  profiles_deleted: string[];
}

async function readMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>('SELECT value FROM schema_meta WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

async function writeMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'INSERT INTO schema_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

/** Idempotent; never throws. Safe to call at every boot. */
export async function runLegacyHotspotCleanup(): Promise<void> {
  try {
    if ((await readMeta(DONE_KEY)) === '1') return;
    const db = await getDb();

    const source = await readMeta('lan_network_source');
    const ssids = new Set<string>();
    for (const key of ['hotspot_ssid', 'preferred_hotspot_ssid']) {
      const v = await readMeta(key);
      if (v) ssids.add(v);
    }
    // Hotspot SSIDs the auto-join engine wrote profiles for. Router rows are
    // left alone: Windows keeps owning those networks.
    const rows = await db
      .select<{ ssid: string }[]>("SELECT ssid FROM wifi_networks WHERE source = 'hotspot'")
      .catch(() => [] as { ssid: string }[]);
    for (const r of rows) if (r.ssid) ssids.add(r.ssid);

    const usedHotspot = ssids.size > 0 && source !== 'router';
    const report = await invoke<CleanupReport>('legacy_hotspot_cleanup', { ssids: [...ssids] }).catch(
      () => null
    );
    if (report) console.log('[legacyHotspotCleanup]', report);

    await db.execute('DELETE FROM wifi_networks').catch(() => {});
    await db.execute(
      `DELETE FROM schema_meta WHERE key IN (${RETIRED_KEYS.map((_, i) => `$${i + 1}`).join(',')})`,
      RETIRED_KEYS
    );
    if (usedHotspot || report?.hotspot_stopped) await writeMeta(NOTICE_KEY, '1');
    await writeMeta(DONE_KEY, '1');
  } catch (e) {
    console.warn('[legacyHotspotCleanup] failed (retried at next boot):', e);
  }
}

/** True while the one-time "hotspot removed" notice hasn't been dismissed. */
export async function isHotspotRemovedNoticePending(): Promise<boolean> {
  return (await readMeta(NOTICE_KEY).catch(() => null)) === '1';
}

export async function dismissHotspotRemovedNotice(): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM schema_meta WHERE key = $1', [NOTICE_KEY]).catch(() => {});
}
