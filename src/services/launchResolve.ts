// Shared launch-resolution helpers used by BOTH the interactive launch wizard
// (LaunchGameModal) and the headless Quick Launch path (GameList). Keeping the
// roster build + tracks-option parsing here means the two paths can never
// diverge.
//
// Import note: this module imports the modal's *types* only (`import type`),
// which the TS compiler erases - so there is no runtime circular dependency
// even though the modal imports functions from here.

import type { GameConfig, Team, Teammate, LaunchDeviceSelection } from '../components/LaunchGameModal';
import { listLaunchDevices, listBusyDeviceIds } from './launchedGames';
import { isOperatorOnly } from './operatorMode';
import { tError } from '../i18n/errors';

// The saved-config shape: step-1 settings without the per-instance name/teams.
export type ResolvableConfig = Omit<GameConfig, 'name' | 'teams'>;

// Minimal chip shape the roster builder needs - satisfied by both SiPuce
// (the modal) and cardsRepo.CardRow (the headless path), so no mapping needed.
export interface RosterChip {
  id: number;
  key_number: number;
  key_name: string;
}

// ---------------------------------------------------------------- patterns
export interface PatternOption {
  slug: string;
  name: string;
  uniqid: string;
  /** patterns.is_default - the game type's designated default pattern. */
  isDefault?: boolean;
}

/**
 * The pattern a launch should pre-select. Order of preference:
 *   1. the scenario's own `default_pattern_id` (when it exists in the list),
 *   2. the pattern flagged `is_default` for the game type,
 *   3. the first available pattern.
 * A wrong pre-selected pattern silently breaks scoring (no station ever
 * matches), so every launch surface must pick through here - the wizard
 * (LaunchGameModal) and the headless Quick Launch drift fallback.
 */
export function resolveDefaultPattern(
  options: PatternOption[],
  scenarioDefaultId?: string | null,
): string {
  if (scenarioDefaultId && options.some((o) => o.uniqid === scenarioDefaultId)) {
    return scenarioDefaultId;
  }
  return options.find((o) => o.isDefault)?.uniqid ?? options[0]?.uniqid ?? '';
}

// The on-disk game-data.json may be the raw `game_data` blob or a legacy
// envelope with `{scenario, game_data}` siblings - depending on which sync
// generation wrote it. The CANONICAL studio field is
// `game_meta.scenario_default_pattern` (authored in every game-type editor's
// PatternSection); `default_pattern_id` is a legacy key kept for older data.
export function extractDefaultPatternId(rawGameData: unknown): string | null {
  if (!rawGameData || typeof rawGameData !== 'object') return null;
  const root = rawGameData as Record<string, unknown>;
  type GmHolder = { game_meta?: { scenario_default_pattern?: unknown; default_pattern_id?: unknown } };
  const candidates: unknown[] = [
    (root as GmHolder).game_meta?.scenario_default_pattern,
    (root.game_data as GmHolder | undefined)?.game_meta?.scenario_default_pattern,
    root.default_pattern_id,
    (root.scenario as { default_pattern_id?: unknown } | undefined)?.default_pattern_id,
    (root.game_data as { scenario?: { default_pattern_id?: unknown }; default_pattern_id?: unknown } | undefined)?.scenario?.default_pattern_id,
    (root.game_data as { default_pattern_id?: unknown } | undefined)?.default_pattern_id,
    (root as GmHolder).game_meta?.default_pattern_id,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c;
  }
  return null;
}

// ---------------------------------------------------------------- tracks
export interface TracksLaunchOptions {
  routes: string[];
  displays: string[];
  playModes: string[];
  scoreTypes: Array<{ key: string; isDefault: boolean }>;
  defaultTime: number;
  defaultMalus: number;
  /** The scenario's own "show the legend" choice - the launch toggle's default. */
  showLegend: boolean;
}

export const EMPTY_TRACKS_OPTIONS: TracksLaunchOptions = {
  routes: [],
  displays: [],
  playModes: [],
  scoreTypes: [],
  defaultTime: 60,
  defaultMalus: 1,
  showLegend: false,
};

/** Layout element id of the tracks feedback-image legend box. */
const TRACKS_LEGEND_LAYOUT_ID = 'legend';

