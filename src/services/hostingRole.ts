// Who hosts the games on the network, decided from each device's ROLE.
//
// The rules (see services/deviceRole.ts for the roles):
//  1. The device set as the mother starts hosting by itself. Nobody else does.
//  2. A substitute (a device hosting in the mother's absence) hands back as
//     soon as the mother is on the network again: it stops serving and pushes
//     everything it hosted (services/motherStateReconcile.ts). No question.
//  3. The one exception: the mother returns while a game is still RUNNING on
//     the substitute. The operator chooses - take the game back now, or let it
//     finish there. The mother then takes over by itself once the game is over
//     or the substitute disappears.
//  4. Two devices set as mother (the role was moved to another PC): the later
//     designation keeps it; the other gives the role up and becomes a satellite.
//     With no date on either side (devices set before dates existed), the
//     operator is asked once which one to keep.
//
// This replaces three older mechanisms that decided on presence or boot order:
// the "willing mother" auto-start, the stand-down re-check, and the reclaim
// tick that re-promoted any flagged device after a minute without a mother.

import { invoke } from '@tauri-apps/api/core';
import {
  discoverOtherMothers,
  probeMother,
  speaksOurLanProto,
  describeLocalRole,
  type DiscoveredMother,
} from './lanPairing';
import {
  ensureMotherServer,
  yieldToMother,
  takeoverMother,
  autoJoinSameClientMother,
  type MotherEndpoint,
  type TakeoverTarget,
} from './lanMotherBoot';
import { getHostingClaim, setConfiguredMother } from './deviceRole';
import { refreshLaunchedGamesRoute } from './childControlLink';
import { reconcileSupersededGamesTick } from './motherStateReconcile';
import { peerContentTick } from './peerContent';
import { installerPrefetchTick } from './updateService';
import { relaunchToApply } from './appRelaunch';
import { isAndroid } from '../utils/platform';

/** What the device set as the mother is waiting on, or a satellite is missing. */
export type HostingNotice =
  | { kind: 'none' }
  /** Mother only: a substitute is still running a game (rule 3). */
  | { kind: 'substitute_busy'; substitute: MotherEndpoint }
  /** Mother only: another device is set as mother too, and nothing orders them (rule 4). */
  | { kind: 'two_mothers'; other: MotherEndpoint }
  /** Not the mother, not hosting, and no mother on the network. */
  | { kind: 'no_mother' };

type Listener = (n: HostingNotice) => void;
const listeners = new Set<Listener>();
let notice: HostingNotice = { kind: 'none' };

/** Subscribe to the hosting notice. Fires immediately with the current one. */
export function onHostingNotice(l: Listener): () => void {
  listeners.add(l);
  l(notice);
  return () => {
    listeners.delete(l);
  };
}

function sameNotice(a: HostingNotice, b: HostingNotice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'substitute_busy' && b.kind === 'substitute_busy') {
    return a.substitute.mother_uuid === b.substitute.mother_uuid && a.substitute.label === b.substitute.label;
  }
  if (a.kind === 'two_mothers' && b.kind === 'two_mothers') {
    return a.other.mother_uuid === b.other.mother_uuid;
  }
  return true;
}

function setNotice(next: HostingNotice): void {
  if (sameNotice(notice, next)) return;
  notice = next;
  for (const l of listeners) {
    try {
      l(next);
    } catch (e) {
      console.error('[hostingRole] listener threw:', e);
    }
  }
}

/** Same-client mothers this build can talk to, other than this device. null = the browse failed. */
async function browse(clientId: number): Promise<DiscoveredMother[] | null> {
  const mothers = await discoverOtherMothers().catch(() => null);
  if (mothers === null) return null;
  return mothers.filter(
    (m) =>
      m.port > 0 &&
      m.addresses.length > 0 &&
      speaksOurLanProto(m) &&
      (m.client_id == null || m.client_id === clientId),
  );
}

/** A discovered mother that answers its hello, as an endpoint - plus what the hello said. */
async function reach(m: DiscoveredMother): Promise<{ endpoint: MotherEndpoint; runningGames: number } | null> {
  const probe = await probeMother(m.addresses, m.port).catch(() => null);
  if (!probe?.ok || !probe.reached_addr) return null;
  const sep = probe.reached_addr.lastIndexOf(':');
  return {
    endpoint: {
      addr: probe.reached_addr.slice(0, sep),
      port: Number(probe.reached_addr.slice(sep + 1)) || m.port,
      mother_uuid: m.mother_uuid,
      label: probe.label ?? m.label,
    },
    runningGames: probe.running_games ?? 0,
  };
}

