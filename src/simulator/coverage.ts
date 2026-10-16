// Game simulator coverage: which launch configurations have been tested.
//
// A "config" = game type + the launch options that change game BEHAVIOUR
// (scenario and cosmetic options excluded). Each game type declares axes; the
// canonical key ("mystery|devices=one|lateMalus=off|...") identifies a config.
// Runs + verdicts live in Studio (simulation_runs.php, tester installs only).
// "Tested" = a Pass on the current app version. Pairwise mode: covering every
// PAIR of axis values counts as covered, which keeps the test list short.
//
// Axes for Quest / Tracks / Clash are added with their simulation models.

import { getVersion } from '@tauri-apps/api/app';
import { apiCall } from '../services/api';
import type { GameConfig } from '../components/LaunchGameModal';

export type Combo = Record<string, string>;

export interface Axis {
  id: string;
  label: string;
  values: Array<{ v: string; label: string }>;
  read(cfg: GameConfig, ctx: AxisCtx): string;
}

export interface AxisCtx {
  devices: number;
  /** Teams/clans in the launched game (Clash clan count), when known. */
  teamCount?: number;
}

export interface GameAxes {
  gameType: string;
  axes: Axis[];
  /** False for combinations the Launch modal can't produce. */
  valid(c: Combo): boolean;
  /** Launch-modal options that reproduce a combination. */
  toConfig(c: Combo): Partial<GameConfig>;
  /** What the preset can't set by itself (shown on top of the wizard). */
  manualSteps(c: Combo): string[];
}

const onOff = [
  { v: 'off', label: 'off' },
  { v: 'on', label: 'on' },
];
const flag = (b: boolean | undefined) => (b ? 'on' : 'off');

const MYSTERY: GameAxes = {
  gameType: 'mystery',
  axes: [
    {
      id: 'start',
      label: 'Start',
      values: [
        { v: 'staggered', label: 'staggered' },
        { v: 'mass', label: 'mass start' },
      ],
      read: (c) => (c.massStart ? 'mass' : 'staggered'),
    },
    {
      id: 'registration',
      label: 'Registration',
      values: [
        { v: 'auto', label: 'auto' },
        { v: 'self', label: 'self-register' },
        { v: 'roster', label: 'fixed list' },
        { v: 'import', label: 'imported list' },
      ],
      read: (c) =>
        c.selfRegisterTeam ? 'self' : c.autoRegisterTeam ? 'auto' : c.rosterImported ? 'import' : 'roster',
    },
    {
      id: 'reuseCards',
      label: 'Reuse cards',
      values: onOff,
      read: (c) => flag(c.reuseCards && (c.autoRegisterTeam || c.selfRegisterTeam)),
    },
    {
      id: 'namePool',
      label: 'Name pool',
      values: onOff,
      read: (c) => flag(c.useNamePool && c.autoRegisterTeam && !c.selfRegisterTeam),
    },
    {
      id: 'playerLanguage',
      label: 'Player language choice',
      values: onOff,
      read: (c) => flag(c.allowPlayerLanguageChoice && c.selfRegisterTeam),
    },
    {
      id: 'lateMalus',
      label: 'Time limit + late malus',
      values: onOff,
      read: (c) => flag((c.duration ?? 0) > 0 && (c.malusPerMinute ?? 0) > 0),
    },
    {
      id: 'firstBipVideos',
      label: 'First-bip videos',
      values: onOff,
      read: (c) => flag(c.playTutorialOnBip || c.playIntroOnBip),
    },
    {
      id: 'reset',
      label: 'Results reset',
      values: [
        { v: 'auto', label: 'auto' },
        { v: 'enter', label: 'Enter key' },
        { v: 'manual', label: 'button' },
      ],
      read: (c) => (c.autoResetTeam ? 'auto' : c.enterToReset ? 'enter' : 'manual'),
    },
    {
      id: 'devices',
      label: 'Devices',
      values: [
        { v: 'one', label: '1 device' },
        { v: 'several', label: 'several' },
      ],
      read: (_c, ctx) => (ctx.devices > 1 ? 'several' : 'one'),
    },
  ],
  valid(c) {
    const dynamic = c.registration === 'auto' || c.registration === 'self';
    if (c.start === 'mass' && dynamic) return false;
    if (c.reuseCards === 'on' && !dynamic) return false;
    if (c.namePool === 'on' && c.registration !== 'auto') return false;
    if (c.playerLanguage === 'on' && c.registration !== 'self') return false;
    return true;
  },
  toConfig(c) {
    const dynamic = c.registration === 'auto' || c.registration === 'self';
    return {
      massStart: c.start === 'mass',
      autoRegisterTeam: dynamic,
      selfRegisterTeam: c.registration === 'self',
      reuseCards: c.reuseCards === 'on',
      useNamePool: c.namePool === 'on',
      allowPlayerLanguageChoice: c.playerLanguage === 'on',
      ...(c.lateMalus === 'on' ? { malusPerMinute: 1 } : { malusPerMinute: 0 }),
      playTutorialOnBip: c.firstBipVideos === 'on',
      playIntroOnBip: false,
      autoResetTeam: c.reset === 'auto',
      enterToReset: c.reset === 'enter',
      simulated: true,
    };
  },
  manualSteps(c) {
    const steps: string[] = [];
    if (c.registration === 'roster') steps.push('Registration: switch to a fixed team list (do not import).');
    if (c.registration === 'import') steps.push('Registration: import the team list from Excel/CSV.');
    if (c.lateMalus === 'on') steps.push('Make sure the game has a time limit (duration > 0).');
    if (c.devices === 'several') steps.push('Step 3: select at least 2 devices.');
    else steps.push('Step 3: keep a single device.');
    return steps;
  },
};

