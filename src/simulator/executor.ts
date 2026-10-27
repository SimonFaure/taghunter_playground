// Game simulator executor - runs in the MAIN window, next to the live game
// page, because the card reads and the game clock live in that JS context.
// The control window only sends commands (sim://cmd) and renders status /
// journal events. Tester builds only (installed from main.tsx).

import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { gameClock } from '../services/gameClock';
import { sportidentService } from '../services/sportidentService';
import {
  getLaunchedGameMeta,
  listPairedWithStatus,
  patchLaunchedGameMeta,
  queueJoinGameCommandBulk,
  queueSimControl,
} from '../services/launchedGames';
import type { SimClockState } from '../services/gameClock';
import { getActiveLaunchedGameId } from '../services/activeGameStore';
import { registerLanCommandHandler } from '../services/lanCommands';
import { clearSimBus, simBusEmit } from '../services/simBus';
import { fromMotherClock, motherNow, refreshMotherOffset, toMotherClock } from '../services/motherTime';
import { parseRegAssignments, REG_ASSIGNMENTS_META_KEY, type RegAssignmentMap } from '../services/regAssignments';
import { buildPlan } from './planner';
import { between, makeRng } from './profiles';
import {
  EVT_SIM_CLOCK,
  EVT_SIM_CMD,
  EVT_SIM_FIELD,
  type FieldRow,
  EVT_SIM_JOURNAL,
  EVT_SIM_STATUS,
  type JournalEntry,
  type SimCommand,
  type SimConfig,
  type SimPlan,
  type SimRead,
  type SimRunShare,
  type SimStatus,
  type SimRemoteStatus,
  DEFAULT_PROFILE_MIX,
  MIRROR_JOURNAL_TAIL,
  simJournalKey,
  simStatusKey,
} from './types';

/** How long Start waits for the game page to open and bind its card handler. */
const PAGE_OPEN_TIMEOUT_MS = 45_000;
/** How often a run checks that the game page is still open. */
const PAGE_WATCH_MS = 400;

/** How long a director waits for the other launched devices to open the game. */
const PARTICIPANTS_TIMEOUT_MS = 60_000;

/** How long a director holds "presses Start" for the followers' registration bips. */
const FOLLOWER_REGISTRATION_TIMEOUT_MS = 180_000;

/** Human handling time at the reader (approach, bip, watch, step away), virtual seconds. */
const HANDLING_GAP_SEC: [number, number] = [4, 10];

let status: SimStatus = {
  phase: 'idle',
  launchedGameId: null,
  done: 0,
  total: 0,
  queued: 0,
  clock: null,
  warnings: [],
  pageListening: false,
};
let runId = 0;
const journal: JournalEntry[] = [];

// ── field view: every mock team's live state, derived from the plan ──
let currentPlan: SimPlan | null = null;
/** This device's id in the current run (reads of other devices are theirs). */
let currentMe: number | null = null;
/** plan.reads indices already processed (injected, or journal-only). */
const processed = new Set<number>();
/** Last simulated bip, for the "SIM bip" flash on the game page. */
let lastBip: { team: string; intent: string; realAt: number } | null = null;

const shortIntent = (intent: string) => intent.split(' - ')[0];

export function getFieldSnapshot(): FieldRow[] {
  const plan = currentPlan;
  if (!plan) return [];
  const now = gameClock.now();
  const byKey = new Map<string, number[]>();
  plan.reads.forEach((r, i) => {
    if (r.skip) return;
    const list = byKey.get(r.key) ?? [];
    list.push(i);
    byKey.set(r.key, list);
  });
  return plan.tracks.map((t) => {
    const idx = byKey.get(t.key) ?? [];
    // Another device's reads: assumed bipped once due (that device plays them).
    const isDone = (i: number) =>
      processed.has(i) ||
      (currentMe !== null && plan.reads[i].device !== undefined && plan.reads[i].device !== currentMe && plan.reads[i].at <= now);
    const pending = idx.filter((i) => !isDone(i));
    const done = idx.filter((i) => isDone(i));
    const next = pending.length ? plan.reads[pending[0]] : null;
    const last = done.length ? plan.reads[done[done.length - 1]] : null;
    let lastAct: { at: number; label: string } | undefined;
    for (const a of t.activities) if (a.at <= now) lastAct = a;

    let state: FieldRow['state'];
    let action: string;
    if (next && next.at <= now) {
      state = 'reader';
      action = `at the reader: ${shortIntent(next.intent)}`;
    } else if (t.abandonAt !== undefined && now >= t.abandonAt) {
      state = 'abandoned';
      action = 'gave up, never came back';
    } else if (!lastAct) {
      state = 'not_arrived';
      action = 'not arrived yet';
    } else if (!next && last) {
      state = 'done';
      action = 'finished';
    } else {
      state = 'field';
      action = lastAct.label;
    }
    return {
      key: t.key,
      team: t.team,
      profile: t.profile,
      players: t.players,
      state,
      action,
      nextBipAt: next ? next.at : null,
      nextBipIntent: next ? shortIntent(next.intent) : undefined,
      lastBipAt: last ? last.at : undefined,
      lastBipIntent: last ? shortIntent(last.intent) : undefined,
    };
  });
}

