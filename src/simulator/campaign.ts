// Simulation campaigns (tester builds only, main window): a series of
// simulated sessions played one after the other, each launched through the
// real Launch wizard (autopilot) and played by the executor on the real game
// page, so the tester watching sees every game. Started from the in-app
// Campaign tab or from Claude Desktop through the local control API
// (controlApi.ts). Verdicts are recorded per run, after the fact.
//
// State lives in this module and is saved to AppData/simulations/ after every
// change, so a long campaign survives an app restart (it comes back paused).

import { BaseDirectory, exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import gamesData from '../../data/games.json';
import * as scenarioStore from '../services/scenarioStore';
import { extractTracksOptions } from '../services/launchResolve';
import { endLaunchedGame, getLaunchedGameMeta, getLaunchedGameState } from '../services/launchedGames';
import { getClashMembers, getClashState } from '../services/clash';
import { gameClock } from '../services/gameClock';
import { requestPresetLaunch } from '../services/launchPresetStore';
import {
  appVersion,
  autoSetup,
  axesFor,
  comboKey,
  comboLabel,
  enumerate,
  listRuns,
  pairwise,
  recordRun,
  type SimulationRun,
  statusOf,
  type Combo,
  type Verdict,
} from './coverage';
import { getJournal, getRunPlan, getSimStatus, simCommand, subscribeSimStatus } from './executor';
import {
  SIM_JOURNAL_PREFIX,
  SIM_STATUS_PREFIX,
  type JournalEntry,
  type ScoreSnapshot,
  type SimJournalMirror,
  type SimRemoteStatus,
  type SimStatus,
} from './types';

export const CAMPAIGN_GAME_TYPES = ['mystery', 'tracks', 'tagquest', 'clash'] as const;

export type CampaignSource = 'gaps' | 'all' | 'preset' | 'custom' | 'retry';

export interface CampaignItemSpec {
  gameType: string;
  combo: Combo;
  scenarioUniqid?: string;
  seed?: number;
  /** Mock teams for this run (retries replay the original run's count). */
  teams?: number;
  /** Retry of this Studio run: its verdict is recorded as a child of it. */
  retryOf?: number;
}

export interface CampaignSpec {
  name?: string;
  source: CampaignSource;
  /** gaps / all: which game types (default: every type with coverage axes). */
  gameTypes?: string[];
  /** Play every item on this scenario (when its game type matches). */
  scenarioUniqid?: string;
  /** source=preset */
  preset?: string;
  /** source=custom */
  items?: CampaignItemSpec[];
  /** source=retry: Studio run ids to replay (default: every failed / partial
   *  run not resolved, filtered by gameTypes). */
  retryRunIds?: number[];
  /** source=all: keep configs that already have a Pass on this version (default false). */
  includeTested?: boolean;
  /** Keep only the first N items. */
  limit?: number;
  /** Simulation speed 1-20 (default 20). */
  speed?: number;
  /** Mock teams for auto/self-register games (default 6). */
  teams?: number;
  /** Game duration in minutes for every run (the game's time limit, not the
   *  simulation's). Default: each scenario's own default. */
  gameDuration?: number;
  /** Clash runs with the Purge: minutes after Start of the planned attempt.
   *  Default: random between 25 % and 60 % of the game. */
  clashPurgeAt?: number;
}

export type ItemState = 'queued' | 'launching' | 'running' | 'done' | 'skipped' | 'error' | 'stopped' | 'interrupted';

export interface RunResult {
  launchedGameId: number;
  seed: number;
  speed: number;
  devices: number;
  readsTotal: number;
  readsDone: number;
  readErrors: number;
  mockTeams: number;
  /** What looks wrong; empty = nothing spotted (still watch the screens). */
  anomalies: string[];
  warnings: string[];
  /** Teams as the game sees them at the end. */
  standings: Array<{ team: string; score: number; started: boolean; ended: boolean }>;
  journalTail: JournalEntry[];
  /** Every device's whole journal, in time order. */
  journal?: JournalEntry[];
  /** How the standings evolved during the run. */
  scoreTimeline?: ScoreSnapshot[];
  realSeconds: number;
}

export interface CampaignItem {
  index: number;
  gameType: string;
  combo: Combo;
  key: string;
  label: string;
  scenarioUniqid?: string;
  scenarioTitle?: string;
  seed?: number;
  teams?: number;
  /** Studio run this item retries (its verdict becomes a child of it). */
  retryOf?: number;
  state: ItemState;
  /** Why it was skipped / failed. */
  reason?: string;
  launchedGameId?: number;
  startedAt?: number;
  endedAt?: number;
  result?: RunResult;
  verdict?: { verdict: Verdict; note: string; tester: string; recordedAt: number; runId: number };
}

export interface Campaign {
  id: string;
  name: string;
  createdAt: number;
  appVersion: string;
  speed: number;
  teams: number;
  /** Game time limit in minutes for every run; undefined = scenario default. */
  gameDuration?: number;
  /** Clash: planned Purge attempt, minutes after Start; undefined = random. */
  clashPurgeAt?: number;
  scenarioUniqid?: string;
  state: 'running' | 'paused' | 'done' | 'stopped';
  /** Index of the item being played. */
  current: number | null;
  items: CampaignItem[];
}

const DIR = 'simulations';
const FILE = `${DIR}/campaign-current.json`;
const PRESETS_FILE = `${DIR}/presets.json`;

/** Shown on screen after a run, before the game is ended. */
const END_HOLD_MS = 8_000;
/** A read due this long (real time) without being played = the run is stuck.
 *  Waiting for a read still to come (a long planned gap at speed 1) is not. */
const STALL_MS = 5 * 60_000;
/** A read held this long because the game page is closed = the run is stuck. */
const HOLD_STALL_MS = 60_000;
/** The simulation must start this long after the game was created. */
const START_TIMEOUT_MS = 120_000;
/** Followers: how long after their last planned read (virtual) they may still be busy. */
const FOLLOWER_GRACE_VIRTUAL_MS = 3 * 60_000;
/** Followers past their plan with no progress this long (real time) are stuck. */
const FOLLOWER_IDLE_MS = 60_000;
/** Hard cap on waiting for followers, whatever the plan says (real time). */
const FOLLOWERS_TIMEOUT_MS = 90 * 60_000;
/** Score timeline: polled at most this often (real time). */
const SNAPSHOT_EVERY_MS = 2_000;
/** Score timeline: one snapshot at least this often (virtual time), even unchanged. */
const SNAPSHOT_MAX_GAP_MS = 60_000;
/** A follower with no status this long after the director finished never started. */
const FOLLOWER_SILENT_MS = 90_000;
/** Rough real-time overhead per run: wizard, page, end hold. */
const OVERHEAD_SEC = 30;
/** Rough virtual length of a session, minutes. */
const VIRTUAL_MIN: Record<string, number> = { mystery: 90, tracks: 60, tagquest: 60, clash: 60 };

let campaign: Campaign | null = null;
/** Bumped on every terminal item / campaign end (long-poll cursor). */
let seq = 0;
let loopToken = 0;
let skipRequested = false;
const listeners = new Set<(c: Campaign | null) => void>();

// ── state + persistence ──

function changed(terminal = false) {
  if (terminal) seq++;
  const c = campaign;
  listeners.forEach((l) => l(c));
  void save();
}

let saving: Promise<void> = Promise.resolve();
function save() {
  const snapshot = campaign ? JSON.stringify(campaign, null, 2) : null;
  saving = saving.then(async () => {
    if (!snapshot) return;
    try {
      await mkdir(DIR, { baseDir: BaseDirectory.AppData, recursive: true });
      await writeTextFile(FILE, snapshot, { baseDir: BaseDirectory.AppData });
    } catch (err) {
      console.warn('[campaign] save failed', err);
    }
  });
  return saving;
}

/** Reload the last campaign after a restart: an unfinished one comes back paused. */
export async function loadSavedCampaign(): Promise<void> {
  try {
    if (!(await exists(FILE, { baseDir: BaseDirectory.AppData }))) return;
    const c = JSON.parse(await readTextFile(FILE, { baseDir: BaseDirectory.AppData })) as Campaign;
    if (c.state === 'running' || c.state === 'paused') {
      for (const it of c.items) {
        if (it.state === 'launching' || it.state === 'running') {
          it.state = 'interrupted';
          it.reason = 'the app was closed during the run';
        }
      }
      c.state = 'paused';
      c.current = null;
    }
    campaign = c;
    changed();
  } catch (err) {
    console.warn('[campaign] could not reload the last campaign', err);
  }
}

export function getCampaign(): Campaign | null {
  return campaign;
}

export function subscribeCampaign(fn: (c: Campaign | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function campaignSeq(): number {
  return seq;
}

/** Resolves when an item ends (or the campaign does) after `since`, else on timeout. */
export function waitForChange(since: number, timeoutMs: number): Promise<void> {
  if (seq > since) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    const off = subscribeCampaign(() => {
      if (seq > since) done();
    });
    function done() {
      clearTimeout(timer);
      off();
      resolve();
    }
  });
}

// ── presets ──

export async function listPresets(): Promise<Record<string, CampaignItemSpec[]>> {
  try {
    if (!(await exists(PRESETS_FILE, { baseDir: BaseDirectory.AppData }))) return {};
    return JSON.parse(await readTextFile(PRESETS_FILE, { baseDir: BaseDirectory.AppData }));
  } catch {
    return {};
  }
}

export async function savePreset(name: string, items: CampaignItemSpec[]): Promise<void> {
  const all = await listPresets();
  all[name] = items.map((i) => ({ gameType: i.gameType, combo: i.combo, scenarioUniqid: i.scenarioUniqid, seed: i.seed }));
  await mkdir(DIR, { baseDir: BaseDirectory.AppData, recursive: true });
  await writeTextFile(PRESETS_FILE, JSON.stringify(all, null, 2), { baseDir: BaseDirectory.AppData });
}

// ── scenarios ──

export interface ScenarioInfo {
  uniqid: string;
  title: string;
  gameType: string;
  gameTypeName: string;
  routes: number;
  purgeImage: boolean;
}

function gameTypeName(gameType: string): string {
  const known = gamesData.game_types.find((gt) => gt.name.toLowerCase() === gameType.toLowerCase());
  return known ? known.name : gameType.charAt(0).toUpperCase() + gameType.slice(1);
}

/** Downloaded scenarios of the simulated game types, with what combos need from them. */
export async function listScenarios(): Promise<ScenarioInfo[]> {
  const rows = await scenarioStore.list({ downloaded: true });
  const out: ScenarioInfo[] = [];
  for (const r of rows) {
    const ga = axesFor(r.game_type);
    if (!ga) continue;
    const gd = await scenarioStore.getGameData(r.uniqid).catch(() => null);
    const gm =
      (gd as { game_meta?: Record<string, unknown> } | null)?.game_meta ??
      (gd as { game_data?: { game_meta?: Record<string, unknown> } } | null)?.game_data?.game_meta ??
      {};
    out.push({
      uniqid: r.uniqid,
      title: r.title,
      gameType: ga.gameType,
      gameTypeName: gameTypeName(r.game_type),
      routes: ga.gameType === 'tracks' ? extractTracksOptions(gd).routes.length : 0,
      purgeImage: typeof gm.purge_image === 'string' && gm.purge_image.length > 0,
    });
  }
  return out;
}

/** Scenario fit for one combination (the wizard re-checks on launch). */
function fits(s: ScenarioInfo, combo: Combo): boolean {
  if (s.gameType === 'tracks' && combo.routes === 'several' && s.routes < 2) return false;
  if (s.gameType === 'clash' && combo.purge === 'on' && !s.purgeImage) return false;
  return true;
}

// ── building the list ──

export async function buildItems(spec: CampaignSpec): Promise<CampaignItemSpec[]> {
  const types = (spec.gameTypes?.length ? spec.gameTypes : [...CAMPAIGN_GAME_TYPES])
    .map((t) => axesFor(t)?.gameType)
    .filter((t): t is string => !!t);
  let items: CampaignItemSpec[] = [];
  if (spec.source === 'custom') {
    items = (spec.items ?? []).map((i) => ({ ...i, gameType: axesFor(i.gameType)?.gameType ?? i.gameType }));
  } else if (spec.source === 'retry') {
    // Replay recorded runs exactly: same options, scenario, seed and team count.
    const runs = await listRuns(true);
    const byId = new Map(runs.map((r) => [r.id, r]));
    const picked = spec.retryRunIds?.length
      ? spec.retryRunIds.map((id) => {
          const r = byId.get(id);
          if (!r) throw new Error(`no Studio run #${id}`);
          return r;
        })
      : retryCandidates(runs, types);
    items = picked.map((r) => ({
      gameType: r.game_type,
      combo: r.config,
      scenarioUniqid: r.scenario_uniqid ?? undefined,
      seed: r.seed,
      teams: r.teams_count || undefined,
      retryOf: r.id,
    }));
  } else if (spec.source === 'preset') {
    const presets = await listPresets();
    const list = spec.preset ? presets[spec.preset] : undefined;
    if (!list) throw new Error(`no preset named "${spec.preset ?? ''}"`);
    items = list;
  } else {
    const [runs, version] = await Promise.all([listRuns(true), appVersion()]);
    for (const t of types) {
      const ga = axesFor(t)!;
      if (spec.source === 'gaps') {
        for (const s of pairwise(ga, runs, version).suggestions) items.push({ gameType: t, combo: s.combo });
      } else {
        for (const combo of enumerate(ga)) {
          if (!spec.includeTested && statusOf(comboKey(t, combo), runs, version).kind === 'tested') continue;
          items.push({ gameType: t, combo });
        }
      }
    }
  }
  if (spec.limit && spec.limit > 0) items = items.slice(0, spec.limit);
  return items;
}

/** Failed / partial runs not resolved in Studio, newest first. */
export function retryCandidates(runs: SimulationRun[], gameTypes?: string[]): SimulationRun[] {
  return runs.filter(
    (r) =>
      r.verdict !== 'pass' &&
      r.triage_status !== 'resolved' &&
      (!gameTypes?.length || gameTypes.includes(axesFor(r.game_type)?.gameType ?? r.game_type)),
  );
}

/** Fill in the full combo (missing axes take their first value) and validate it. */
function normalise(spec: CampaignItemSpec): { gameType: string; combo: Combo } | { error: string } {
  const ga = axesFor(spec.gameType);
  if (!ga) return { error: `no simulation for game type "${spec.gameType}"` };
  const combo: Combo = {};
  for (const a of ga.axes) {
    const v = spec.combo?.[a.id] ?? a.values[0].v;
    if (!a.values.some((x) => x.v === v)) {
      return { error: `${a.id}=${v} is not a value of ${ga.gameType} (${a.values.map((x) => x.v).join(', ')})` };
    }
    combo[a.id] = v;
  }
  if (!ga.valid(combo)) return { error: 'the Launch wizard cannot produce this combination' };
  return { gameType: ga.gameType, combo };
}

/** Rough real time of a list of runs; the game duration sets the simulated span. */
export function estimateSeconds(items: Array<{ gameType: string }>, speed: number, gameDuration?: number): number {
  return items.reduce(
    (sum, i) => sum + OVERHEAD_SEC + ((gameDuration ?? VIRTUAL_MIN[i.gameType] ?? 60) * 60) / Math.max(1, speed),
    0,
  );
}

function clampDuration(v: number | undefined): number | undefined {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.min(600, Math.max(1, Math.round(v)));
}

// ── control ──

export async function startCampaign(spec: CampaignSpec): Promise<Campaign> {
  if (campaign && (campaign.state === 'running' || campaign.current !== null)) {
    throw new Error('a campaign is already running: stop it first');
  }
  const specs = await buildItems(spec);
  if (specs.length === 0) throw new Error('nothing to run: the list is empty');
  const scenarios = await listScenarios();
  const items: CampaignItem[] = specs.map((s, index) => {
    const n = normalise(s);
    if ('error' in n) {
      return { index, gameType: s.gameType, combo: s.combo ?? {}, key: '', label: '', state: 'skipped', reason: n.error };
    }
    const ga = axesFor(n.gameType)!;
    const item: CampaignItem = {
      index,
      gameType: n.gameType,
      combo: n.combo,
      key: comboKey(n.gameType, n.combo),
      label: comboLabel(ga, n.combo),
      seed: s.seed,
      teams: s.teams,
      retryOf: s.retryOf,
      state: 'queued',
    };
    const wanted = s.scenarioUniqid ?? spec.scenarioUniqid;
    const pool = scenarios.filter((x) => x.gameType === n.gameType);
    // A retry replays the ORIGINAL scenario, never a substitute.
    const pick = s.retryOf
      ? pool.find((x) => x.uniqid === wanted) ?? null
      : pool.find((x) => x.uniqid === wanted && fits(x, n.combo)) ?? pool.find((x) => fits(x, n.combo)) ?? null;
    if (!pick && s.retryOf) {
      item.state = 'skipped';
      item.reason = wanted
        ? `retry of #${s.retryOf}: its scenario (${wanted}) is not downloaded on this PC`
        : `retry of #${s.retryOf}: the run has no scenario recorded`;
    } else if (!pick) {
      item.state = 'skipped';
      item.reason = pool.length
        ? 'no downloaded scenario fits this combination (routes / Purge image)'
        : `no downloaded ${n.gameType} scenario`;
    } else {
      item.scenarioUniqid = pick.uniqid;
      item.scenarioTitle = pick.title;
    }
    return item;
  });
  campaign = {
    id: `c${Date.now()}`,
    name: spec.name?.trim() || `${spec.source} ${new Date().toLocaleString('fr-FR')}`,
    createdAt: Date.now(),
    appVersion: await appVersion(),
    speed: Math.min(20, Math.max(1, Math.round(spec.speed ?? 20))),
    teams: Math.min(50, Math.max(1, Math.round(spec.teams ?? 6))),
    gameDuration: clampDuration(spec.gameDuration),
    clashPurgeAt: clampDuration(spec.clashPurgeAt),
    scenarioUniqid: spec.scenarioUniqid,
    state: 'running',
    current: null,
    items,
  };
  changed(true);
  void loop();
  return campaign;
}

export function pauseCampaign(): void {
  if (!campaign || campaign.state !== 'running') return;
  // The run in progress finishes; the next one waits for Resume.
  campaign.state = 'paused';
  changed();
}

export function resumeCampaign(): void {
  if (!campaign || (campaign.state !== 'paused' && campaign.state !== 'stopped')) return;
  if (!campaign.items.some((i) => i.state === 'queued')) return;
  campaign.state = 'running';
  changed();
  if (campaign.current === null) void loop();
}

/** Stop the current run (its game is ended) and go on with the next one. */
export function skipCurrent(): void {
  if (!campaign || campaign.current === null) return;
  skipRequested = true;
}

export async function stopCampaign(): Promise<void> {
  if (!campaign) return;
  campaign.state = 'stopped';
  skipRequested = true;
  changed(true);
}

/** Clear a finished campaign from the panel (its file is kept until the next one). */
export function clearCampaign(): void {
  if (campaign && campaign.current !== null) return;
  campaign = null;
  changed(true);
}

// ── the loop ──

async function loop() {
  const myLoop = ++loopToken;
  while (campaign && myLoop === loopToken && campaign.state === 'running') {
    const item = campaign.items.find((i) => i.state === 'queued');
    if (!item) {
      campaign.state = 'done';
      campaign.current = null;
      changed(true);
      return;
    }
    campaign.current = item.index;
    skipRequested = false;
    await playItem(campaign, item);
    if (campaign) campaign.current = null;
    changed(true);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Launch through the wizard autopilot; resolves the game id or a failure reason. */
function launchItem(c: Campaign, item: CampaignItem): Promise<{ gid: number } | { reason: string }> {
  const ga = axesFor(item.gameType)!;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ reason: 'the wizard did not launch within 2 minutes' }), 120_000);
    requestPresetLaunch({
      scenarioUniqid: item.scenarioUniqid!,
      scenarioTitle: item.scenarioTitle ?? item.scenarioUniqid!,
      gameTypeName: gameTypeName(item.gameType),
      config: {
        simulated: true,
        simAutoStart: true,
        simSpeed: c.speed,
        simTeams: item.teams ?? c.teams,
        // Replays (custom seeds, retries) keep their seed; a retry is linked.
        ...(item.seed !== undefined ? { simSeed: item.seed } : {}),
        ...(item.retryOf ? { simRetryOf: item.retryOf } : {}),
        ...(c.clashPurgeAt ? { simPurgeAtMin: c.clashPurgeAt } : {}),
      },
      notice: `Simulation campaign "${c.name}" - run ${item.index + 1}/${c.items.length}${
        item.retryOf ? ` (retry of #${item.retryOf})` : ''
      }: ${item.label}${
        c.gameDuration ? ` · game ${c.gameDuration} min` : ''
      }`,
      autopilot: {
        setup: (world) => {
          const res = autoSetup(ga, item.combo, world);
          if (res.ok && c.gameDuration) res.patch.duration = c.gameDuration;
          return res;
        },
        onLaunched: (gid) => {
          clearTimeout(timer);
          resolve({ gid });
        },
        onFail: (reason) => {
          clearTimeout(timer);
          resolve({ reason });
        },
      },
    });
  });
}

const terminal = (p: SimStatus['phase']) => p === 'done' || p === 'stopped' || p === 'error';

async function playItem(c: Campaign, item: CampaignItem) {
  item.state = 'launching';
  item.startedAt = Date.now();
  changed();
  const launched = await launchItem(c, item);
  if ('reason' in launched) {
    // A combination the setup can't produce is skipped; anything else is an error.
    item.state = /2 devices|fewer than 2 routes|Purge image/.test(launched.reason) ? 'skipped' : 'error';
    item.reason = launched.reason;
    item.endedAt = Date.now();
    return;
  }
  const gid = launched.gid;
  item.launchedGameId = gid;
  item.state = 'running';
  changed();

  // Wait for the auto-start on this device (the executor opens the page).
  const startBy = Date.now() + START_TIMEOUT_MS;
  while (!(getSimStatus().launchedGameId === gid && getSimStatus().phase !== 'idle')) {
    if (skipRequested || Date.now() > startBy) break;
    await sleep(500);
  }
  const anomalies: string[] = [];
  const recorder = scoreRecorder(gid, item.gameType);
  let st = getSimStatus();
  if (st.launchedGameId !== gid || st.phase === 'idle') {
    anomalies.push(skipRequested ? 'skipped by hand before it started' : 'the simulation never started on this device');
  } else {
    await followRun(gid, anomalies, recorder);
  }
  st = getSimStatus();
  const realSeconds = Math.round((Date.now() - item.startedAt) / 1000);
  if (!skipRequested && st.phase === 'done') await sleep(END_HOLD_MS);
  await recorder.final();

  item.result = await collectResult(gid, st, c, anomalies, realSeconds, item, recorder.snapshots);
  item.seed = st.seed;
  let ended = false;
  try {
    await endLaunchedGame(gid);
    ended = true;
  } catch (err) {
    item.result.anomalies.push(`could not end the game: ${String(err)}`);
  }
  // Ending the game must not move a final score (the boards and the summaries
  // read lg_teams.score afterwards). Clash is left out: its standings already
  // take the live points, and the end legitimately saves them.
  if (ended && item.gameType !== 'clash') {
    try {
      const before = new Map(item.result.standings.map((s) => [s.team, s.score]));
      const moved: string[] = [];
      for (const t of (await getLaunchedGameState(gid, 0)).teams) {
        const name = t.team_name ?? `#${t.team_number}`;
        const was = before.get(name);
        if (was !== undefined && was !== t.score) moved.push(`${name} ${was} → ${t.score}`);
      }
      if (moved.length) {
        item.result.anomalies.push(`ending the game changed the scores: ${moved.slice(0, 6).join('; ')}`);
      }
    } catch (err) {
      item.result.anomalies.push(`could not re-read the scores after the end: ${String(err)}`);
    }
  }
  simCommand({ kind: 'stop' });
  if (skipRequested) {
    item.state = campaign?.state === 'stopped' ? 'stopped' : 'skipped';
    item.reason = campaign?.state === 'stopped' ? 'campaign stopped' : 'skipped by hand';
  } else {
    item.state = st.phase === 'error' ? 'error' : 'done';
    if (st.phase === 'error') item.reason = st.message;
  }
  item.endedAt = Date.now();
}