const DEVICES_AXIS: Axis = {
  id: 'devices',
  label: 'Devices',
  values: [
    { v: 'one', label: '1 device' },
    { v: 'several', label: 'several' },
  ],
  read: (_c, ctx) => (ctx.devices > 1 ? 'several' : 'one'),
};

const devicesSteps = (c: Combo) =>
  c.devices === 'several' ? ['Step 3: select at least 2 devices.'] : ['Step 3: keep a single device.'];

const TRACKS: GameAxes = {
  gameType: 'tracks',
  axes: [
    MYSTERY.axes.find((a) => a.id === 'start')!,
    MYSTERY.axes.find((a) => a.id === 'registration')!,
    MYSTERY.axes.find((a) => a.id === 'reuseCards')!,
    MYSTERY.axes.find((a) => a.id === 'namePool')!,
    {
      id: 'routes',
      label: 'Routes',
      values: [
        { v: 'one', label: 'one route' },
        { v: 'several', label: 'several routes' },
      ],
      read: (c) => ((c.routes?.length ?? 0) > 1 ? 'several' : 'one'),
    },
    {
      id: 'playMode',
      label: 'Play mode',
      values: [
        { v: 'free', label: 'free' },
        { v: 'itinerary', label: 'itinerary' },
      ],
      read: (c) => (c.trackPlayMode === 'itinerary' ? 'itinerary' : 'free'),
    },
    {
      id: 'scoreType',
      label: 'Score',
      values: [
        { v: 'percentage', label: '%' },
        { v: 'points', label: 'points' },
      ],
      read: (c) => (c.scoreType === 'points' ? 'points' : 'percentage'),
    },
    {
      id: 'cluesPage',
      label: 'Clues page',
      values: onOff,
      read: (c) => flag(c.cluesPage?.enabled),
    },
    MYSTERY.axes.find((a) => a.id === 'lateMalus')!,
    MYSTERY.axes.find((a) => a.id === 'firstBipVideos')!,
    DEVICES_AXIS,
  ],
  valid(c) {
    const dynamic = c.registration === 'auto' || c.registration === 'self';
    if (c.start === 'mass' && dynamic) return false;
    // Several routes = a fixed roster (each team gets its route at launch).
    if (c.routes === 'several' && dynamic) return false;
    if (c.reuseCards === 'on' && !dynamic) return false;
    if (c.namePool === 'on' && c.registration !== 'auto') return false;
    return true;
  },
  toConfig(c) {
    const dynamic = c.registration === 'auto' || c.registration === 'self';
    return {
      massStart: c.start === 'mass',
      autoRegisterTeam: dynamic,
      selfRegisterTeam: c.registration === 'self',
      reuseCards: c.reuseCards === 'on',
      useNamePool: c.namePool === 'on',
      trackPlayMode: c.playMode === 'itinerary' ? 'itinerary' : 'free',
      scoreType: c.scoreType === 'points' ? 'points' : 'percentage',
      ...(c.lateMalus === 'on' ? { malusPerMinute: 1 } : { malusPerMinute: 0 }),
      playTutorialOnBip: c.firstBipVideos === 'on',
      playIntroOnBip: false,
      simulated: true,
    };
  },
  manualSteps(c) {
    const steps: string[] = [];
    if (c.registration === 'roster') steps.push('Registration: switch to a fixed team list (do not import).');
    if (c.registration === 'import') steps.push('Registration: import the team list from Excel/CSV.');
    if (c.routes === 'several') steps.push('Enable 2 routes or more.');
    steps.push(c.cluesPage === 'on' ? 'Turn the clues page ON.' : 'Turn the clues page OFF.');
    if (c.lateMalus === 'on') steps.push('Make sure the game has a time limit (duration > 0).');
    return [...steps, ...devicesSteps(c)];
  },
};

