// LAN pairing service: typed wrappers around the Rust LAN/hotspot commands plus
// the satellite-side pair handshake (request → poll → persist). This is the
// production path that the operator "devices" UI drives; the same handshake is
// exercised by `lanSmokeTest.ts` from DevTools.
//
// All command names/structs mirror `src-tauri/src/lan_server.rs` and
// `src-tauri/src/hotspot.rs` (serde keeps snake_case; invoke args are camelCase
// and Tauri maps them to snake_case Rust params).

import { invoke } from '@tauri-apps/api/core';
import { getDeviceMetadata, getCachedDeviceDisplayName } from './device';
import { getAuthUser } from './authStore';
import { saveHotspotCreds } from './lanCredentials';
import { parseDbTs, formatDbDateTime } from '../utils/dbTime';

// The Rust side seeds a device's self row with this placeholder before the
// operator's device name is known (ensure_self_pair replaces it with the real
// name at every server start). Treat it as "no label" wherever a device name
// is rendered - it must never reach the screen.
export const SELF_PLACEHOLDER_LABEL = '__mother_self__';

/** A device label safe to render: the placeholder collapses to null. */
export function displayDeviceLabel(label: string | null | undefined): string | null {
  return !label || label === SELF_PLACEHOLDER_LABEL ? null : label;
}

// ─── types (mirror Rust structs) ─────────────────────────────────────────────

export interface HotspotInfo {
  ssid: string;
  password: string;
  ipv4_addresses: string[];
  platform: string;
}

export interface HotspotStatus {
  running: boolean;
  ssid: string | null;
  ipv4_addresses: string[];
  platform: string;
}

export interface LocalRole {
  is_mother_hosting: boolean;
  mother_server_running: boolean;
  paired_devices_count: number;
  paired_mothers_count: number;
}

export interface PairedDeviceRow {
  id: number;
  peer_uuid: string;
  peer_label: string;
  peer_os: string | null;
  paired_at: string;
  last_seen_at: string | null;
  is_self: boolean;
}

export interface PairedMotherRow {
  mother_uuid: string;
  mother_label: string | null;
  peer_secret: string;
  paired_at: string;
  last_seen_at: string | null;
}

export interface DiscoveredMother {
  mother_uuid: string;
  host: string;
  addresses: string[];
  port: number;
  label: string | null;
  // Mother-failover slice 3: from the mDNS TXT record. null for an older mother
  // that doesn't advertise them. Slice 5 uses these to re-point to the mother
  // serving this client and prefer the highest epoch after a promotion.
  client_id: number | null;
  epoch: number | null;
}

export interface MotherServerInfo {
  port: number;
  bound_addr: string;
  mother_device_uuid: string;
  mother_peer_secret: string;
  mother_peer_id: number;
}

// ─── mother-side commands ────────────────────────────────────────────────────

export async function startHotspot(ssid: string, password: string): Promise<HotspotInfo> {
  const info = await invoke<HotspotInfo>('mother_start_hotspot', { ssid, password });
  // Keep schema_meta (hotspot_ssid/password) in lockstep with the AP now on the
  // air. `read_mother_wifi` relays THOSE schema_meta creds to satellites over the
  // ping (which Wi-Fi to join), so they must always match the broadcast SSID -
  // otherwise a child learns a network that isn't being broadcast. Best-effort.
  await saveHotspotCreds(ssid, password).catch(() => {});
  return info;
}

// The hotspot watchdog (lanMotherBoot.motherHotspotWatchdogTick) must not fight
// a deliberate stop - record when this app last stopped the AP so the watchdog
// holds off for a cooldown window instead of instantly re-raising it.
let lastHotspotStopAt = 0;
export function getLastHotspotStopAt(): number {
  return lastHotspotStopAt;
}

export const stopHotspot = () => {
  lastHotspotStopAt = Date.now();
  return invoke<void>('mother_stop_hotspot');
};

export const hotspotStatus = () => invoke<HotspotStatus>('mother_hotspot_status');

export const getMotherServerInfo = () =>
  invoke<MotherServerInfo | null>('mother_get_server_info');

/** Re-announce this mother over mDNS, advertising `addresses` explicitly (e.g.
 *  the hotspot's IPv4) so satellites resolve a reachable AP-subnet address. */
export const refreshMdns = (addresses: string[]) =>
  invoke<void>('mother_refresh_mdns', { addresses });

// listPendingPairRequests / approvePairRequest / denyPairRequest were retired
// with the manual-approval ceremony: same-client joins auto-approve, everything
// else is flat-denied by the mother (see pair_request_handler in lan_server.rs).

export const listPairedDevices = () =>
  invoke<PairedDeviceRow[]>('mother_list_paired_devices');

export const revokePairedDevice = (peerId: number) =>
  invoke<void>('mother_revoke_paired_device', { peerId });

// ─── client-side commands ────────────────────────────────────────────────────

export const describeLocalRole = () =>
  invoke<LocalRole>('client_describe_local_role');

export const discoverMothers = (timeoutMs = 3000) =>
  invoke<DiscoveredMother[]>('client_discover_mothers', { timeoutMs });

