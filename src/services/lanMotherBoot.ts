// Production boot path for the mother's local axum server.
//
// Until this module was added, the in-process LAN server only ever ran inside
// `lanSmokeTest.ts` - every production `launched_games` request went straight
// to studio.taghunter.fr. That made the new Devices-modal endpoints
// (`list_paired_with_status`, push commands, etc.) unreachable, since they
// only exist in the local axum.
//
// `ensureMotherServer` is idempotent: at first call after app boot it starts
// the server and installs a permanent LAN override for the `launched_games`
// endpoint so all launched-game traffic goes local. On subsequent calls (e.g.
// a React re-mount), it picks the running server up via `mother_get_server_info`
// without restarting it.
//
// Tradeoff to be explicit about: once the LAN override is installed, launched
// games created via the new flow live in the mother's SQLite, NOT in studio's
// MySQL. Cross-device persistence + studio dashboard visibility is a follow-up
// (cloud-sync, slice E of the LAN-mode roadmap).

import { invoke } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';
import { setLanOverride, getLanOverride, setLocalLaunchedGamesRoute } from './api';
import { notifyPromotedToMother, getPromotableGameId } from './motherFailover';
import { discoverOtherMothers, joinMother, hotspotStatus, startHotspot, refreshMdns } from './lanPairing';
import { getNetworkSource, getPreferredHotspotCreds } from './lanCredentials';

interface MotherServerInfo {
  port: number;
  bound_addr: string;
  mother_device_uuid: string;
  mother_peer_secret: string;
  mother_peer_id: number;
}

let bootPromise: Promise<MotherServerInfo | null> | null = null;
// Remembered so a satellite can restore its own local `launched_games` routing
// after leaving a mother's game (see point/restore helpers below).
let localInfo: MotherServerInfo | null = null;

const LAUNCHED_GAMES_ENDPOINTS = new Set(['launched_games']);

// Record this device's OWN local server as the force-local route in api.ts, so
// the "This device" section can read local history even while the main override
// is pointed at a mother. Called whenever `localInfo` is (re)established.
function publishLocalRoute(info: MotherServerInfo): void {
  setLocalLaunchedGamesRoute({
    baseUrl: `http://127.0.0.1:${info.port}`,
    token: info.mother_peer_secret,
  });
}

/**
 * Repoint `launched_games` traffic at a MOTHER device (used when this device is
 * a satellite joining the mother's launched game). Reads/writes - game state,
 * register_device, punches - then hit the mother's SQLite instead of our own
 * empty local server. `baseUrl` like `http://192.168.137.1:52202`.
 */
export function pointLaunchedGamesAtMother(baseUrl: string, token: string): void {
  setLanOverride({ baseUrl, token, endpoints: LAUNCHED_GAMES_ENDPOINTS });
}

/** Restore `launched_games` routing to this device's own local server. */
export function restoreLocalLaunchedGames(): void {
  if (!localInfo) return;
  setLanOverride({
    baseUrl: `http://127.0.0.1:${localInfo.port}`,
    token: localInfo.mother_peer_secret,
    endpoints: LAUNCHED_GAMES_ENDPOINTS,
  });
}

export interface BecomeMotherInfo extends MotherServerInfo {
  epoch: number;
  hotspot_started: boolean;
  hotspot_error: string | null;
}

/**
 * Mother-failover slice 4: promote THIS device into the new mother for
 * `launchedGameId`, adopting its cached snapshot (game state + pairing table),
 * bumping the epoch, and best-effort raising the same-named hotspot. On success
 * this device's `launched_games` traffic is routed at its own freshly-started
 * server. Throws with a human-readable message on the guards (no cached
 * snapshot on this device / scenario content not synced).
 */
export async function becomeMother(
  launchedGameId: number,
  mdnsLabel?: string
): Promise<BecomeMotherInfo> {
  const info = await invoke<BecomeMotherInfo>('become_mother', {
    launchedGameId,
    port: 0, // 0 = OS picks; the command returns the actual port
    mdnsLabel: mdnsLabel ?? null,
  });
  // We are the mother now - route launched_games at our own server and let
  // ensureMotherServer pick this up on subsequent calls without restarting.
  localInfo = info;
  publishLocalRoute(info);
  bootPromise = Promise.resolve(info);
  setLanOverride({
    baseUrl: `http://127.0.0.1:${info.port}`,
    token: info.mother_peer_secret,
    endpoints: LAUNCHED_GAMES_ENDPOINTS,
  });
  // We're the mother now - clear the "unreachable" banner.
  notifyPromotedToMother();
  return info;
}

export interface TakeoverTarget {
  launched_game_id: number;
  game_name: string;
  addr: string;
  port: number;
  mother_uuid: string;
  epoch: number;
}

/**
 * "Regain control": this device stood down (a different device is the live
 * mother at a higher epoch), and the operator wants to host on THIS device
 * instead. We first pull the live mother's CURRENT snapshot - so we adopt the
 * up-to-date state, not this device's stale copy - then promote (epoch bumps
 * again, so satellites and the now-orphaned mother converge on us). Throws with
 * a readable message if the live mother can't be reached or has no state.
 */