const QUEST: GameAxes = {
  gameType: 'tagquest',
  axes: [
    {
      id: 'playMode',
      label: 'Play mode',
      values: [
        { v: 'team', label: 'teams' },
        { v: 'solo', label: 'solo' },
      ],
      read: (c) => ((c.playMode ?? 'team') === 'solo' ? 'solo' : 'team'),
    },
    {
      id: 'registration',
      label: 'Registration',
      values: [
        { v: 'roster', label: 'fixed list' },
        { v: 'self', label: 'self-register' },
      ],
      read: (c) => (c.tagquestSelfRegister ? 'self' : 'roster'),
    },
    {
      id: 'victory',
      label: 'Victory',
      values: [
        { v: 'speed', label: 'speed' },
        { v: 'score', label: 'score' },
      ],
      read: (c) => ((c.victoryType ?? 'speed') === 'score' ? 'score' : 'speed'),
    },
    {
      id: 'weighting',
      label: 'Team-size weighting',
      values: onOff,
      read: (c) =>
        flag(c.tagquestScoreWeighting && (c.victoryType ?? 'speed') === 'score' && (c.playMode ?? 'team') === 'team'),
    },
    MYSTERY.axes.find((a) => a.id === 'firstBipVideos')!,
    DEVICES_AXIS,
  ],
  valid(c) {
    if (c.weighting === 'on' && (c.victory !== 'score' || c.playMode !== 'team')) return false;
    return true;
  },
  toConfig(c) {
    return {
      playMode: c.playMode === 'solo' ? 'solo' : 'team',
      tagquestSelfRegister: c.registration === 'self',
      victoryType: c.victory === 'score' ? 'score' : 'speed',
      tagquestScoreWeighting: c.weighting === 'on',
      playTutorialOnBip: c.firstBipVideos === 'on',
      playIntroOnBip: false,
      simulated: true,
    };
  },
  manualSteps: (c) => devicesSteps(c),
};

const CLASH: GameAxes = {
  gameType: 'clash',
  axes: [
    {
      id: 'registration',
      label: 'Registration',
      values: [
        { v: 'self', label: 'players register' },
        { v: 'bulk', label: 'predefined teams' },
      ],
      read: (c) => (c.clashRegistrationMode === 'bulk' ? 'bulk' : 'self'),
    },
    {
      id: 'clans',
      label: 'Clans',
      values: [
        { v: '2', label: '2' },
        { v: '3', label: '3' },
        { v: '4', label: '4' },
      ],
      read: (c, ctx) => String(Math.max(2, Math.min(4, ctx.teamCount ?? c.clashNumClans ?? 2))),
    },
    {
      id: 'clanCap',
      label: 'Players per clan cap',
      values: onOff,
      read: (c) => flag(c.clashRegistrationMode !== 'bulk' && (c.clashMaxPerClan ?? 0) > 0),
    },
    {
      id: 'purge',
      label: 'The Purge',
      values: onOff,
      read: (c) => flag(c.clashPurgeEnabled),
    },
    DEVICES_AXIS,
  ],
  valid(c) {
    if (c.clanCap === 'on' && c.registration === 'bulk') return false;
    return true;
  },
  toConfig(c) {
    return {
      clashRegistrationMode: c.registration === 'bulk' ? 'bulk' : 'self',
      clashNumClans: Number(c.clans),
      clashMaxPerClan: c.clanCap === 'on' ? 5 : 0,
      clashPurgeEnabled: c.purge === 'on',
      simulated: true,
    };
  },
  manualSteps(c) {
    const steps: string[] = [];
    if (c.purge === 'on') steps.push('The scenario needs a Purge image for the Purge to be available.');
    return [...steps, ...devicesSteps(c)];
  },
};

const GAME_AXES: Record<string, GameAxes> = {
  mystery: MYSTERY,
  tracks: TRACKS,
  tagquest: QUEST,
  quest: QUEST,
  clash: CLASH,
};