/** Follow the executor until the run (and its followers) end, or stalls. */
async function followRun(gid: number, anomalies: string[], recorder: ScoreRecorder) {
  let lastDone = -1;
  let lastProgressAt = Date.now();
  await new Promise<void>((resolve) => {
    const check = (s: SimStatus) => {
      if (s.launchedGameId !== gid) return;
      if (s.done !== lastDone || s.phase === 'paused') {
        lastDone = s.done;
        lastProgressAt = Date.now();
      }
      if (terminal(s.phase)) finish();
    };
    const off = subscribeSimStatus(check);
    const tick = setInterval(() => {
      if (skipRequested) {
        finish();
        return;
      }
      void recorder.tick();
      const s = getSimStatus();
      // Not a stall: paused (by hand or the page left), or waiting for a read
      // whose time has not come yet (planned gaps exceed minutes at speed 1).
      const waitingAhead = s.nextAt != null && !s.holding && gameClock.now() < s.nextAt;
      if (s.phase === 'paused' || waitingAhead) lastProgressAt = Date.now();
      const idle = Date.now() - lastProgressAt;
      if (s.holding && idle > HOLD_STALL_MS) {
        anomalies.push(
          `stalled: a read was held ${HOLD_STALL_MS / 1000} s because the game page is closed on this device ` +
            `(stuck at ${lastDone}/${s.total} reads)`,
        );
        finish();
      } else if (idle > STALL_MS) {
        anomalies.push(`stalled: a read due for ${STALL_MS / 60_000} min was not played (stuck at ${lastDone}/${s.total} reads)`);
        finish();
      }
    }, 1000);
    check(getSimStatus());
    function finish() {
      off();
      clearInterval(tick);
      resolve();
    }
  });
  // Multi-device: every follower dealt a share must report it and finish. Wait
  // as long as their plan says (a slow team's last bip can come long after the
  // director's), then until they stop making progress.
  const st = getSimStatus();
  if (st.role === 'director' && st.runKey && !skipRequested) {
    const expected = Math.max(0, (st.devices ?? 1) - 1);
    const run = getRunPlan();
    const theirReads = (run?.plan.reads ?? []).filter((r) => r.device !== undefined && r.device !== run?.me);
    const lastPlanned = theirReads.reduce((m, r) => Math.max(m, r.at), 0);
    const start = Date.now();
    let others: SimRemoteStatus[] = [];
    let progress = '';
    let lastChange = Date.now();
    while (Date.now() - start < FOLLOWERS_TIMEOUT_MS && !skipRequested) {
      void recorder.tick();
      others = await followerStatuses(gid, st.runKey);
      if (others.length >= expected && others.every((o) => terminal(o.status.phase))) return;
      // A device that never mirrored a status never started its share.
      if (others.length < expected && Date.now() - start > FOLLOWER_SILENT_MS) break;
      const now = others.map((o) => `${o.status.done}/${o.status.phase}`).join(',');
      if (now !== progress || gameClock.getSim()?.pausedAt != null) {
        progress = now;
        lastChange = Date.now();
      }
      const idle = Date.now() - lastChange;
      if (others.some((o) => o.status.holding) && idle > HOLD_STALL_MS) break;
      if (gameClock.now() > lastPlanned + FOLLOWER_GRACE_VIRTUAL_MS && idle > FOLLOWER_IDLE_MS) break;
      await sleep(3000);
    }
    if (skipRequested) return;
    if (others.length < expected) {
      anomalies.push(
        `${expected - others.length} of ${expected} other device(s) never started their share of the mock teams ` +
          '(tester build? game page open?): their reads were not played',
      );
    } else {
      const holding = others.filter((o) => o.status.holding).length;
      anomalies.push(
        holding
          ? `${holding} follower device(s) held their reads because the game page was closed there`
          : 'a follower device did not finish its share in time',
      );
    }
  }
}