/** Clash: the planned Purge attempt of the current run (virtual epoch ms). */
export function getPlannedPurgeAt(): number | undefined {
  return currentPlan?.purgeAt;
}

export function getLastBip() {
  return lastBip;
}

// Remote control: status + journal tail are mirrored into the launched game's
// meta (`sim_status:<deviceId>`, atomic per-key patch on the mother) so a
// controller on another device - e.g. an Android tablet - can poll them.
let mirror: { gid: number; deviceId: number } | null = null;
let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
let mirrorLastAt = 0;
const MIRROR_EVERY_MS = 1500;

function mirrorNow() {
  mirrorTimer = null;
  mirrorLastAt = Date.now();
  if (!mirror) return;
  const value: SimRemoteStatus = {
    status: { ...status, clock: status.clock ? toShared(status.clock) : null },
    journal: journal.slice(-MIRROR_JOURNAL_TAIL),
    field: getFieldSnapshot(),
    // Mother time, like the clock: compared on other devices.
    updatedAt: motherNow(),
  };
  void patchLaunchedGameMeta(mirror.gid, { [simStatusKey(mirror.deviceId)]: JSON.stringify(value) }).catch((err) =>
    console.warn('[sim] status mirror failed', err),
  );
}

function scheduleMirror(urgent: boolean) {
  if (!mirror || mirrorTimer) return;
  const wait = urgent ? 0 : Math.max(0, MIRROR_EVERY_MS - (Date.now() - mirrorLastAt));
  mirrorTimer = setTimeout(mirrorNow, wait);
}

/** Which device am I, for the meta key (local runs started from this device). */
async function resolveMirror(gid: number) {
  if (mirror?.gid === gid) return;
  try {
    const r = await listPairedWithStatus(gid);
    const id = r.caller_device_id ?? r.in_game.find((d) => d.is_self)?.id;
    if (id != null) mirror = { gid, deviceId: id };
  } catch (err) {
    console.warn('[sim] could not resolve own device id', err);
  }
}

function publish(patch: Partial<SimStatus>) {
  const phaseChanged = patch.phase !== undefined && patch.phase !== status.phase;
  status = { ...status, ...patch, clock: gameClock.getSim() };
  void emit(EVT_SIM_STATUS, status);
  statusListeners.forEach((l) => l(status));
  scheduleMirror(phaseChanged);
}

function publishClock() {
  void emit(EVT_SIM_CLOCK, gameClock.getSim());
  publish({});
}

// A clock that leaves this device (followers, meta `sim_clock` read by the
// mother's Rust, the status mirror) carries its real-time fields in MOTHER
// time, so PCs whose clocks disagree still share one instant. This device's
// gameClock stays local.
const toShared = (c: SimClockState) => toMotherClock(c);
const fromShared = (c: SimClockState) => fromMotherClock(c);

/** Wait until virtual time `at`, following pause/speed changes. False if superseded. */
async function waitUntil(at: number, myRun: number): Promise<boolean> {
  for (;;) {
    if (myRun !== runId) return false;
    const d = gameClock.realDelayUntil(at);
    if (d <= 0) return true;
    await new Promise((r) => setTimeout(r, Math.min(d, 250)));
  }
}