export async function takeoverMother(target: TakeoverTarget): Promise<BecomeMotherInfo> {
  const ok = await invoke<boolean>('fetch_snapshot_from_mother', {
    launchedGameId: target.launched_game_id,
    addr: target.addr,
    port: target.port,
  });
  if (!ok) {
    throw new Error(
      'Could not fetch the current game state from the active mother - it may have just gone offline. Try again.'
    );
  }
  return becomeMother(target.launched_game_id);
}

/**
 * The inverse of takeover: a LIVE mother that's been superseded (another device
 * took control at a higher epoch) yields. It stops its own server + hotspot and
 * becomes a satellite of the winner - pointing launched_games at it (our self
 * secret authenticates, since the winner adopted our row) and tracking it as a
 * paired mother so the footer reflects it. Without this, the old mother keeps
 * its server up and its "Mother" footer icon stays green (visible split-brain).
 */
export async function yieldToMother(target: TakeoverTarget): Promise<void> {
  await invoke('mother_stop_local_server').catch(() => {});
  // Drop our own AP too - the winner raises its own (same SSID in hotspot mode),
  // and two same-SSID APs is exactly what we want to avoid.
  await invoke('mother_stop_hotspot').catch(() => {});

  const secret = await invoke<string | null>('get_self_peer_secret').catch(() => null);
  if (secret) {
    pointLaunchedGamesAtMother(`http://${target.addr}:${target.port}`, secret);
    await invoke('client_save_paired_mother', {
      motherUuid: target.mother_uuid,
      motherLabel: null,
      peerSecret: secret,
    }).catch(() => {});
    await invoke('client_refresh_mother_endpoints', { timeoutMs: 2500 }).catch(() => {});
  }
}

export type ForceMotherOutcome = 'takeover' | 'adopted' | 'restarted';

/**
 * Operator-forced "make THIS device the mother", from the Network settings
 * button. Handles every situation, in order of preference:
 *  1. A live, higher-epoch mother is on the LAN → pull its CURRENT state and
 *     promote (no data loss) - same as the startup prompt.
 *  2. No live competitor, but this device cached a snapshot → adopt that.
 *  3. Neither → (re)start this device's own local server (e.g. the original
 *     mother whose game lives locally and which stood down at boot; with no
 *     higher epoch advertised now, the fence lets it serve).
 * Throws with a readable message if none apply.
 */
export async function forceBecomeMother(clientId: number): Promise<ForceMotherOutcome> {
  console.log('[forceBecomeMother] start clientId=', clientId);
  // 1. Live higher-epoch mother present.
  const target = await invoke<TakeoverTarget | null>('get_takeover_target', { clientId }).catch(
    (e) => {
      console.warn('[forceBecomeMother] get_takeover_target failed:', e);
      return null;
    }
  );
  console.log('[forceBecomeMother] takeover target=', target);
  if (target) {
    await takeoverMother(target);
    return 'takeover';
  }
  // 2. Competitor gone, but we hold a cached snapshot.
  const gid = await getPromotableGameId();
  console.log('[forceBecomeMother] promotable game id=', gid);
  if (gid != null) {
    try {
      await becomeMother(gid);
      return 'adopted';
    } catch (e) {
      // Only fall through when there's simply nothing cached for it; a content
      // guard / real failure should surface to the operator.
      const msg = String((e as { message?: string })?.message ?? e);
      console.warn('[forceBecomeMother] becomeMother(', gid, ') failed:', msg);
      if (!msg.includes('No cached snapshot')) throw e;
    }
  }
  // 3. Restart our own local server - ONLY if our game actually lives here
  //    (the original mother). Otherwise there's nothing to take control of:
  //    don't start an empty server and falsely report success.
  const hasLocalGame = await deviceHasLocalActiveGame();
  console.log('[forceBecomeMother] hasLocalActiveGame=', hasLocalGame);
  if (!hasLocalGame) {
    throw new Error(
      'This device was not part of any active game (no saved state, and no other host is reachable). ' +
        'Join the game on this device first, or take control from a device that was in it.'
    );
  }
  console.log('[forceBecomeMother] falling back to ensureMotherServer');
  const info = await ensureMotherServer(clientId);
  console.log('[forceBecomeMother] ensureMotherServer →', info ? `port ${info.port}` : 'null');
  if (!info) {
    throw new Error(
      'Could not take control: another device may already be the current mother. Try again in a few seconds.'
    );
  }
  return 'restarted';
}

/**
 * B1 (fused mother+hotspot): raise this mother's Wi-Fi hotspot when the network
 * source is `hotspot` (Windows-only; router-mode mothers ride an external AP and
 * raise none). Idempotent - never restarts a running AP, since that would
 * briefly drop connected satellites. The creds come from studio (the sole
 * author), mirrored locally on sync; `getPreferredHotspotCreds` returns the
 * operator's preferred hotspot, or null when studio hasn't defined one yet (then
 * we skip raising). Best-effort: never throws. Shared by the App boot path and
 * the launch auto-promote (F1).
 */
