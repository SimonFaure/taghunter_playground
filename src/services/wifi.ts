import { invoke } from '@tauri-apps/api/core';
import { getDb } from './db';

// Returns the SSID the device is currently associated with, or null when the
// platform call fails or the device is not connected to Wi-Fi. The footer
// uses this only as tooltip flavour text - connection state itself is driven
// by the mother-ping state machine in useMotherConnection.
export async function getCurrentSsid(): Promise<string | null> {
  try {
    return (await invoke<string | null>('get_wifi_ssid')) ?? null;
  } catch {
    return null;
  }
}

// List Wi-Fi SSIDs currently in range (Windows/mac/Linux). Returns [] on mobile
// or any failure - the auto-connect engine treats "empty" as "can't see the
// target", which simply means it won't attempt a join (no error path).
export async function scanWifi(): Promise<string[]> {
  try {
    return (await invoke<string[]>('scan_wifi')) ?? [];
  } catch {
    return [];
  }
}

// Same as scanWifi, but first forces a real radio scan (WlanScan, ~4 s). The
// cached list can miss an AP that just appeared - a freshly promoted mother's
// hotspot (retours sept. #19) - for minutes. Use when not connected / after a
// mother loss; the plain scan stays the cheap default.
export async function scanWifiFresh(): Promise<string[]> {
  try {
    return (await invoke<string[]>('wifi_scan_fresh')) ?? [];
  } catch {
    return scanWifi();
  }
}

// Drop the current Wi-Fi association. `ssid`: that profile is also switched to
// manual connection so Windows doesn't re-join it on its own (a device that now
// hosts that SSID itself). Best-effort, never throws.
export async function disconnectWifi(ssid?: string): Promise<void> {
  try {
    await invoke('wifi_disconnect', { ssid: ssid ?? null });
  } catch {
    /* not connected / not Windows */
  }
}

// Join a Wi-Fi network by SSID + WPA2 passphrase. Throws on failure (caller
// surfaces the manual-join fallback). Not supported on mobile.
export async function connectWifi(ssid: string, password: string): Promise<void> {
  await invoke('connect_wifi', { ssid, password });
}

// True for an APIPA / link-local address (169.254.x). A device stuck on one is
// "connected" to the AP but never got a DHCP lease, so it can't reach the mother's
// 192.168.137.1 gateway.
export function isApipa(ip: string): boolean {
  return ip.startsWith('169.254.');
}

// Force a fresh DHCP lease (ipconfig /renew) and return the device's IPv4s after.
// Fixes the child-stuck-on-APIPA case where it joined the hotspot before the
// mother's ICS DHCP was ready. Returns [] on failure / non-desktop.
export async function renewDhcp(): Promise<string[]> {
  try {
    return (await invoke<string[]>('wifi_renew_dhcp')) ?? [];
  } catch {
    return [];
  }
}

// This device's non-loopback IPv4 addresses (no side effects). Used to detect the
// APIPA condition (all 169.254.* / no real lease).
export async function localIpv4s(): Promise<string[]> {
  try {
    return (await invoke<string[]>('get_local_ipv4s')) ?? [];
  } catch {
    return [];
  }
}

// True when this device is stuck on APIPA: it has a 169.254.* address and no
// usable 192.168.137.* hotspot lease. That's "connected but on the wrong subnet".
export async function isStuckOnApipa(): Promise<boolean> {
  const ips = await localIpv4s();
  const onApipa = ips.some(isApipa);
  const onHotspot = ips.some((ip) => ip.startsWith('192.168.137.'));
  return onApipa && !onHotspot;
}

// Renew DHCP only when stuck on APIPA, throttled so a permanently-failing renew
// (mother's ICS DHCP genuinely down) doesn't spam ipconfig every poll. Returns
// true if a renew was attempted. Once a real lease lands, isStuckOnApipa() is
// false and this no-ops - so it self-limits the moment it succeeds.
let lastRenewAttempt = 0;
const RENEW_MIN_INTERVAL_MS = 60_000;
export async function maybeRenewDhcpIfStuck(): Promise<boolean> {
  if (!(await isStuckOnApipa())) return false;
  const now = Date.now();
  if (now - lastRenewAttempt < RENEW_MIN_INTERVAL_MS) return false;
  lastRenewAttempt = now;
  await renewDhcp();
  return true;
}

// ─── static-IP fallback ──────────────────────────────────────────────────────
// When the mother's ICS DHCP won't lease (child stuck on APIPA despite the mother
// being up on 192.168.137.1), add a static IP on the child's Wi-Fi adapter so it
// can reach the mother anyway. Elevated (one UAC). The address is ADDITIVE - DHCP
// stays enabled - so the device still pulls a normal internet lease on any other
// Wi-Fi with no manual reset and no auto-revert prompt. We remember which SSID it
// was applied for only to drive the UI (the "remove static IP" action + hint).

const STATIC_SSID_KEY = 'static_ip_for_ssid';

async function readMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    'SELECT value FROM schema_meta WHERE key = $1',
    [key]
  );
  return rows[0]?.value ?? null;
}

async function writeMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'INSERT INTO schema_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

async function clearMeta(key: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM schema_meta WHERE key = $1', [key]);
}

/** Force a static IP on the mother's /24 (derived from `gateway`). Returns the
 *  assigned IP and records the current SSID for later auto-revert. Elevated. */
export async function assignStaticIp(gateway: string): Promise<string> {
  const ip = await invoke<string>('wifi_assign_static_ip', { gateway });
  // Record the marker unconditionally so the "restore DHCP" affordance always
  // appears after assigning - getCurrentSsid() can transiently return null right
  // after a Wi-Fi change, and a missing marker would strand the static IP with no
  // one-tap way back. Fall back to a sentinel when the SSID isn't readable.
  const ssid = await getCurrentSsid().catch(() => null);
  await writeMeta(STATIC_SSID_KEY, ssid || 'unknown');
  return ip;
}

/** Remove the static IP (drop the manual address, ensure DHCP is on) and clear
 *  the marker. Elevated. Optional hygiene - internet already works without it
 *  since the static is additive; also repairs a device left DHCP-Disabled by an
 *  older build. */
export async function restoreDhcpFromStatic(): Promise<void> {
  await invoke('wifi_restore_dhcp');
  await clearMeta(STATIC_SSID_KEY);
}

/** The SSID a static IP is currently applied for, or null. */
export async function staticIpSsid(): Promise<string | null> {
  return readMeta(STATIC_SSID_KEY);
}

