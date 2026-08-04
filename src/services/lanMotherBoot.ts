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
import { setLanOverride, getLanOverride, setLocalLaunchedGamesRoute, LOCAL_ONLY_ENDPOINTS } from './api';
import { notifyPromotedToMother, getPromotableGameId } from './motherFailover';
import { discoverOtherMothers, joinMother, hotspotStatus, startHotspot, stopHotspot, refreshMdns, getLastHotspotStopAt } from './lanPairing';
import { getNetworkSource, getPreferredHotspotCreds, saveHotspotCreds } from './lanCredentials';
import { ensureFirewallRuleOnce } from './firewall';
import { loadConfig, saveConfig } from '../utils/config';

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

// The LAN-routed endpoint family. Single source of truth lives in api.ts
// (LOCAL_ONLY_ENDPOINTS) so the override installers and the fail-closed gate
// can never drift apart.
const LAUNCHED_GAMES_ENDPOINTS = LOCAL_ONLY_ENDPOINTS;

// ─── hotspot health surface ──────────────────────────────────────────────────
// A willing hotspot-mode mother that can't get its AP on the air used to fail
// as a console.warn nobody sees - on an offline site the only symptom was
// "children can't find the mother". The raise routine now publishes its
// outcome; HotspotIssueBanner (App root) renders it persistently.
export type HotspotIssue =
  | { kind: 'no_creds' }
  | { kind: 'raise_failed'; message: string };

let hotspotIssue: HotspotIssue | null = null;
const hotspotIssueListeners = new Set<(issue: HotspotIssue | null) => void>();

function setHotspotIssue(issue: HotspotIssue | null): void {
  const changed =
    (issue === null) !== (hotspotIssue === null) ||
    issue?.kind !== hotspotIssue?.kind ||
    (issue?.kind === 'raise_failed' &&
      hotspotIssue?.kind === 'raise_failed' &&
      issue.message !== hotspotIssue.message);
  hotspotIssue = issue;
  if (!changed) return; // the watchdog re-reports every 10s - don't spam
  for (const fn of hotspotIssueListeners) {
    try {
      fn(issue);
    } catch {
      /* listener errors must not break the raise path */
    }
  }
}