async function selfUuid(): Promise<string> {
  const id = await invoke<{ device_uuid: string }>('client_get_device_identity').catch(() => null);
  return id?.device_uuid ?? '';
}

// A substitute that vanished from one browse may only have missed it: the
// mother waits for a second empty one before taking the hosting back.
let busySubstituteMisses = 0;
// Satellite: consecutive ticks (20 s apart, the first one at boot) with no
// route to any mother.
let noMotherTicks = 0;
const NO_MOTHER_TICKS = 4;
let inFlight = false;

/**
 * One pass of the rules above. Called at boot and on the App tick. `full` is
 * false on the fast ticks that follow a promotion: only a serving device acts
 * on those.
 */
export async function hostingRoleTick(clientId: number, label: string | undefined, full: boolean): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const [role, claim] = await Promise.all([describeLocalRole().catch(() => null), getHostingClaim()]);
    if (!role) return;
    if (role.mother_server_running) {
      await servingTick(clientId, claim.configured, claim.designatedAt ?? 0);
      // Keep the newest app installers for the satellites (offline updates).
      void installerPrefetchTick();
      return;
    }
    if (!full) return;
    await reconcileSupersededGamesTick();
    // LAN content sync fallback (the ping-driven pull is the main path).
    void peerContentTick();
    if (claim.configured) await motherNotServingTick(clientId, label, claim.designatedAt ?? 0);
    else await satelliteTick();
  } catch (e) {
    console.warn('[hostingRole] tick failed:', e);
  } finally {
    inFlight = false;
  }
}

/** This device is set as the mother and is not serving: should it start? */
async function motherNotServingTick(clientId: number, label: string | undefined, mySince: number): Promise<void> {
  noMotherTicks = 0;
  // A failed browse is no evidence either way. Start anyway: the Rust fence
  // browses again, and the mother is the one device allowed to start blind.
  const others = (await browse(clientId)) ?? [];

  const mothers = others.filter((m) => m.role === 'm');
  const later = mothers.find((m) => (m.since ?? 0) > mySince);
  if (later) {
    // Rule 4: the role was given to another PC after this one. Give it up.
    console.warn('[hostingRole] another device was set as the mother after this one - becoming a satellite.');
    await setConfiguredMother(false);
    setNotice({ kind: 'none' });
    await autoJoinSameClientMother(clientId).catch(() => false);
    await refreshLaunchedGamesRoute().catch(() => {});
    return;
  }
  const tie = mothers.find((m) => (m.since ?? 0) === mySince);

  // A build without roles: the old rule, first one up keeps hosting.
  if (!tie && others.some((m) => m.role == null)) {
    setNotice({ kind: 'none' });
    await autoJoinSameClientMother(clientId).catch(() => false);
    return;
  }

  if (!tie) {
    // Rule 3: only substitutes are up. One of them still running a game?
    for (const s of others.filter((m) => m.role === 's')) {
      const hit = await reach(s);
      if (hit && hit.runningGames > 0) {
        busySubstituteMisses = 0;
        setNotice({ kind: 'substitute_busy', substitute: hit.endpoint });
        await autoJoinSameClientMother(clientId).catch(() => false);
        return;
      }
    }
    if (notice.kind === 'substitute_busy' && others.length === 0 && busySubstituteMisses < 1) {
      busySubstituteMisses += 1;
      return;
    }
    busySubstituteMisses = 0;
  }

  // Rules 1 and 2: host. Against a tie the Rust fence lets exactly one of the
  // two start, so the venue has a mother while the operator answers.
  const info = await ensureMotherServer(clientId, label);
  if (tie) {
    const hit = await reach(tie);
    setNotice({
      kind: 'two_mothers',
      other: hit?.endpoint ?? { addr: tie.addresses[0], port: tie.port, mother_uuid: tie.mother_uuid, label: tie.label },
    });
  } else {
    setNotice({ kind: 'none' });
  }
  if (!info) await autoJoinSameClientMother(clientId).catch(() => false);
  await refreshLaunchedGamesRoute().catch(() => {});
}