/** The game page for `gid` is open on this device and its card handler is bound. */
function pageListening(gid: number): boolean {
  return getActiveLaunchedGameId() === gid && sportidentService.hasCardCallback();
}

/**
 * Bips only count while the game page is open (it owns the card handler), so
 * Start opens it: a join_game aimed at this device. On the mother the server
 * dispatches it in-process; on a satellite it comes back through the mother's
 * queue with the mother route attached - the same path as the Devices modal's
 * "Reconnect". Resolves false on timeout or when superseded.
 */
async function ensurePageOpen(gid: number, myRun: number): Promise<boolean> {
  if (pageListening(gid)) return true;
  publish({ phase: 'opening', launchedGameId: gid, pageListening: false, message: 'Opening the game page…' });
  let pushed = false;
  if (mirror?.gid === gid) {
    try {
      const res = await queueJoinGameCommandBulk([mirror.deviceId], gid, { rejoin: true });
      pushed = res.results.some((r) => !r.error);
    } catch (err) {
      console.warn('[sim] could not open the game page', err);
    }
  }
  if (!pushed) {
    // Own device id unknown (or the push was refused): dispatch the same
    // in-process event the server uses for a self-targeted join. Right when
    // the game lives here (mother / standalone), which is the common case.
    void emit('taghunter://lan-command', {
      id: 0,
      kind: 'join_game',
      payload: { launched_game_id: gid, rejoin: true },
      local: true,
    });
  }
  const deadline = Date.now() + PAGE_OPEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (myRun !== runId) return false;
    if (pageListening(gid)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * While a run is live: pause the virtual clock as soon as the game page is
 * left (bips would go nowhere) and resume when it's back - unless the operator
 * paused by hand in between.
 */
let lastFieldEmit = 0;

function watchPage(gid: number, myRun: number) {
  const id = setInterval(() => {
    if (myRun !== runId || status.phase === 'done' || status.phase === 'stopped' || status.phase === 'error') {
      clearInterval(id);
      return;
    }
    const listening = pageListening(gid);
    if (listening !== status.pageListening) publish({ pageListening: listening });
    // The field moves with the clock even between bips: refresh the remote
    // mirror (throttled) and the pop-out window.
    scheduleMirror(false);
    if (Date.now() - lastFieldEmit >= 1000) {
      lastFieldEmit = Date.now();
      void emit(EVT_SIM_FIELD, getFieldSnapshot());
    }
    if (status.role === 'director' || status.role === 'follower') {
      // Shared clock: never pause it for one device; its reads just wait.
      const msg = listening ? undefined : 'Game page closed: this device holds its bips until it is open again.';
      if (msg !== status.message) publish({ message: msg });
      return;
    }
    if (!listening && status.phase === 'running') {
      gameClock.adjust({ paused: true });
      publishClock();
      publish({ phase: 'paused', pausedByPage: true, message: 'Game page closed: paused until it is open again.' });
    } else if (listening && status.phase === 'paused' && status.pausedByPage) {
      gameClock.adjust({ paused: false });
      publishClock();
      publish({ phase: 'running', pausedByPage: false, message: undefined });
    }
  }, PAGE_WATCH_MS);
}

/** Participants of a multi-device run: devices in the game that can play. */
async function resolveParticipants(gid: number): Promise<number[]> {
  try {
    const r = await listPairedWithStatus(gid);
    return r.in_game.filter((d) => d.online && !d.operator_only).map((d) => d.id);
  } catch {
    return [];
  }
}

/**
 * Director: plan the whole session, split the teams over the devices of the
 * game (every read of one team stays on one device - its "home" reader), send
 * each follower its share + the shared clock, then play its own share.
 */
async function run(cfg: SimConfig) {
  const myRun = ++runId;
  journal.length = 0;
  await resolveMirror(cfg.launchedGameId);
  if (!(await ensurePageOpen(cfg.launchedGameId, myRun))) {
    if (myRun === runId) {
      publish({
        phase: 'error',
        message: 'The game page did not open on this device: open it, then press Start again.',
      });
    }
    return;
  }
  // A replay continues from the current simulated time: game timestamps must
  // never run backwards within a game (teams of the previous run ended "later"
  // than real now).
  const virtualStart = gameClock.isSimulated() ? gameClock.now() : Date.now();
  let plan: SimPlan;
  try {
    plan = await buildPlan(cfg, virtualStart);
  } catch (err) {
    publish({ phase: 'error', message: `Planning failed: ${String(err)}` });
    return;
  }

  const me = mirror?.gid === cfg.launchedGameId ? mirror.deviceId : null;
  let devices: number[] = me !== null ? [me] : [];
  if (cfg.spreadAcrossDevices !== false && me !== null) {
    // The other launched devices open the game through their join_game push,
    // a few seconds after this one: deal the teams only once they are in it.
    const expected = Math.max(1, cfg.expectedDevices ?? 1);
    let others = (await resolveParticipants(cfg.launchedGameId)).filter((d) => d !== me);
    const deadline = Date.now() + PARTICIPANTS_TIMEOUT_MS;
    while (others.length + 1 < expected && Date.now() < deadline) {
      if (myRun !== runId) return;
      publish({
        phase: 'opening',
        launchedGameId: cfg.launchedGameId,
        message: `Waiting for the other devices to open the game (${others.length + 1}/${expected})…`,
      });
      await new Promise((r) => setTimeout(r, 1500));
      others = (await resolveParticipants(cfg.launchedGameId)).filter((d) => d !== me);
    }
    if (others.length + 1 < expected) {
      plan.warnings.push(
        `Only ${others.length + 1} of the ${expected} launched devices opened the game within ${PARTICIPANTS_TIMEOUT_MS / 1000} s: the teams play on those.`,
      );
    }
    devices = [me, ...others];
  }
  // Home device per team, round-robin in team order. Quest / Clash
  // self-registration: a device locked to some teams (meta regAssignments)
  // only offers those on its registration screen, so each team registers on a
  // device that offers it (else an unlocked one).
  let regMap: RegAssignmentMap = {};
  if (plan.teamNumbers && devices.length > 1) {
    try {
      regMap = parseRegAssignments((await getLaunchedGameMeta(cfg.launchedGameId))[REG_ASSIGNMENTS_META_KEY]);
    } catch {
      regMap = {};
    }
  }
  const locks = Object.keys(regMap).length > 0;
  const unlocked = devices.filter((d) => !regMap[d]?.length);
  let rr = 0;
  let rrUnlocked = 0;
  const home = new Map<string, number>();
  plan.tracks.forEach((t) => {
    if (!devices.length) return;
    const num = plan.teamNumbers?.[t.key];
    if (locks && num !== undefined) {
      const offering = devices.find((d) => regMap[d]?.includes(num));
      if (offering !== undefined) return void home.set(t.key, offering);
      if (unlocked.length) return void home.set(t.key, unlocked[rrUnlocked++ % unlocked.length]);
      plan.warnings.push(`${t.team}: no playing device offers team ${num} on its registration screen.`);
    }
    home.set(t.key, devices[rr++ % devices.length]);
  });
  for (const r of plan.reads) {
    // On-screen steps without a team home (Start button...) belong to the director.
    r.device = home.get(r.key) ?? (me ?? undefined);
  }
  // Registration screens and the Start button live on every device in Quest /
  // Clash, but the game is started once: keep "presses Start" on the director.
  for (const r of plan.reads) {
    if (r.actions?.some((x) => x.kind === 'pressStart') && me !== null) r.device = me;
  }

  await refreshMotherOffset(true);
  const clock = { realAnchor: Date.now(), virtualAnchor: virtualStart, speed: cfg.speed, pausedAt: null };
  const multi = devices.length > 1;
  const runKey = `${cfg.launchedGameId}-${cfg.seed}-${Date.now()}`;
  if (multi) {
    for (const d of devices.slice(1)) {
      const share: SimRunShare = {
        runKey,
        launchedGameId: cfg.launchedGameId,
        directorId: me!,
        seed: cfg.seed,
        devices: devices.length,
        clock: toShared(clock),
        plan: {
          ...plan,
          // Only the follower's own cards travel; the rest is timing for its field view.
          reads: plan.reads.map((r) => (r.device === d ? r : { ...r, card: { ...r.card, punches: [] } })),
        },
      };
      try {
        const res = await queueSimControl(d, cfg.launchedGameId, { kind: 'joinRun', run: share });
        const failed = res.results.find((x) => x.error);
        if (failed) plan.warnings.push(`Device #${d} refused its share: ${failed.error}`);
      } catch (err) {
        plan.warnings.push(`Device #${d} unreachable: ${String(err)}`);
      }
    }
  }
  await execute({
    myRun,
    gid: cfg.launchedGameId,
    plan,
    clock,
    me,
    role: multi ? 'director' : 'solo',
    runKey,
    devices: devices.length || 1,
    seed: cfg.seed,
    speed: cfg.speed,
  });
}

/** Follower: play this device's share of a director's run. */
async function joinRun(share: SimRunShare) {
  if (status.phase === 'running' || status.phase === 'paused' || status.phase === 'opening') await stopLocal();
  const myRun = ++runId;
  journal.length = 0;
  await resolveMirror(share.launchedGameId);
  if (!(await ensurePageOpen(share.launchedGameId, myRun))) {
    if (myRun === runId) {
      publish({ phase: 'error', message: 'The game page did not open on this device for the shared run.' });
    }
    return;
  }
  await refreshMotherOffset(true);
  await execute({
    myRun,
    gid: share.launchedGameId,
    plan: share.plan,
    clock: fromShared(share.clock),
    me: mirror?.gid === share.launchedGameId ? mirror.deviceId : null,
    role: 'follower',
    runKey: share.runKey,
    devices: share.devices,
    seed: share.seed,
    speed: share.clock.speed,
  });
}

let currentRun: { runKey: string; role: 'solo' | 'director' | 'follower'; gid: number; followers: number[] } | null = null;

/** Shared play loop: this device's reads of the plan, on the run's clock. */
async function execute(x: {
  myRun: number;
  gid: number;
  plan: SimPlan;
  clock: SimClockState;
  me: number | null;
  role: 'solo' | 'director' | 'follower';
  runKey: string;
  devices: number;
  seed: number;
  speed: number;
}) {
  const { myRun, gid, plan, me, role } = x;
  const mine = (r: SimRead) => r.device === undefined || me === null || r.device === me;
  currentPlan = plan;
  currentMe = me;
  processed.clear();
  clearSimBus();
  lastBip = null;
  currentRun = {
    runKey: x.runKey,
    role,
    gid,
    followers: role === 'director' ? Array.from(new Set(plan.reads.map((r) => r.device).filter((d): d is number => d !== undefined && d !== me))) : [],
  };
  gameClock.setSim(x.clock);
  await sportidentService.setSimulatedReads(true);
  publishClock();
  if (role !== 'follower') void shareClock(gid, x.clock);
  const myReads = plan.reads.filter(mine);
  publish({
    phase: 'running',
    launchedGameId: gid,
    done: 0,
    total: myReads.length,
    nextAt: null,
    holding: false,
    queued: 0,
    warnings: plan.warnings,
    message: undefined,
    pageListening: true,
    pausedByPage: false,
    seed: x.seed,
    teams: plan.tracks.length,
    errors: 0,
    runKey: x.runKey,
    role,
    devices: x.devices,
  });
  watchPage(gid, myRun);

  // One reader per device: a card at a time, with a human gap between reads.
  const gapRng = makeRng(x.seed ^ 0x5eed ^ (me ?? 0));
  let readerFreeAt = 0;
  let done = 0;
  for (let i = 0; i < plan.reads.length; i++) {
    const read = plan.reads[i];
    if (!mine(read)) continue;
    const at = read.skip ? read.at : Math.max(read.at, read.noGap ? 0 : readerFreeAt);
    if (status.nextAt !== at) publish({ nextAt: at });
    if (!(await waitUntil(at, myRun))) return;
    if (role === 'director' && read.actions?.some((a) => a.kind === 'pressStart')) {
      if (!(await waitFollowersBefore(gid, plan, i, x.runKey, myRun))) return;
    }
    const queued = plan.reads.slice(i + 1).filter((r) => mine(r) && !r.skip && r.at <= gameClock.now()).length;

    const entry: JournalEntry = {
      at: gameClock.now(),
      team: read.team,
      profile: read.profile,
      intent: read.intent,
      cardId: read.card.cardId,
      punches: read.card.punches.length,
      ok: true,
      ...(read.expect ? { expect: read.expect } : {}),
    };
    if (read.actions?.length) {
      if (!(await holdUntilPageOpen(gid, myRun))) return;
      for (const a of read.actions) simBusEmit(a);
      // Let the screen react (team selected, overlay armed) before the bip.
      if (!read.skip) await new Promise((r) => setTimeout(r, 300));
    }
    if (!read.skip) {
      // Never fire into a closed page: hold the read until it's open again.
      if (!(await holdUntilPageOpen(gid, myRun))) return;
      try {
        await invoke('si_simulate_card', { card: read.card });
      } catch (err) {
        entry.ok = false;
        entry.error = String(err);
        status.errors = (status.errors ?? 0) + 1;
      }
      readerFreeAt = gameClock.now() + between(gapRng, HANDLING_GAP_SEC[0], HANDLING_GAP_SEC[1]) * 1000;
    }
    processed.add(i);
    if (!read.skip) lastBip = { team: read.team, intent: shortIntent(read.intent), realAt: Date.now() };
    journal.push(entry);
    void emit(EVT_SIM_JOURNAL, entry);
    publish({ done: ++done, queued });
  }
  // Keep the virtual clock running so the operator can end the game in
  // simulated time; "Stop" returns the device to real time.
  publish({ phase: 'done', queued: 0, nextAt: null });
  mirrorJournal();
}

/**
 * Director, before "presses Start": each follower must have played every read
 * planned before it (its players' registration bips). A follower runs late
 * (handling gaps, page round-trips), and a player whose bip lands after Start
 * is refused as not registered - all its later bips are ignored.
 */
async function waitFollowersBefore(
  gid: number,
  plan: SimPlan,
  index: number,
  runKey: string,
  myRun: number,
): Promise<boolean> {
  const need = new Map<number, number>();
  for (const r of plan.reads.slice(0, index)) {
    if (r.device !== undefined && r.device !== currentMe) need.set(r.device, (need.get(r.device) ?? 0) + 1);
  }
  if (need.size === 0) return true;
  const behind = (meta: Record<string, string>) =>
    [...need].filter(([d, n]) => {
      try {
        const s = JSON.parse(meta[simStatusKey(d)] ?? '') as SimRemoteStatus;
        return s.status.runKey !== runKey || s.status.done < n;
      } catch {
        return true;
      }
    });
  const deadline = Date.now() + FOLLOWER_REGISTRATION_TIMEOUT_MS;
  let late: Array<[number, number]> = [...need];
  while (Date.now() < deadline) {
    if (myRun !== runId) return false;
    try {
      late = behind(await getLaunchedGameMeta(gid));
    } catch {
      /* retry */
    }
    if (late.length === 0) {
      if (status.message) publish({ message: undefined });
      return true;
    }
    publish({ message: `Waiting for ${late.length} other device(s) to finish registering before Start…` });
    await new Promise((r) => setTimeout(r, 1000));
  }
  plan.warnings.push(
    `Start pressed before device(s) ${late.map(([d]) => `#${d}`).join(', ')} finished registering: their late players are not registered.`,
  );
  publish({ message: undefined, warnings: plan.warnings });
  return true;
}

/** Hold a due read while the game page is closed (it would go nowhere).
 *  Flagged as `holding` so a campaign can tell it from a read still to come. */
async function holdUntilPageOpen(gid: number, myRun: number): Promise<boolean> {
  if (pageListening(gid)) return true;
  publish({ holding: true });
  while (!pageListening(gid)) {
    if (myRun !== runId) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  publish({ holding: false });
  return true;
}

/** The current run's plan and this device's id in it (null outside a run). */
export function getRunPlan(): { plan: SimPlan; me: number | null } | null {
  return currentPlan ? { plan: currentPlan, me: currentMe } : null;
}

/** This run's whole journal (the status mirror only carries its tail). */
export function getJournal(): JournalEntry[] {
  return journal.slice();
}

/** Shared runs: write this device's full journal to the game meta. */
function mirrorJournal() {
  const runKey = currentRun?.runKey;
  if (!mirror || !runKey || currentRun?.role === 'solo') return;
  void patchLaunchedGameMeta(mirror.gid, {
    [simJournalKey(mirror.deviceId)]: JSON.stringify({ runKey, entries: journal }),
  }).catch((err) => console.warn('[sim] journal mirror failed', err));
}

/** Stopping mid-run: journal this device's reads that never got their turn. */
function journalDropped() {
  const plan = currentPlan;
  if (!plan || (status.phase !== 'running' && status.phase !== 'paused')) return;
  plan.reads.forEach((r, i) => {
    if (processed.has(i) || (r.device !== undefined && currentMe !== null && r.device !== currentMe)) return;
    journal.push({
      at: r.at,
      team: r.team,
      profile: r.profile,
      intent: r.intent,
      cardId: r.card.cardId,
      punches: r.card.punches.length,
      ok: false,
      dropped: true,
      error: 'not played: the run was stopped first',
    });
  });
}

/**
 * Shared clock: written to the game meta (`sim_clock`) so the mother's Clash
 * scoring follows simulated time, and pushed to followers on every change.
 */
async function shareClock(gid: number, clock: SimClockState | null) {
  try {
    await patchLaunchedGameMeta(gid, { sim_clock: clock ? JSON.stringify(toShared(clock)) : null });
  } catch (err) {
    console.warn('[sim] could not share the clock', err);
  }
}

async function broadcastClock(clock: SimClockState | null) {
  const run = currentRun;
  if (!run || run.role === 'follower') return;
  await shareClock(run.gid, clock);
  for (const d of run.followers) {
    void queueSimControl(d, run.gid, {
      kind: 'runClock',
      runKey: run.runKey,
      clock: clock ? toShared(clock) : null,
    }).catch(() => {});
  }
}

/** Stop this device only (follower leaving, or before a new run). */
async function stopLocal() {
  journalDropped();
  mirrorJournal();
  runId++;
  gameClock.setSim(null);
  await sportidentService.setSimulatedReads(false);
  publishClock();
  publish({ phase: 'stopped', queued: 0, pausedByPage: false, message: undefined, nextAt: null, holding: false });
}

/** Stop: a director also stops its followers and drops the shared clock. */
async function stop() {
  const run = currentRun;
  if (run && run.role !== 'follower') await broadcastClock(null);
  await stopLocal();
  currentRun = null;
}

// ── same-window access for the game-page floating window ──
const statusListeners = new Set<(s: SimStatus) => void>();
export function getSimStatus(): SimStatus {
  return status;
}
export function subscribeSimStatus(fn: (s: SimStatus) => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}
export function simCommand(cmd: SimCommand): void {
  void handle(cmd);
}

async function handle(cmd: SimCommand) {
  switch (cmd.kind) {
    case 'start':
      if (status.phase === 'running' || status.phase === 'paused' || status.phase === 'opening') await stop();
      void run(cmd.config);
      break;
    case 'joinRun':
      void joinRun(cmd.run);
      break;
    case 'runClock':
      // From our director: follow its clock, or stop with it.
      if (!currentRun || currentRun.runKey !== cmd.runKey) break;
      if (cmd.clock === null) {
        await stopLocal();
        currentRun = null;
        break;
      }
      gameClock.setSim(fromShared(cmd.clock));
      publishClock();
      publish({ phase: cmd.clock.pausedAt !== null ? 'paused' : 'running' });
      break;
    case 'pause':
      if (currentRun?.role === 'follower') break; // the director owns the shared clock
      gameClock.adjust({ paused: true });
      publishClock();
      void broadcastClock(gameClock.getSim());
      if (status.phase === 'running') publish({ phase: 'paused', pausedByPage: false });
      break;
    case 'resume':
      // A page-closed pause can't be resumed by hand: the reads would be lost.
      if (status.pausedByPage && !pageListening(status.launchedGameId ?? -1)) break;
      if (currentRun?.role === 'follower') break;
      gameClock.adjust({ paused: false });
      publishClock();
      void broadcastClock(gameClock.getSim());
      if (status.phase === 'paused') publish({ phase: 'running', pausedByPage: false, message: undefined });
      break;
    case 'speed':
      if (currentRun?.role === 'follower') break;
      gameClock.adjust({ speed: Math.min(20, Math.max(1, cmd.speed)) });
      publishClock();
      void broadcastClock(gameClock.getSim());
      break;
    case 'stop':
      await stop();
      break;
    case 'status':
      publish({});
      scheduleMirror(true);
      for (const e of journal) void emit(EVT_SIM_JOURNAL, e);
      break;
  }
}

let installed = false;

/** A remote command older than this sat in the LAN queue too long: dropped. */
const REMOTE_CMD_MAX_AGE_MS = 120_000;

/** Main window: host the executor (local control window + LAN remote control). */
export function installSimulatorHost() {
  if (installed) return;
  installed = true;
  void refreshMotherOffset();
  installAutoStart();
  void listen<SimCommand>(EVT_SIM_CMD, (e) => void handle(e.payload));
  registerLanCommandHandler('sim_control', (cmd) => {
    const p = (cmd.payload ?? {}) as {
      launched_game_id?: number;
      device_id?: number;
      sent_at?: number;
      cmd?: SimCommand;
    };
    if (!p.cmd || typeof p.launched_game_id !== 'number') return { ok: false, error: 'bad_payload' };
    if (typeof p.sent_at === 'number' && motherNow() - p.sent_at > REMOTE_CMD_MAX_AGE_MS) {
      console.warn('[sim] dropped a stale remote command', p.cmd.kind);
      return { ok: false, error: 'stale' };
    }
    if (typeof p.device_id === 'number') mirror = { gid: p.launched_game_id, deviceId: p.device_id };
    void handle(p.cmd);
  });
}

/**
 * The simulation settings chosen at launch (meta `simAutoStart`, written by
 * GameList when "Simulated session" is ticked), else defaults with a fresh
 * seed. Used by the auto-start and by the game page's Start button.
 */
export function simConfigFromMeta(launchedGameId: number, meta: Record<string, string>): SimConfig {
  let spec: Partial<SimConfig> = {};
  try {
    spec = meta.simAutoStart ? (JSON.parse(meta.simAutoStart) as Partial<SimConfig>) : {};
  } catch {
    spec = {};
  }
  return {
    launchedGameId,
    seed: typeof spec.seed === 'number' ? spec.seed : Math.floor(Math.random() * 1_000_000),
    speed: typeof spec.speed === 'number' ? spec.speed : 10,
    profileMix: spec.profileMix ?? DEFAULT_PROFILE_MIX,
    dynamicTeamCount: typeof spec.dynamicTeamCount === 'number' ? spec.dynamicTeamCount : 10,
    arrivalWindowMin: typeof spec.arrivalWindowMin === 'number' ? spec.arrivalWindowMin : 10,
    spreadAcrossDevices: spec.spreadAcrossDevices !== false,
    expectedDevices: Number(meta.simDevices) || undefined,
    clashPurgeAtMin: typeof spec.clashPurgeAtMin === 'number' ? spec.clashPurgeAtMin : undefined,
  };
}

// ── auto-start: a Simulated session launched with "start when the game
// opens" begins as soon as its game page is open on the host device ──
const autoStarted = new Set<number>();
let lastActiveGid: number | null = null;

async function maybeAutoStart(gid: number) {
  if (autoStarted.has(gid)) return;
  if (status.phase === 'running' || status.phase === 'paused' || status.phase === 'opening') return;
  if (currentRun) return;
  let meta: Record<string, string>;
  try {
    meta = await getLaunchedGameMeta(gid);
  } catch {
    return;
  }
  if (meta.simulated !== 'true' || !meta.simAutoStart) return;
  await resolveMirror(gid);
  // Host only: the launcher when it plays, else the first device the game was
  // pushed to. Unknown own id: start only when no host was recorded.
  if (meta.simHost && (!mirror || mirror.gid !== gid || String(mirror.deviceId) !== meta.simHost)) return;
  // Already started once (on this or a previous app session): never twice.
  if (mirror && meta[simStatusKey(mirror.deviceId)]) return;
  autoStarted.add(gid);
  void handle({ kind: 'start', config: simConfigFromMeta(gid, meta) });
}

function installAutoStart() {
  setInterval(() => {
    const gid = getActiveLaunchedGameId();
    if (gid === lastActiveGid) return;
    lastActiveGid = gid;
    if (gid !== null) void maybeAutoStart(gid);
  }, 1000);
}

/** Every window: follow the simulated clock (leaderboards, projector...). */
export function installSimClockFollower() {
  void listen<ReturnType<typeof gameClock.getSim>>(EVT_SIM_CLOCK, (e) => gameClock.setSim(e.payload));
}