/** Subscribe to hotspot-raise health; fires immediately with the current state. */
export function onHotspotIssue(fn: (issue: HotspotIssue | null) => void): () => void {
  hotspotIssueListeners.add(fn);
  fn(hotspotIssue);
  return () => hotspotIssueListeners.delete(fn);
}

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
  // First time this device hosts, make sure satellites can actually reach it
  // over the hotspot's Public profile (one-time UAC). Fire-and-forget so the
  // promotion isn't blocked on the prompt.
  void ensureFirewallRuleOnce();
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
 * The inverse of forceBecomeMother, for the Network-settings "I'm not a mother"
 * button: demote THIS device to a plain satellite right now, and stop it
 * volunteering at future boots.
 *  - `beMotherWhenAvailable` → false: both the App boot wiring and the hotspot
 *    watchdog gate on it, so nothing re-hosts or re-raises the AP afterwards.
 *  - Stop the local axum server: unregisters mDNS, so satellites stop
 *    resolving this device as a mother.
 *  - Drop our own hotspot: a satellite must never own 192.168.137.1 (see the
 *    watchdog's subnet-collision note). Uses lanPairing.stopHotspot so the
 *    deliberate-stop timestamp holds the watchdog off during its cooldown too.
 *  - Reset the module boot state and routing to a pure satellite's boot shape:
 *    no LAN override (the fail-closed gate re-arms) and no local route, so
 *    nothing keeps pointing at the now-dead 127.0.0.1 server.
 * Existing paired_devices rows are kept - if this device ever hosts again its
 * former children re-pair silently via the same-client auto-approve.
 * Best-effort by design; the caller should kick `refreshLaunchedGamesRoute()`
 * afterwards so the device converges on the venue's live mother (auto-join)
 * without waiting for the periodic tick.
 */
export async function demoteFromMother(): Promise<void> {
  const cfg = await loadConfig();
  if (cfg.beMotherWhenAvailable) {
    // Write only when the flag is actually set, so a failed loadConfig (which
    // returns defaults) can never overwrite a good config file with defaults.
    await saveConfig({ ...cfg, beMotherWhenAvailable: false }).catch(() => {});
  }
  await invoke('mother_stop_local_server').catch(() => {});
  await stopHotspot().catch(() => {});
  bootPromise = null;
  localInfo = null;
  setLocalLaunchedGamesRoute(null);
  setLanOverride(null);
  setHotspotIssue(null); // a non-mother expects no AP - clear any raise banner
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
    if ((await getNetworkSource()) !== 'hotspot') {
      setHotspotIssue(null); // router mode - an AP is not expected here
      return;
    }
    const creds = await getPreferredHotspotCreds();
    if (!creds) {
      console.warn('[lanMotherBoot] no hotspot creds (studio never synced, none typed) - skipping AP raise');
      setHotspotIssue({ kind: 'no_creds' });
      return;
    }
    // Keep schema_meta (hotspot_ssid/password) in lockstep with the studio creds.
    // That schema_meta pair is what the ping-relay + read_mother_wifi advertise to
    // satellites (which Wi-Fi to join). The studio sync only writes wifi_networks
    // (origin='studio'), so without this the mother keeps relaying a STALE
    // auto-generated SSID from a pre-studio-creds build - children then try to
    // join a network the AP isn't broadcasting ("pas à portée").
    await saveHotspotCreds(creds.ssid, creds.password).catch(() => {});
    let st = await hotspotStatus().catch(() => null);
    if (st?.running && st.ssid !== creds.ssid) {
      // Broadcasting a STALE SSID: stop it so we re-raise with the studio creds and
      // the AP + relayed creds agree. (Only restarts on an actual mismatch, so a
      // correct AP is never bounced.)
      console.warn(
        `[lanMotherBoot] hotspot SSID mismatch (broadcasting "${st.ssid}", studio "${creds.ssid}") - restarting AP`
      );
      await stopHotspot().catch(() => {});
      st = null;
    }
    // Raise the AP if it isn't up already; capture its IPv4(s) either way.
    const ipv4s = st?.running
      ? st.ipv4_addresses
      : (await startHotspot(creds.ssid, creds.password)).ipv4_addresses;
    // ALWAYS (re)announce mDNS on the AP subnet. With the mother-side LAN lock the
    // boot start_mdns is INERT until the AP has an IP; if the AP was already up (so
    // we skipped startHotspot) the announcement would otherwise never carry the AP
    // address and satellites could not DISCOVER the mother. refreshMdns re-runs
    // start_mdns, which merges these with the live interface IPs (192.168.137.1).
    await refreshMdns(ipv4s).catch(() => {});
    setHotspotIssue(null);
  } catch (err) {
    console.error('[lanMotherBoot] raise hotspot failed:', err);
    setHotspotIssue({
      kind: 'raise_failed',
      message: String((err as { message?: string })?.message ?? err),
    });
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

// Hotspot watchdog: Windows Mobile Hotspot can idle itself off (no clients /
// power saving) and nothing used to re-raise it - the mother kept serving a
// clientless subnet until an operator noticed the gray pill and tapped start
// in Settings. Called from the same 10s App tick as the mDNS keepalive: if
// this device is serving, is in hotspot mode, and its AP is down - and the
// operator didn't deliberately stop it just now - re-run the idempotent raise
// routine (which also re-announces mDNS on the AP subnet).
const HOTSPOT_WATCHDOG_COOLDOWN_MS = 5 * 60_000;
export async function motherHotspotWatchdogTick(): Promise<void> {
  try {
    if (platform() !== 'windows') return;
    if (Date.now() - getLastHotspotStopAt() < HOTSPOT_WATCHDOG_COOLDOWN_MS) return;
    // Cheap in-memory read - null on every non-mother, which ends the tick.
    const info = await invoke<MotherServerInfo | null>('mother_get_server_info');
    if (!info) return;
    // NEVER auto-raise an AP on a device that is a SATELLITE of another mother:
    // it would own 192.168.137.1 on its hosted adapter - the SAME subnet as the
    // mother's hotspot - which collides and breaks its own DHCP lease (→ APIPA)
    // and its route to the mother. A satellite can still be running a local server
    // (stale local-game rows / it booted first), so `info != null` is not enough.
    const role = await invoke<{ paired_mothers_count: number } | null>(
      'client_describe_local_role',
    ).catch(() => null);
    if (role && role.paired_mothers_count > 0) return;
    // Mirror the BOOT raise rule (App.tsx): only a WILLING mother owns the AP. A
    // device hosting only because it holds a local game leaves the AP to the
    // configured mother, so the watchdog must not raise one for it either.
    const cfg = await loadConfig().catch(() => null);
    if (!cfg?.beMotherWhenAvailable) return;
    const status = await hotspotStatus().catch(() => null);
    if (!status || status.running) return;
    if ((await getNetworkSource()) !== 'hotspot') return;
    console.warn('[lanMotherBoot] hotspot watchdog: AP is down while serving - re-raising.');
    await raiseMotherHotspotIfConfigured();
  } catch {
    // Best-effort - the watchdog must never disturb the tick.
  }
}

/**
 * Pickup-only companion to ensureMotherServer for contexts that must NEVER
 * start a server - the audience projector window. It installs the local
 * override for a mother server that is ALREADY running in this process
 * (mother_get_server_info is process-global Tauri state, shared across
 * windows) and returns null otherwise, without touching the boot promise.
 * The projector previously called ensureMotherServer unconditionally, which
 * could turn a pure satellite into a competing epoch-1 mother whenever the
 * boot fence's mDNS browse errored (fence is skipped on browse error).
 */
export async function attachToRunningMotherServer(): Promise<MotherServerInfo | null> {
  try {
    const existing = await invoke<MotherServerInfo | null>('mother_get_server_info');
    if (!existing) return null;
    localInfo = existing;
    publishLocalRoute(existing);
    const current = getLanOverride();
    if (!current || current.baseUrl.includes(`:${existing.port}`) === false) {
      setLanOverride({
        baseUrl: `http://127.0.0.1:${existing.port}`,
        token: existing.mother_peer_secret,
        endpoints: LAUNCHED_GAMES_ENDPOINTS,
      });
    }
    return existing;
  } catch {
    return null;
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
          endpoints: LAUNCHED_GAMES_ENDPOINTS,
        });
      }
      // First time this device runs the mother server, open the firewall so
      // satellites can reach it (one-time UAC). Fire-and-forget; only escalates
      // if `existing` was null (we actually started a server) is not required -
      // the helper self-gates on a persisted flag, so a re-mount pickup no-ops.
      void ensureFirewallRuleOnce();
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