/** This device is hosting: must it hand over? */
async function servingTick(clientId: number, configured: boolean, mySince: number): Promise<void> {
  noMotherTicks = 0;
  const others = (await browse(clientId)) ?? [];
  const mothers = others.filter((m) => m.role === 'm');

  if (!configured) {
    setNotice({ kind: 'none' });
    // Rule 2: a substitute hands back to the mother as soon as it answers.
    for (const m of mothers) {
      const hit = await reach(m);
      if (!hit) continue;
      console.warn('[hostingRole] the mother is back - handing the hosting over.');
      await yieldToMother(hit.endpoint);
      await refreshLaunchedGamesRoute().catch(() => {});
      return;
    }
  } else {
    // Rule 4, while both are up.
    const me = await selfUuid();
    for (const m of mothers) {
      const theirs = m.since ?? 0;
      const superseded = theirs > mySince;
      const lostTie = theirs === mySince && m.mother_uuid < me;
      if (!superseded && !lostTie) {
        if (theirs === mySince) {
          const hit = await reach(m);
          if (hit) setNotice({ kind: 'two_mothers', other: hit.endpoint });
        }
        continue;
      }
      const hit = await reach(m);
      if (!hit) continue;
      if (superseded) {
        console.warn('[hostingRole] another device was set as the mother after this one - handing over.');
        await setConfiguredMother(false);
        setNotice({ kind: 'none' });
      } else {
        // Undecided: one of the two must stop meanwhile, and both agree which.
        setNotice({ kind: 'two_mothers', other: hit.endpoint });
      }
      await yieldToMother(hit.endpoint);
      await refreshLaunchedGamesRoute().catch(() => {});
      return;
    }
    if (!mothers.some((m) => (m.since ?? 0) === mySince)) setNotice({ kind: 'none' });
  }

  // Superseded on the game itself: another device took it over at a higher
  // epoch (two substitutes promoted in the same second, or a substitute that
  // took the game while this mother was cut off). Nobody else on the network:
  // nothing to yield to, and no second browse to pay for.
  if (others.length === 0) return;
  const target = await invoke<TakeoverTarget | null>('get_takeover_target', { clientId }).catch(() => null);
  if (!target) return;
  if (configured) {
    // The mother only steps aside for a game that is really running there
    // (rule 3 then asks the operator); an idle substitute yields to IT.
    const live = others.find((m) => m.mother_uuid === target.mother_uuid);
    const hit = live ? await reach(live) : null;
    if (!hit || hit.runningGames === 0) return;
  }
  console.warn('[hostingRole] superseded by a higher-epoch mother - yielding.');
  await yieldToMother(target);
  // Converge routing immediately instead of waiting for the 15s tick: we just
  // dropped our own local route.
  await refreshLaunchedGamesRoute().catch(() => {});
}

/** Not the mother and not hosting: only notice a network with no mother at all. */
async function satelliteTick(): Promise<void> {
  if (notice.kind === 'substitute_busy' || notice.kind === 'two_mothers') setNotice({ kind: 'none' });
  const link = await invoke<{ base_url: string } | null>('client_resolve_mother_link').catch(() => null);
  if (link?.base_url) {
    noMotherTicks = 0;
    if (notice.kind === 'no_mother') setNotice({ kind: 'none' });
    return;
  }
  noMotherTicks += 1;
  // A minute without any mother before saying so. On an ordinary morning the
  // satellites are often switched on before the mother: the notice (and its
  // "host here" button) must not greet the operator while the mother boots.
  if (noMotherTicks >= NO_MOTHER_TICKS) setNotice({ kind: 'no_mother' });
}

/** A tablet never hosts (Android is operator-only): it gets no "host here" button. */
export function canHostAsSubstitute(): boolean {
  return !isAndroid();
}

/**
 * Rule 3, "Reprendre maintenant": the mother takes the running game back from
 * the substitute. It pulls the game's current state first, so nothing played
 * on the substitute is lost; the substitute then hands over on its next tick.
 */
export async function takeBackNow(clientId: number): Promise<void> {
  const target = await invoke<TakeoverTarget | null>('get_takeover_target', { clientId }).catch(() => null);
  if (target) {
    await takeoverMother(target);
  } else {
    // Nothing to take over by epoch (the game ended meanwhile, or the
    // substitute left): simply host.
    const info = await ensureMotherServer(clientId);
    if (!info) throw new Error('failover:errTakeControl');
  }
  setNotice({ kind: 'none' });
  await refreshLaunchedGamesRoute().catch(() => {});
}

/**
 * Rule 4, the operator's answer when two devices are set as mother. Keeping
 * this one re-designates it now, which makes it the later of the two; the other
 * then gives the role up by itself. Either way the app restarts to apply.
 */
export async function resolveTwoMothers(keepThisDevice: boolean): Promise<void> {
  await setConfiguredMother(keepThisDevice);
  await relaunchToApply(1200);
}