/**
 * Whether the scenario itself shows the feedback-image legend: the studio
 * option (`game_meta.show_legend`) is on AND the author did not hide the box
 * in the layout editor. This is the default of the per-launch toggle
 * (`GameConfig.tracksShowLegend`), and what a game launched before that toggle
 * existed keeps doing. Accepts every distribution shape of the layout (cloud
 * `scenario_layout`, ZIP `layout`, enveloped `game_data.scenario_layout`).
 */
export function tracksLegendDefaultOn(rawGameData: unknown): boolean {
  const gm = extractGameMeta(rawGameData);
  if (!gm || gm.show_legend !== true) return false;
  const root = rawGameData as Record<string, unknown>;
  const elementsOf = (holder: unknown): unknown[] | null => {
    const els = (holder as { elements?: unknown } | undefined)?.elements;
    return Array.isArray(els) ? els : null;
  };
  const elements =
    elementsOf(root.scenario_layout) ??
    elementsOf(root.layout) ??
    elementsOf((root.game_data as { scenario_layout?: unknown } | undefined)?.scenario_layout) ??
    [];
  return !elements.some((el) => {
    const le = el as { id?: unknown; hidden?: unknown } | null;
    return !!le && le.id === TRACKS_LEGEND_LAYOUT_ID && le.hidden === true;
  });
}

/** Find game_meta in either the raw blob or the {game_data:{game_meta}} envelope. */
function extractGameMeta(rawGameData: unknown): Record<string, unknown> | null {
  if (!rawGameData || typeof rawGameData !== 'object') return null;
  const root = rawGameData as Record<string, unknown>;
  const gm =
    root.game_meta ??
    (root.game_data as { game_meta?: unknown } | undefined)?.game_meta;
  return gm && typeof gm === 'object' ? (gm as Record<string, unknown>) : null;
}

export function extractTracksOptions(rawGameData: unknown): TracksLaunchOptions {
  const gm = extractGameMeta(rawGameData);
  if (!gm) return EMPTY_TRACKS_OPTIONS;

  // Enabled keys in declaration order - `Object.entries` preserves insertion
  // order, which matches the studio's default-config ordering.
  const enabledKeys = (obj: unknown): string[] => {
    if (!obj || typeof obj !== 'object') return [];
    return Object.entries(obj as Record<string, unknown>)
      .filter(([, v]) => v && typeof v === 'object' && (v as { enabled?: boolean }).enabled)
      .map(([k]) => k);
  };
  const scoreTypesObj = (gm.score_types ?? {}) as Record<string, { enabled?: boolean; default?: boolean }>;
  const scoreTypes = Object.entries(scoreTypesObj)
    .filter(([, v]) => v?.enabled)
    .map(([k, v]) => ({ key: k, isDefault: !!v?.default }));
  const num = (v: unknown, fallback: number): number => {
    const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) ? n : fallback;
  };
  // "Tous les checkpoints" (`default`) is always offered, listed first and
  // pre-selected at launch, even when the studio's route subset omits it.
  return {
    routes: ['default', ...enabledKeys(gm.routes).filter((k) => k !== 'default')],
    displays: enabledKeys(gm.displays),
    playModes: enabledKeys(gm.play_modes),
    scoreTypes,
    defaultTime: num(gm.default_time, 60),
    defaultMalus: num(gm.default_time_malus, 1),
    showLegend: tracksLegendDefaultOn(rawGameData),
  };
}

// ---------------------------------------------------------------- roster
/** Whether tagquest team-mode bundles several chips into one team. */
function teamModeOf(config: Pick<GameConfig, 'playMode'>, gameTypeName: string): boolean {
  return gameTypeName.toLowerCase() === 'tagquest' && config.playMode === 'team';
}

/**
 * Build the team roster from `numberOfTeams` + `firstChipIndex` against the
 * given chip array - the exact logic that used to live inline in the modal's
 * `handleNextStep`. Solo: one chip per team. TagQuest team-mode: `chipsPerTeam`
 * consecutive chips per team, the first chip naming the team. Stops early if
 * the chip array runs out.
 *
 * `firstChipIndex` is 1-based: value N means "start at the Nth available chip"
 * (so N=1 uses the very first chip, N=10 the tenth). We convert to the 0-based
 * array offset with `-1` right here so every caller can speak in 1-based terms.
 */