interface ScoreRecorder {
  snapshots: ScoreSnapshot[];
  /** Throttled snapshot (call often). */
  tick(): Promise<void>;
  /** One last snapshot, always kept. */
  final(): Promise<void>;
}

/** Records how the standings evolve: kept when they change, and at least once
 *  per simulated minute. Clash reads the live standings (points accrue with
 *  time, so they change on every poll: only ownership / Purge changes count). */
function scoreRecorder(gid: number, gameType: string): ScoreRecorder {
  const snapshots: ScoreSnapshot[] = [];
  let busy: Promise<void> | null = null;
  let polledAt = 0;
  let lastSig = '';
  const take = async (force: boolean) => {
    if (busy) {
      if (!force) return;
      await busy;
    }
    if (!force && Date.now() - polledAt < SNAPSHOT_EVERY_MS) return;
    polledAt = Date.now();
    const run = (async () => {
      try {
        const snap = gameType === 'clash' ? await clashSnapshot(gid) : await teamsSnapshot(gid);
        const sig =
          gameType === 'clash'
            ? JSON.stringify([snap.owners, snap.purgedBy, snap.purgeTarget, snap.teams.map((t) => [t.team, t.members, t.weight])])
            : JSON.stringify(snap.teams);
        const prev = snapshots[snapshots.length - 1];
        if (force || sig !== lastSig || !prev || snap.at - prev.at >= SNAPSHOT_MAX_GAP_MS) {
          snapshots.push(snap);
          lastSig = sig;
        }
      } catch {
        /* the game may be gone; keep what we have */
      }
    })();
    busy = run;
    await run;
    if (busy === run) busy = null;
  };
  return { snapshots, tick: () => take(false), final: () => take(true) };
}