export function axesFor(gameType: string): GameAxes | null {
  return GAME_AXES[gameType.toLowerCase()] ?? null;
}

export function comboOf(ga: GameAxes, cfg: GameConfig, ctx: AxisCtx): Combo {
  const c: Combo = {};
  for (const a of ga.axes) c[a.id] = a.read(cfg, ctx);
  return c;
}

export function comboKey(gameType: string, c: Combo): string {
  return [
    gameType.toLowerCase(),
    ...Object.keys(c)
      .sort()
      .map((k) => `${k}=${c[k]}`),
  ].join('|');
}

/** Every valid combination of a game type's axes. */
export function enumerate(ga: GameAxes): Combo[] {
  let out: Combo[] = [{}];
  for (const a of ga.axes) {
    const next: Combo[] = [];
    for (const partial of out) for (const { v } of a.values) next.push({ ...partial, [a.id]: v });
    out = next;
  }
  return out.filter((c) => ga.valid(c));
}

// ── unattended launch (campaigns) ──

/** What the Launch wizard knows once the scenario is loaded. */
export interface WizardWorld {
  /** Tracks: routes the scenario enables ('default' first). */
  tracksRoutes: string[];
  clashHasPurgeImage: boolean;
}

/** How the wizard autopilot sets a combination up, or why it can't. */
export type AutoSetup =
  | {
      ok: true;
      /** Applied on top of the wizard's defaults after the scenario loaded. */
      patch: Partial<GameConfig>;
      /** Fixed roster: leave auto/self-register and build the team list. */
      fixedRoster: boolean;
      /** Step 3: at least 2 devices (else just this one). */
      severalDevices: boolean;
    }
  | { ok: false; reason: string };

/**
 * The hand steps of `manualSteps()`, done by code. The Excel parser itself is
 * not exercised for `registration=import`: the roster is built like a fixed
 * list and flagged as imported.
 */
export function autoSetup(ga: GameAxes, c: Combo, world: WizardWorld): AutoSetup {
  const patch: Partial<GameConfig> = { ...ga.toConfig(c), simulated: true, simAutoStart: true };
  const fixedRoster = c.registration === 'roster' || c.registration === 'import';
  if (fixedRoster) {
    patch.autoRegisterTeam = false;
    patch.selfRegisterTeam = false;
    patch.rosterImported = c.registration === 'import';
  }
  if (c.lateMalus === 'on') patch.duration = 60;
  if (ga.gameType === 'tracks') {
    if (c.routes === 'several') {
      if (world.tracksRoutes.length < 2) return { ok: false, reason: 'the scenario has fewer than 2 routes' };
      patch.routes = world.tracksRoutes.slice(0, 2);
      patch.route = patch.routes[0];
    } else {
      patch.routes = world.tracksRoutes.slice(0, 1);
      patch.route = patch.routes[0];
    }
    patch.cluesPage = { enabled: c.cluesPage === 'on', show_title: true, show_text: true, show_image: true, duration_sec: 10 };
  }
  if (ga.gameType === 'clash' && c.purge === 'on' && !world.clashHasPurgeImage) {
    return { ok: false, reason: 'the scenario has no Purge image' };
  }
  return { ok: true, patch, fixedRoster, severalDevices: c.devices === 'several' };
}

// ── runs (Studio) ──

export type Verdict = 'pass' | 'fail' | 'partial';

export interface SimulationRun {
  id: number;
  game_type: string;
  config_key: string;
  config: Combo;
  app_version: string;
  verdict: Verdict;
  note: string | null;
  scenario_uniqid?: string | null;
  scenario_title: string | null;
  tester_name: string | null;
  seed: number;
  speed?: number;
  teams_count?: number;
  created_at: string;
  /** This run is a retry of that run (Studio "retries"). */
  parent_run_id?: number | null;
  /** Studio triage: new | analysed | resolved. */
  triage_status?: 'new' | 'analysed' | 'resolved' | null;
}

export interface RecordRunInput {
  game_type: string;
  config_key: string;
  config: Combo;
  verdict: Verdict;
  note?: string;
  tester_name?: string;
  scenario_uniqid?: string;
  scenario_title?: string;
  app_version: string;
  seed: number;
  speed: number;
  devices_count: number;
  teams_count: number;
  reads_total: number;
  reads_done: number;
  read_errors: number;
  /** "Retry this run": the run this one retries (recorded as its child). */
  parent_run_id?: number;
}