export function buildRoster(
  config: Pick<GameConfig, 'firstChipIndex' | 'numberOfTeams' | 'playMode' | 'teammatesPerTeam'>,
  chips: RosterChip[],
  gameTypeName: string
): Team[] {
  const startIndex = Math.max(0, config.firstChipIndex - 1);
  const numberOfTeams = config.numberOfTeams;
  const isTeamMode = teamModeOf(config, gameTypeName);
  const chipsPerTeam = isTeamMode ? (config.teammatesPerTeam ?? 2) : 1;

  if (isTeamMode) {
    const teams: Team[] = [];
    for (let i = 0; i < numberOfTeams; i++) {
      const teamChips = chips.slice(
        startIndex + i * chipsPerTeam,
        startIndex + i * chipsPerTeam + chipsPerTeam
      );
      if (teamChips.length === 0) break;
      const firstChip = teamChips[0];
      const teammates: Teammate[] = teamChips.map((chip) => ({
        chipId: chip.id,
        chipNumber: chip.key_number,
        name: chip.key_name,
      }));
      teams.push({
        chipId: firstChip.id,
        chipNumber: firstChip.key_number,
        name: firstChip.key_name,
        teammates,
      });
    }
    return teams;
  }

  return chips
    .slice(startIndex, startIndex + numberOfTeams)
    .map((chip) => ({ chipId: chip.id, chipNumber: chip.key_number, name: chip.key_name }));
}

/** Chips required to satisfy a non-auto-register config. */
export function chipsRequired(config: Pick<GameConfig, 'numberOfTeams' | 'playMode' | 'teammatesPerTeam'>, gameTypeName: string): number {
  const chipsPerTeam = teamModeOf(config, gameTypeName) ? (config.teammatesPerTeam ?? 2) : 1;
  return Math.max(1, config.numberOfTeams) * chipsPerTeam;
}

/**
 * Clash "Équipes prédéfinies" (predetermined clans): deal contiguous blocks of
 * `chipsPerClan` chips to each of `numClans` clans, starting at the 1-based
 * `firstChipIndex` in the (key_number-ordered) free chip list. Mirrors
 * TagQuest's predetermined roster - uniform block size per clan - and produces
 * the same {chipId, clanIndex} shape the operator's Excel import yields, so
 * GameList's existing deferred `clashRegister` apply loop handles both.
 * clanIndex is 1-based (matches a clan's team_number). Stops if chips run out.
 */
export function buildClashContiguousAssignments(
  freeChips: RosterChip[],
  firstChipIndex: number,
  chipsPerClan: number,
  numClans: number,
): Array<{ chipId: number; clanIndex: number }> {
  const perClan = Math.max(0, Math.floor(chipsPerClan));
  const clans = Math.max(1, Math.floor(numClans));
  if (perClan === 0) return [];
  const start = Math.max(0, firstChipIndex - 1);
  const out: Array<{ chipId: number; clanIndex: number }> = [];
  for (let clan = 0; clan < clans; clan++) {
    const from = start + clan * perClan;
    const block = freeChips.slice(from, from + perClan);
    if (block.length === 0) break;
    for (const chip of block) out.push({ chipId: chip.id, clanIndex: clan + 1 });
  }
  return out;
}

// ---------------------------------------------------------------- devices
/**
 * The headless default device selection: the mother participates, plus every
 * currently-online satellite - mirroring the launch wizard's step-3 defaults.
 * Network failure degrades to mother-only rather than throwing.
 */
export async function resolveDefaultDeviceSelection(): Promise<LaunchDeviceSelection> {
  try {
    const [{ devices: rows, selfId, motherOutdated }, busy, operatorOnly] = await Promise.all([
      listLaunchDevices(),
      listBusyDeviceIds(),
      isOperatorOnly(),
    ]);
    return {
      // This device only joins the new game if it isn't already running one -
      // and never on an operator-only device (it manages games but never plays).
      include_self: operatorOnly ? false : selfId !== null ? !busy.has(selfId) : true,
      // Skip peers already participating in another active game (a device runs
      // at most one game at a time). On a child this includes the mother -
      // unless it runs an older build, which refuses a join_game to itself.
      satellite_targets: rows
        .filter(
          (r) =>
            r.id !== selfId &&
            r.online &&
            !r.operator_only &&
            !busy.has(r.id) &&
            !(motherOutdated && r.is_self),
        )
        .map((r) => r.id),
    };
  } catch (err) {
    console.error('[launchResolve] resolveDefaultDeviceSelection failed:', err);
    return { include_self: !(await isOperatorOnly()), satellite_targets: [] };
  }
}