async function teamsSnapshot(gid: number): Promise<ScoreSnapshot> {
  const state = await getLaunchedGameState(gid, 0);
  return {
    at: gameClock.now(),
    teams: state.teams.map((t) => ({
      team: t.team_name ?? `#${t.team_number}`,
      score: t.score,
      started: t.start_time !== null,
      ended: t.end_time !== null,
    })),
  };
}

async function clashSnapshot(gid: number): Promise<ScoreSnapshot> {
  const cs = await getClashState(gid);
  const name = new Map(cs.clans.map((c) => [c.team_id, c.team_name ?? `Clan ${c.team_number}`]));
  const owners: Record<number, string | null> = {};
  for (const t of cs.territories) {
    owners[t.index + 1] = t.owner_team_id == null ? null : (name.get(t.owner_team_id) ?? `#${t.owner_team_id}`);
  }
  const target = cs.purge?.target_territory_index;
  return {
    at: gameClock.now(),
    teams: cs.clans.map((c) => ({
      team: name.get(c.team_id) ?? `#${c.team_id}`,
      score: c.points,
      members: c.member_count,
      weight: c.weight,
      rate: c.rate,
    })),
    owners,
    purgedBy: cs.purge ? cs.purge.used_by.map((id) => name.get(id) ?? `#${id}`) : undefined,
    purgeTarget: target == null ? null : target + 1,
  };
}