export async function recordRun(input: RecordRunInput): Promise<number> {
  const res = await apiCall<{ id: number }>('simulation_runs', 'record', {
    method: 'POST',
    bearer: true,
    body: input,
  });
  runsCache = null;
  return res.id;
}

let runsCache: { at: number; runs: SimulationRun[] } | null = null;
const RUNS_CACHE_MS = 60_000;

export async function listRuns(force = false): Promise<SimulationRun[]> {
  if (!force && runsCache && Date.now() - runsCache.at < RUNS_CACHE_MS) return runsCache.runs;
  const res = await apiCall<{ runs: SimulationRun[] }>('simulation_runs', 'list', { method: 'GET', bearer: true });
  runsCache = { at: Date.now(), runs: res.runs ?? [] };
  return runsCache.runs;
}

let versionCache: string | null = null;
export async function appVersion(): Promise<string> {
  if (!versionCache) versionCache = await getVersion().catch(() => '0.0.0');
  return versionCache;
}

/** Numeric-aware version compare ("1.1.124" > "1.1.99"). */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ── status ──

export type ComboStatus =
  | { kind: 'tested'; version: string }
  | { kind: 'tested_old'; version: string }
  | { kind: 'failed'; version: string; verdict: Verdict }
  | { kind: 'never' };

/** Status of one config key from its runs (latest verdict wins on the current version). */
export function statusOf(key: string, runs: SimulationRun[], current: string): ComboStatus {
  const mine = runs.filter((r) => r.config_key === key);
  if (mine.length === 0) return { kind: 'never' };
  const onCurrent = mine.filter((r) => cmpVersion(r.app_version, current) >= 0);
  if (onCurrent.length > 0) {
    const latest = onCurrent.reduce((a, b) => (a.created_at >= b.created_at ? a : b));
    return latest.verdict === 'pass'
      ? { kind: 'tested', version: latest.app_version }
      : { kind: 'failed', version: latest.app_version, verdict: latest.verdict };
  }
  const pass = mine
    .filter((r) => r.verdict === 'pass')
    .reduce<SimulationRun | null>((a, b) => (!a || cmpVersion(b.app_version, a.app_version) > 0 ? b : a), null);
  if (pass) return { kind: 'tested_old', version: pass.app_version };
  const latest = mine.reduce((a, b) => (a.created_at >= b.created_at ? a : b));
  return { kind: 'failed', version: latest.app_version, verdict: latest.verdict };
}

// ── pairwise ──

const pairId = (a: string, va: string, b: string, vb: string) => `${a}=${va}&${b}=${vb}`;

function pairsOf(ga: GameAxes, c: Combo): string[] {
  const ids = ga.axes.map((a) => a.id);
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) out.push(pairId(ids[i], c[ids[i]], ids[j], c[ids[j]]));
  return out;
}

export interface PairwiseReport {
  total: number;
  covered: number;
  /** Valid combos ordered greedily: each adds the most still-uncovered pairs. */
  suggestions: Array<{ combo: Combo; adds: number }>;
}

/** Pairs that some valid combo can produce; covered = by a Pass on the current version. */
export function pairwise(ga: GameAxes, runs: SimulationRun[], current: string): PairwiseReport {
  const combos = enumerate(ga);
  const needed = new Set<string>();
  for (const c of combos) for (const p of pairsOf(ga, c)) needed.add(p);
  const covered = new Set<string>();
  for (const r of runs) {
    if (r.game_type !== ga.gameType || r.verdict !== 'pass' || cmpVersion(r.app_version, current) < 0) continue;
    for (const p of pairsOf(ga, r.config)) if (needed.has(p)) covered.add(p);
  }
  const total = needed.size;
  const coveredCount = covered.size;
  const suggestions: PairwiseReport['suggestions'] = [];
  const work = new Set(covered);
  for (let guard = 0; guard < 200 && work.size < total; guard++) {
    let best: Combo | null = null;
    let bestAdds = 0;
    for (const c of combos) {
      const adds = pairsOf(ga, c).filter((p) => !work.has(p)).length;
      if (adds > bestAdds) {
        best = c;
        bestAdds = adds;
      }
    }
    if (!best) break;
    suggestions.push({ combo: best, adds: bestAdds });
    for (const p of pairsOf(ga, best)) work.add(p);
  }
  return { total, covered: coveredCount, suggestions };
}

export function comboLabel(ga: GameAxes, c: Combo): string {
  return ga.axes
    .map((a) => `${a.label}: ${a.values.find((v) => v.v === c[a.id])?.label ?? c[a.id]}`)
    .join(' · ');
}