// Result of a manual reachability probe (Step 3 of the hand-driven connect flow).
// `ok` separates "discoverable" (mDNS answered) from "reachable" (the TCP connect
// completed) - so a firewall block reads differently from a routing problem.
export interface MotherProbe {
  ok: boolean;
  reached_addr: string | null;
  mother_uuid: string | null;
  client_id: number | null;
  latency_ms: number | null;
  /** Per-address technical failure detail (the REAL OS error); empty on success. */
  errors: string[];
  /** Coarse cause from the real OS error: 'refused' | 'timeout' | 'unreachable' |
   *  'http' | 'other'. null on success. Drives the child's headline. */
  category: string | null;
}

/**
 * Unauthenticated reachability test against a discovered mother's addresses
 * (GET /pair.php?action=hello). Confirms the TCP path is actually open - the
 * half mDNS discovery can't prove - without pairing. Never mutates state.
 */
export const probeMother = (addresses: string[], port: number) =>
  invoke<MotherProbe>('client_probe_mother', { addresses, port });

/**
 * Discover mothers EXCLUDING this device. Every device runs its own mother
 * server and advertises over mDNS, so a raw discovery always includes self -
 * which must not appear in the "join a mother" list (you can't pair with
 * yourself, and its own loopback/APIPA address isn't reachable/allowed).
 */
export async function discoverOtherMothers(timeoutMs = 3000): Promise<DiscoveredMother[]> {
  const [list, selfInfo] = await Promise.all([
    discoverMothers(timeoutMs),
    getMotherServerInfo().catch(() => null),
  ]);
  const selfUuid = selfInfo?.mother_device_uuid;
  return list.filter((m) => m.mother_uuid !== selfUuid);
}

export const listPairedMothers = () =>
  invoke<PairedMotherRow[]>('client_list_paired_mothers');

export const forgetPairedMother = (motherUuid: string) =>
  invoke<void>('client_forget_paired_mother', { motherUuid });

export const getPairedMother = (motherUuid: string) =>
  invoke<PairedMotherRow | null>('client_get_paired_mother', { motherUuid });

export const refreshMotherEndpoints = () =>
  invoke<string[]>('client_refresh_mother_endpoints');

// ─── pair handshake (satellite side) ─────────────────────────────────────────
// The handshake runs in RUST (`client_pair_with_mother`) over reqwest, so it is
// NOT subject to the webview's `http:` capability scope - the LAN AP hands out
// arbitrary IPs (192.168.137.1, 169.254.x APIPA, …) that the scope matcher
// can't reliably allowlist. Rust tries each advertised address until one
// connects, polls for the operator's decision, and persists the secret +
// warms the endpoint cache on approval.

export type JoinOutcome =
  | { kind: 'approved' }
  | { kind: 'denied' }
  | { kind: 'already_paired' }
  | { kind: 'timeout' }
  | { kind: 'unreachable'; message: string };

export interface JoinHandle {
  /** Resolves once the mother approves/denies, times out, or is unreachable. */
  result: Promise<JoinOutcome>;
  /** Stop waiting (the Rust call keeps running but its result is ignored). */
  cancel: () => void;
}

/**
 * Join a discovered mother. Sends the operator's custom device name as the
 * label so the mother lists us by name. Returns a handle so the UI can show
 * "waiting for approval" and let the user cancel.
 */
export function joinMother(
  mother: DiscoveredMother,
  // `manual`: the operator pressed "Join" on this device - lifts a sticky
  // removal on the mother (retours sept. #8). Automatic re-pairs leave it off.
  opts?: { timeoutMs?: number; manual?: boolean },
): JoinHandle {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  let onCancel: ((o: JoinOutcome) => void) | null = null;
  const cancelled = new Promise<JoinOutcome>((res) => { onCancel = res; });

  const run = (async (): Promise<JoinOutcome> => {
    const [meta, displayName, me] = await Promise.all([
      getDeviceMetadata(),
      getCachedDeviceDisplayName().catch(() => null),
      getAuthUser().catch(() => null),
    ]);
    return invoke<JoinOutcome>('client_pair_with_mother', {
      motherUuid: mother.mother_uuid,
      motherLabel: mother.label,
      addresses: mother.addresses,
      port: mother.port,
      peerLabel: displayName || meta.device_label,
      peerOs: meta.os,
      peerAppVersion: meta.app_version,
      // Sent so a same-client mother auto-approves us on the LAN (E1).
      clientId: me?.client_id ?? null,
      timeoutMs,
      manual: opts?.manual ?? false,
    }).catch((e): JoinOutcome => ({
      kind: 'unreachable',
      message: (e as Error).message || String(e),
    }));
  })();

  return {
    result: Promise.race([run, cancelled]),
    cancel: () => onCancel?.({ kind: 'timeout' }),
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** True if an SQLite UTC timestamp is within `withinSec` of now. */
export function isRecent(lastSeenAt: string | null, withinSec = 25): boolean {
  if (!lastSeenAt) return false;
  const t = parseDbTs(lastSeenAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < withinSec * 1000;
}

/** Locale-formatted local time for an SQLite UTC timestamp. */
export function formatLanTime(ts: string | null): string {
  return formatDbDateTime(ts);
}