async function followerStatuses(gid: number, runKey: string): Promise<SimRemoteStatus[]> {
  try {
    const meta = await getLaunchedGameMeta(gid);
    const out: SimRemoteStatus[] = [];
    for (const [k, v] of Object.entries(meta)) {
      if (!k.startsWith(SIM_STATUS_PREFIX)) continue;
      try {
        const s = JSON.parse(v) as SimRemoteStatus;
        if (s.status.runKey === runKey && s.status.role === 'follower') out.push(s);
      } catch {
        /* a half-written key */
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function collectResult(
  gid: number,
  st: SimStatus,
  c: Campaign,
  anomalies: string[],
  realSeconds: number,
  item: CampaignItem,
  scoreTimeline: ScoreSnapshot[],
): Promise<RunResult> {
  let readsTotal = st.total;
  let readsDone = st.done;
  let readErrors = st.errors ?? 0;
  // This device's whole journal, plus each follower's (its full journal when
  // it wrote one, else the tail its status mirror carries).
  const journal: JournalEntry[] = getJournal();
  let devices = st.devices ?? 1;
  if (st.runKey) {
    const meta = await getLaunchedGameMeta(gid).catch(() => ({}) as Record<string, string>);
    const me = String(getRunPlan()?.me);
    const fullFrom = new Set<string>();
    for (const [k, v] of Object.entries(meta)) {
      if (!k.startsWith(SIM_JOURNAL_PREFIX)) continue;
      try {
        const j = JSON.parse(v) as SimJournalMirror;
        const device = k.slice(SIM_JOURNAL_PREFIX.length);
        if (j.runKey !== st.runKey || device === me) continue;
        journal.push(...j.entries);
        fullFrom.add(device);
      } catch {
        /* ignore */
      }
    }
    for (const [k, v] of Object.entries(meta)) {
      if (!k.startsWith(SIM_STATUS_PREFIX)) continue;
      try {
        const s = JSON.parse(v) as SimRemoteStatus;
        if (s.status.runKey !== st.runKey) continue;
        if (s.status.role === 'follower') {
          if (!fullFrom.has(k.slice(SIM_STATUS_PREFIX.length))) journal.push(...s.journal);
          readsTotal += s.status.total;
          readsDone += s.status.done;
          readErrors += s.status.errors ?? 0;
          if (s.status.done < s.status.total) {
            anomalies.push(
              `device #${k.slice(SIM_STATUS_PREFIX.length)} played only ${s.status.done}/${s.status.total} of its reads` +
                (terminal(s.status.phase) ? '' : ` (still "${s.status.phase}")`),
            );
          }
        }
      } catch {
        /* ignore */
      }
    }
    devices = Math.max(devices, st.devices ?? 1);
  }
  journal.sort((a, b) => a.at - b.at);

  if (st.phase === 'error') anomalies.push(`simulator error: ${st.message ?? 'unknown'}`);
  if (item.combo.devices === 'several' && devices < 2) {
    anomalies.push('meant for several devices, but the mock teams all played on this one (the others did not open the game in time)');
  }
  for (const w of st.warnings) {
    if (/^Device #|launched devices opened|^Start pressed before|on its registration screen/.test(w)) anomalies.push(w);
  }
  if (readErrors > 0) anomalies.push(`${readErrors} card read(s) were refused by the reader path`);
  if (readsDone < readsTotal) anomalies.push(`only ${readsDone}/${readsTotal} planned reads were played`);
  for (const e of journal.filter((j) => !j.ok && !j.dropped).slice(0, 5)) {
    anomalies.push(`read refused for ${e.team} (${e.intent}): ${e.error ?? 'error'}`);
  }

  const standings: RunResult['standings'] = [];
  try {
    const state = await getLaunchedGameState(gid, 0);
    // Clash: the clans' live points, as in the score timeline (the saved
    // lg_teams.score only moves on a validation).
    const clashPoints = new Map<number, number>();
    if (item.gameType === 'clash') {
      try {
        for (const c of (await getClashState(gid)).clans) clashPoints.set(c.team_id, c.points);
      } catch {
        /* keep the saved scores */
      }
    }
    for (const t of state.teams) {
      standings.push({
        team: t.team_name ?? `#${t.team_number}`,
        score: clashPoints.get(t.id) ?? t.score,
        started: t.start_time !== null,
        ended: t.end_time !== null,
      });
    }
    const dynamic = item.combo.registration === 'auto' || item.combo.registration === 'self';
    if ((item.gameType === 'mystery' || item.gameType === 'tracks') && dynamic && st.teams && standings.length < st.teams) {
      anomalies.push(`only ${standings.length} of ${st.teams} mock teams appear in the game`);
    }
    anomalies.push(...cardOutcomeAnomalies(item.gameType, item.combo, journal, state.teams));
    if (item.gameType === 'tagquest' || item.gameType === 'clash') {
      anomalies.push(...(await registrationAnomalies(gid, item.gameType, journal, state)));
    }
    if (item.gameType === 'mystery' || item.gameType === 'tracks' || item.gameType === 'tagquest') {
      const never = standings.filter((s) => !s.started).length;
      if (never > 0) anomalies.push(`${never} team(s) never started`);
    }
    if (standings.length > 0 && standings.every((s) => s.score === 0)) anomalies.push('every team scored 0');
  } catch (err) {
    anomalies.push(`could not read the final standings: ${String(err)}`);
  }

  return {
    launchedGameId: gid,
    seed: st.seed ?? 0,
    speed: c.speed,
    devices,
    readsTotal,
    readsDone,
    readErrors,
    mockTeams: st.teams ?? 0,
    anomalies,
    warnings: st.warnings,
    standings,
    journalTail: journal.slice(-30),
    journal,
    scoreTimeline,
    realSeconds,
  };
}

/**
 * Mystery / Tracks: what each card's played bips should have done to its team,
 * checked against the final state. Catches a bip the reader path accepted but
 * the game never applied (lost start, lost finish, name on the wrong team).
 */
function cardOutcomeAnomalies(
  gameType: string,
  combo: CampaignItem['combo'],
  journal: JournalEntry[],
  teams: Array<{
    key_id: number | null;
    team_name: string | null;
    start_time: number | null;
    end_time: number | null;
    score?: number | null;
  }>,
): string[] {
  const registration = combo.registration;
  if (gameType !== 'mystery' && gameType !== 'tracks') return [];
  const finishWord = gameType === 'mystery' ? 'end' : 'finish';
  const byCard = new Map<number, JournalEntry[]>();
  for (const e of journal) {
    if (!e.ok || e.dropped || !e.cardId) continue;
    byCard.set(e.cardId, [...(byCard.get(e.cardId) ?? []), e]);
  }
  const out: string[] = [];
  for (const [cardId, entries] of byCard) {
    const label = entries[0].team;
    const own = teams.filter((t) => t.key_id === cardId);
    const startBip = entries.some((e) => e.intent.startsWith('start') || e.intent.includes('(recovery)'));
    const finishBip = entries.some((e) => e.intent.startsWith(finishWord));
    if (startBip && !own.some((t) => t.start_time != null)) {
      out.push(`${label} (card ${cardId}): its start bip was played but the team never started`);
    }
    if (finishBip && !own.some((t) => t.end_time != null)) {
      out.push(`${label} (card ${cardId}): its ${finishWord} bip was played but the team is not finished`);
    }
    if (registration === 'self' && startBip && own.length === 1 && own[0].team_name !== label) {
      out.push(`${label} (card ${cardId}): registered under that name, shows as "${own[0].team_name ?? '?'}"`);
    }
    // Tracks in %: an on-time finish must score exactly the checkpoints the
    // game's own matching credits on the card the simulator built (points mode
    // is left out: a checkpoint's points come from the scenario).
    const expect = entries.find((e) => e.expect && e.intent.startsWith('finish'))?.expect;
    if (gameType === 'tracks' && combo.scoreType !== 'points' && expect && !expect.late && own.length === 1) {
      const want = expect.of > 0 ? (expect.hits / expect.of) * 100 : 0;
      const got = own[0].score;
      if (own[0].end_time != null && got != null && Math.abs(got - want) > 0.5) {
        out.push(
          `${label} (card ${cardId}): expected ${Math.round(want)} % (${expect.hits}/${expect.of} checkpoints), shows ${Math.round(got)} %`,
        );
      }
    }
  }
  return out;
}

/**
 * Quest / Clash: what the registration screen and the Start button should have
 * done. Each chip bipped on the registration screen must be a member of the
 * team it picked (a bip refused as "clan full", or landing after Start, leaves
 * the player out and every later bip of that chip is ignored); a played Start
 * must start the game; a played Quest FINISH must end the player's team.
 */
async function registrationAnomalies(
  gid: number,
  gameType: string,
  journal: JournalEntry[],
  state: { start_time: string | null; teams: Array<{ id: number; key_id: number | null; team_name: string | null; team_number: number; end_time: number | null }> },
): Promise<string[]> {
  const out: string[] = [];
  const played = journal.filter((e) => e.ok && !e.dropped);
  if (played.some((e) => e.intent === 'presses Start') && !state.start_time) {
    out.push('Start was pressed but the game never started (no start time): every later bip was taken as a registration');
  }
  const teamName = new Map(state.teams.map((t) => [t.id, t.team_name ?? `#${t.team_number}`]));
  const picked = new Map<number, number>(); // chip -> team id picked on screen
  for (const r of getRunPlan()?.plan.reads ?? []) {
    const sel = r.actions?.find((a) => a.kind === 'selectTeam');
    if (sel && 'teamId' in sel && !r.skip) picked.set(r.card.cardId, sel.teamId);
  }
  let memberOf = new Map<number, number>();
  try {
    memberOf = new Map((await getClashMembers(gid)).map((m) => [m.chip_id, m.team_id]));
  } catch (err) {
    out.push(`could not read the registered members: ${String(err)}`);
    return out;
  }
  const joins = played.filter((e) => picked.has(e.cardId) && / (joins|registers)\b/.test(e.intent));
  const missing: string[] = [];
  for (const e of joins) {
    const want = picked.get(e.cardId)!;
    const got = memberOf.get(e.cardId);
    if (got === undefined) missing.push(`${e.intent} (chip ${e.cardId})`);
    else if (got !== want) {
      out.push(`${e.intent} (chip ${e.cardId}): registered in ${teamName.get(got) ?? `#${got}`} instead`);
    }
  }
  if (missing.length) {
    out.push(
      `${missing.length} registration bip(s) left no member - refused or after Start, so their bips are ignored: ${missing.slice(0, 6).join('; ')}`,
    );
  }
  if (gameType === 'tagquest') {
    const byChip = new Map(state.teams.filter((t) => t.key_id != null).map((t) => [t.key_id as number, t.id]));
    const ended = new Map(state.teams.map((t) => [t.id, t.end_time != null]));
    for (const e of played.filter((x) => /: FINISH\b/.test(x.intent))) {
      const teamId = memberOf.get(e.cardId) ?? byChip.get(e.cardId);
      if (teamId !== undefined && !ended.get(teamId)) {
        out.push(`${e.team} (chip ${e.cardId}): its FINISH bip was played but the team is not finished`);
      }
    }
  }
  return out;
}

// ── verdicts ──

export async function recordVerdict(index: number, verdict: Verdict, note: string, tester: string): Promise<number> {
  const c = campaign;
  const item = c?.items.find((i) => i.index === index);
  if (!c || !item) throw new Error(`no run #${index} in the current campaign`);
  if (!item.result || (item.state !== 'done' && item.state !== 'error')) {
    throw new Error(`run #${index} has no result to judge (state: ${item.state})`);
  }
  const r = item.result;
  const runId = await recordRun({
    game_type: item.gameType,
    config_key: item.key,
    config: item.combo,
    verdict,
    note: note.trim() || undefined,
    tester_name: tester.trim() || undefined,
    scenario_uniqid: item.scenarioUniqid,
    scenario_title: item.scenarioTitle,
    app_version: c.appVersion,
    seed: r.seed,
    speed: r.speed,
    devices_count: r.devices,
    teams_count: r.mockTeams,
    reads_total: r.readsTotal,
    reads_done: r.readsDone,
    read_errors: r.readErrors,
    ...(item.retryOf ? { parent_run_id: item.retryOf } : {}),
  });
  item.verdict = { verdict, note, tester, recordedAt: Date.now(), runId };
  changed();
  return runId;
}