export async function raiseMotherHotspotIfConfigured(): Promise<void> {
  try {
    if (platform() !== 'windows') return;
    if ((await getNetworkSource()) !== 'hotspot') return;
    const st = await hotspotStatus().catch(() => null);
    if (st?.running) return;
    const creds = await getPreferredHotspotCreds();
    if (!creds) {
      console.warn('[lanMotherBoot] no studio hotspot synced yet - skipping AP raise');
      return;
    }
    const info = await startHotspot(creds.ssid, creds.password);
    if (info.ipv4_addresses.length > 0) {
      await refreshMdns(info.ipv4_addresses).catch(() => {});
    }
  } catch (err) {
    console.error('[lanMotherBoot] raise hotspot failed:', err);
  }
}

/**
 * Mother/hotspot role rework (E1 stand-down → auto-pair): a willing device that
 * stood down at boot (the LAN fence found another live mother of this client)
 * joins that mother instead of competing. Browses mDNS for the highest-epoch
 * same-client mother and pairs with it - the mother auto-approves us on the LAN
 * (same client_id), so this is silent. Once paired, the periodic
 * `refreshLaunchedGamesRoute` tick points our launched_games traffic at it.
 * Returns true if we joined (or were already paired). Best-effort: a venue with
 * no other mother yet (we were simply first) returns false and we stay idle.
 */
let autoJoinInFlight: Promise<boolean> | null = null;

export async function autoJoinSameClientMother(clientId: number): Promise<boolean> {
  // Coalesce: the boot one-shot and the childControlLink tick can both call this
  // within the same window - run a single browse + pair at a time.
  if (autoJoinInFlight) return autoJoinInFlight;
  autoJoinInFlight = (async () => {
    const mothers = await discoverOtherMothers().catch(() => []);
    const candidate = mothers
      .filter((m) => m.addresses.length > 0 && m.port > 0)
      // Same client when advertised; tolerate older mothers that don't advertise it.
      .filter((m) => m.client_id == null || m.client_id === clientId)
      .sort((a, b) => (b.epoch ?? 0) - (a.epoch ?? 0))[0];
    if (!candidate) return false;
    try {
      const outcome = await joinMother(candidate, { timeoutMs: 8000 }).result;
      return outcome.kind === 'approved' || outcome.kind === 'already_paired';
    } catch {
      return false;
    }
  })();
  try {
    return await autoJoinInFlight;
  } finally {
    autoJoinInFlight = null;
  }
}

export async function deviceHasLocalActiveGame(): Promise<boolean> {
  try {
    const { getDb } = await import('./db');
    const rows = await (await getDb()).select<Array<{ n: number }>>(
      'SELECT COUNT(*) AS n FROM lg_launched_games WHERE ended = 0'
    );
    return (rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function ensureMotherServer(
  clientId: number,
  mdnsLabel?: string
): Promise<MotherServerInfo | null> {
  // Coalesce concurrent callers onto one in-flight boot - React Strict-Mode
  // double-mounts and the AuthProvider's auth-resolution effect can both
  // hit this within a few ms of each other.
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    try {
      // Server may already be running (e.g. smoke test left it up, or this
      // is a React re-mount). Pick it up rather than restarting.
      const existing = await invoke<MotherServerInfo | null>('mother_get_server_info');
      const info = existing
        ?? (await invoke<MotherServerInfo>('mother_start_local_server', {
          clientId,
          port: 0, // 0 = OS picks; the command returns the actual port
          mdnsLabel: mdnsLabel ?? null,
        }));

      // Install the LAN override unless someone else (the smoke test) set one
      // we shouldn't stomp. The smoke test always restores `null` in its
      // finally block, so a non-null override here is almost certainly ours.
      localInfo = info;
      publishLocalRoute(info);
      const current = getLanOverride();
      if (!current || current.baseUrl.includes(`:${info.port}`) === false) {
        setLanOverride({
          baseUrl: `http://127.0.0.1:${info.port}`,
          token: info.mother_peer_secret,
          // Only launched_games is routed locally. Scenarios, patterns,
          // auth, etc. still go to studio.
          endpoints: new Set(['launched_games']),
        });
      }
      return info;
    } catch (err) {
      // Slice 6: a deliberate stand-down (another device is the current mother
      // at a higher epoch) comes back as the `mother_superseded` sentinel - log
      // it calmly, not as a failure. Returning null makes App.tsx skip raising
      // our hotspot, so we don't recreate the split-brain the fence prevented.
      const msg = String((err as { message?: string })?.message ?? err);
      if (msg.includes('mother_superseded')) {
        console.warn('[lanMotherBoot] standing down - another device is the current mother (higher epoch).');
      } else {
        console.error('[lanMotherBoot] failed to start/locate mother server:', err);
      }
      bootPromise = null; // allow retry on next caller
      return null;
    }
  })();

  return bootPromise;
}