// ---------------------------------------------------------------- validation
export interface HeadlessWorld {
  /** Pattern folders available for this scenario's game type. */
  patterns: PatternOption[];
  /** The scenario's own default_pattern_id (game-data), when authored. */
  scenarioDefaultPatternId?: string | null;
  /** Cards NOT already in use by another active game (in roster order). */
  freeChips: RosterChip[];
  /** Enabled tracks options parsed from game_meta (EMPTY for non-tracks). */
  tracksOptions: TracksLaunchOptions;
  /** Whether the scenario's game-data is downloaded locally. */
  scenarioDownloaded: boolean;
  gameTypeName: string;
}

export interface HeadlessValidation {
  ok: boolean;
  /** Human-readable critical reasons. Non-empty ⇒ open the pre-filled modal. */
  critical: string[];
  /** Config with minor drift defaulted (pattern/tracks fields, clamped start). */
  resolved: ResolvableConfig;
}

/**
 * Decide whether a saved config can be launched headlessly. Critical drift
 * (scenario not downloaded, no pattern available, too few free cards for a
 * non-auto-register config) blocks the headless path and should open the
 * pre-filled modal. Minor drift (a stale pattern id, a disabled tracks option,
 * a now-too-large first-chip index) is silently defaulted in `resolved`.
 */
export function validateForHeadless(config: ResolvableConfig, world: HeadlessWorld): HeadlessValidation {
  const critical: string[] = [];
  const resolved: ResolvableConfig = { ...config };
  const gt = world.gameTypeName.toLowerCase();

  if (!world.scenarioDownloaded) {
    critical.push(tError('scenarioNotDownloaded'));
  }

  // Pattern: missing entirely is critical; a stale id falls back to the
  // scenario/type default (NOT blindly the first - a wrong pattern silently
  // breaks scoring since no station ever matches).
  if (world.patterns.length === 0) {
    critical.push(tError('noPatternAvailable'));
  } else if (!world.patterns.some((p) => p.uniqid === config.pattern)) {
    resolved.pattern = resolveDefaultPattern(world.patterns, world.scenarioDefaultPatternId);
  }

  // Tracks: default any saved option that the scenario no longer enables.
  if (gt === 'tracks') {
    const t = world.tracksOptions;
    // Carry the enabled route set for the per-team Add Team override.
    resolved.tracksRoutes = t.routes;
    if (t.routes.length && !t.routes.includes(resolved.route ?? '')) resolved.route = t.routes[0];
    // Multi-route selection: drop any saved route the scenario no longer enables,
    // falling back to the (now-valid) primary route when nothing survives.
    if (t.routes.length) {
      const prunedRoutes = (resolved.routes ?? []).filter((r) => t.routes.includes(r));
      resolved.routes = prunedRoutes.length ? prunedRoutes : (resolved.route ? [resolved.route] : []);
    }
    if (t.displays.length && !t.displays.includes(resolved.displayMode ?? '')) resolved.displayMode = t.displays[0];
    if (t.playModes.length && !t.playModes.includes(resolved.trackPlayMode ?? '')) {
      resolved.trackPlayMode = t.playModes[0] as 'itinerary' | 'free';
    }
    const scoreKeys = t.scoreTypes.map((s) => s.key);
    if (scoreKeys.length && !scoreKeys.includes(resolved.scoreType ?? '')) {
      const def = t.scoreTypes.find((s) => s.isDefault)?.key ?? scoreKeys[0];
      resolved.scoreType = def as 'percentage' | 'points';
    }
  }

  // Roster: only when teams are pre-built. Dynamic-team modes (auto-register or
  // self-register) create teams on bip and need no pre-assigned cards.
  if (!config.autoRegisterTeam && !config.selfRegisterTeam) {
    const required = chipsRequired(config, world.gameTypeName);
    const free = world.freeChips.length;
    if (free < required) {
      critical.push(`Not enough free cards: this configuration needs ${required}, but ${free} ${free === 1 ? 'is' : 'are'} available.`);
    } else {
      // Clamp the saved start index so buildRoster can take `required` chips
      // from the free list (mirrors the wizard's maxFirstChipIndex clamp).
      // 1-based: the last valid start is `free - required + 1`, floored at 1.
      resolved.firstChipIndex = Math.max(1, Math.min(config.firstChipIndex, free - required + 1));
    }
  }

  return { ok: critical.length === 0, critical, resolved };
}
