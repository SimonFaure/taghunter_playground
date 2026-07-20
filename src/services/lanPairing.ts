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

export interface PendingPairRequest {
  id: number;
  peer_uuid: string;
  peer_label: string;
  peer_os: string | null;
  peer_app_version: string | null;
  created_at: string;
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

export const startHotspot = (ssid: string, password: string) =>
  invoke<HotspotInfo>('mother_start_hotspot', { ssid, password });

export const stopHotspot = () => invoke<void>('mother_stop_hotspot');

export const hotspotStatus = () => invoke<HotspotStatus>('mother_hotspot_status');

export const getMotherServerInfo = () =>
  invoke<MotherServerInfo | null>('mother_get_server_info');

/** Re-announce this mother over mDNS, advertising `addresses` explicitly (e.g.
 *  the hotspot's IPv4) so satellites resolve a reachable AP-subnet address. */
export const refreshMdns = (addresses: string[]) =>
  invoke<void>('mother_refresh_mdns', { addresses });

export const listPendingPairRequests = () =>
  invoke<PendingPairRequest[]>('mother_list_pending_pair_requests');

export const approvePairRequest = (requestId: number) =>
  invoke<number>('mother_approve_pair_request', { requestId });

export const denyPairRequest = (requestId: number) =>
  invoke<void>('mother_deny_pair_request', { requestId });

export const listPairedDevices = () =>
  invoke<PairedDeviceRow[]>('mother_list_paired_devices');

export const revokePairedDevice = (peerId: number) =>
  invoke<void>('mother_revoke_paired_device', { peerId });

// ─── client-side commands ────────────────────────────────────────────────────

export const describeLocalRole = () =>
  invoke<LocalRole>('client_describe_local_role');

export const discoverMothers = (timeoutMs = 3000) =>
  invoke<DiscoveredMother[]>('client_discover_mothers', { timeoutMs });

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
  opts?: { timeoutMs?: number },
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

/** Parse an SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS") to epoch ms, or NaN. */
function parseLanTs(ts: string): number {
  // Already has a timezone marker (cloud ISO) - parse as-is.
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(ts)) return Date.parse(ts);
  return Date.parse(ts.replace(' ', 'T') + 'Z');
}

/** True if an SQLite UTC timestamp is within `withinSec` of now. */
export function isRecent(lastSeenAt: string | null, withinSec = 25): boolean {
  if (!lastSeenAt) return false;
  const t = parseLanTs(lastSeenAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < withinSec * 1000;
}

/** Locale-formatted local time for an SQLite UTC timestamp. */
export function formatLanTime(ts: string | null): string {
  if (!ts) return '';
  const t = parseLanTs(ts);
  return Number.isNaN(t) ? ts : new Date(t).toLocaleString();
}
