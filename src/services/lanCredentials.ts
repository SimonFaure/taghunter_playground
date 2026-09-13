// Default-credential generators for the LAN Wi-Fi hotspot. Production creds
// are studio-authored (see getPreferredHotspotCreds below); the generators
// survive only for the DevTools hotspot harness (lanHotspotTest.ts).
//
// The alphabet deliberately excludes characters that need escaping in the
// `WIFI:` QR format and the visually-ambiguous I/O/l/0/1, matching the
// validation in `src-tauri/src/hotspot.rs` (rejects ; , " : \).

/** A friendly, unique-ish default SSID, e.g. `TagHunter-3f9a1c2b`. */
export function defaultSsid(): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `TagHunter-${suffix}`;
}

/** A 12-char alphanumeric WPA2 password (8–63 chars required by Windows). */
export function defaultPassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/**
 * Build a standard `WIFI:` QR payload so a phone camera can join the AP.
 * WPA2 only (matches the hotspot manager). Special chars are escaped per the
 * QR spec, though the default generators above already avoid them.
 */
export function wifiQrPayload(ssid: string, password: string): string {
  const esc = (s: string) => s.replace(/([\\;,":])/g, '\\$1');
  return `WIFI:T:WPA;S:${esc(ssid)};P:${esc(password)};;`;
}

// ─── persistence ─────────────────────────────────────────────────────────────
// The hotspot SSID/password must be STABLE across app restarts so satellites
// reconnect to a known network automatically. We persist them in `schema_meta`
// (the same key/value table device.ts uses) and generate once on first use.

import { getDb } from './db';

const SSID_KEY = 'hotspot_ssid';
const PASSWORD_KEY = 'hotspot_password';

export interface HotspotCreds { ssid: string; password: string; }

async function readMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    'SELECT value FROM schema_meta WHERE key = $1', [key]
  );
  return rows.length > 0 ? rows[0].value : null;
}

async function writeMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'INSERT INTO schema_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

/**
 * Persist the hotspot credentials this device is actually broadcasting.
 * These schema_meta keys are the "currently on air" mirror read by the Rust
 * ping relay (read_mother_wifi) so satellites learn the live SSID/password.
 * The creds themselves are studio-authored (see getPreferredHotspotCreds) -
 * the old generate-on-device path is gone.
 */
export async function saveHotspotCreds(ssid: string, password: string): Promise<void> {
  await Promise.all([writeMeta(SSID_KEY, ssid), writeMeta(PASSWORD_KEY, password)]);
}

// ─── network source (hotspot vs external router) ─────────────────────────────
// The mother can create the LAN itself (the Windows hotspot) or simply ride on a
// Wi-Fi network provided by an external router. The networking stack works the
// same either way; this preference only drives which host UI is shown. The
// router SSID/password are NOT auto-generated - they describe the operator's
// existing network and are blank until typed (used only to show a join QR).

export type NetworkSource = 'hotspot' | 'router';

const NETWORK_SOURCE_KEY = 'lan_network_source';
const ROUTER_SSID_KEY = 'lan_router_ssid';
const ROUTER_PASSWORD_KEY = 'lan_router_password';

export interface RouterCreds { ssid: string; password: string; }

/** Read the operator's chosen LAN network source (defaults to the hotspot). */
export async function getNetworkSource(): Promise<NetworkSource> {
  return (await readMeta(NETWORK_SOURCE_KEY)) === 'router' ? 'router' : 'hotspot';
}

/** Persist the operator's chosen LAN network source. */
export async function setNetworkSource(src: NetworkSource): Promise<void> {
  await writeMeta(NETWORK_SOURCE_KEY, src);
}

/** Return the persisted router SSID/password (empty strings until entered). */
export async function getRouterCreds(): Promise<RouterCreds> {
  const [ssid, password] = await Promise.all([
    readMeta(ROUTER_SSID_KEY), readMeta(ROUTER_PASSWORD_KEY),
  ]);
  return { ssid: ssid ?? '', password: password ?? '' };
}

/** Persist the operator's router SSID/password (used to render the join QR). */
export async function saveRouterCreds(ssid: string, password: string): Promise<void> {
  await Promise.all([writeMeta(ROUTER_SSID_KEY, ssid), writeMeta(ROUTER_PASSWORD_KEY, password)]);
}

// ─── studio-authored hotspot (sole source of truth) ──────────────────────────
// Studio defines each client's hotspot SSID/password; the sync orchestrator's
// `lan_networks` work-item mirrors them into `wifi_networks` with origin='studio'.
// The mother raises one of these instead of auto-generating its own. When a
// client has several (multi-venue), the operator's per-device "preferred hotspot"
// choice (this schema_meta key) selects which; otherwise the first synced one.
// Design: plans/studio-authoritative-hotspot-creds.md.

import { list as listWifiNetworks } from './wifiNetworksStore';

const PREFERRED_HOTSPOT_KEY = 'preferred_hotspot_ssid';

/** All studio-relayed hotspots this device knows (the local mirror of studio). */
export async function getStudioHotspots(): Promise<HotspotCreds[]> {
  const rows = await listWifiNetworks();
  return rows
    .filter((r) => r.origin === 'studio')
    .map((r) => ({ ssid: r.ssid, password: r.password }));
}

/** The operator's per-device preferred hotspot SSID (empty until chosen). */
export async function getPreferredHotspotSsid(): Promise<string> {
  return (await readMeta(PREFERRED_HOTSPOT_KEY)) ?? '';
}

/** Persist the operator's per-device preferred hotspot SSID. */
export async function setPreferredHotspotSsid(ssid: string): Promise<void> {
  await writeMeta(PREFERRED_HOTSPOT_KEY, ssid);
}

/**
 * Resolve the hotspot creds this device's mother should raise: the preferred one
 * if the operator picked it (and it's still synced), else the first studio
 * hotspot. Studio stays the author of record - but when NO studio hotspot has
 * ever synced (fresh install provisioned offline, or studio's lan_networks
 * fail-opened to version 0), fall back to an operator-typed manual network so
 * the venue can still get an AP with zero studio contact. That mirrors the
 * child side, which has had a manual "Add a network" escape hatch all along.
 * Children learn whatever SSID the mother actually broadcasts via the ping
 * relay, and when studio creds later sync they win again (the SSID-mismatch
 * restart in raiseMotherHotspotIfConfigured migrates the fleet automatically).
 * Last of all, fall back to the schema_meta pair - the creds this device is set
 * up to broadcast - which is what a mid-game PROMOTED mother has (become_mother
 * mirrors the dead mother's creds there; it never synced nor typed them).
 * Returns null only when there is none of the three. We never auto-generate.
 */
export async function getPreferredHotspotCreds(): Promise<HotspotCreds | null> {
  const preferred = await getPreferredHotspotSsid();
  const hotspots = await getStudioHotspots();
  if (hotspots.length > 0) {
    if (preferred) {
      const match = hotspots.find((h) => h.ssid === preferred);
      if (match) return match;
    }
    return hotspots[0];
  }
  const manual = (await listWifiNetworks()).filter(
    (r) =>
      r.origin === 'manual' &&
      r.source !== 'router' &&
      // Pre-filter what the Rust validator would reject anyway (WPA2 bounds),
      // so a typo'd row doesn't wedge the raise path in a fail-retry loop.
      r.password.length >= 8 &&
      r.password.length <= 63
  );
  if (manual.length > 0) {
    const match = preferred ? manual.find((h) => h.ssid === preferred) : undefined;
    const pick = match ?? manual[0];
    return { ssid: pick.ssid, password: pick.password };
  }
  // Last resort: the schema_meta pair - the AP creds this device is set up to
  // broadcast. On a satellite PROMOTED mid-game these are the only ones present:
  // become_mother mirrors the dead mother's creds there (step 5c-bis), but the
  // device never synced them from studio and never typed them by hand, so both
  // lookups above come back empty. Without this, the AP-retry path and the
  // hotspot watchdog no-op on exactly the device that just took over the game.
  const [ssid, password] = await Promise.all([readMeta(SSID_KEY), readMeta(PASSWORD_KEY)]);
  if (ssid && password) return { ssid, password };
  return null;
}
