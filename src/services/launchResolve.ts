// Shared launch-resolution helpers used by BOTH the interactive launch wizard
// (LaunchGameModal) and the headless Quick Launch path (GameList). Keeping the
// roster build + tracks-option parsing here means the two paths can never
// diverge.
//
// Import note: this module imports the modal's *types* only (`import type`),
// which the TS compiler erases — so there is no runtime circular dependency
// even though the modal imports functions from here.

import type { GameConfig, Team, Teammate, LaunchDeviceSelection } from '../components/LaunchGameModal';
import { listPairedDevicesForLaunch } from './launchedGames';

// The saved-config shape: step-1 settings without the per-instance name/teams.
export type ResolvableConfig = Omit<GameConfig, 'name' | 'teams'>;

// Minimal chip shape the roster builder needs — satisfied by both SiPuce
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
}

// ---------------------------------------------------------------- tracks
export interface TracksLaunchOptions {
  routes: string[];
  displays: string[];
  playModes: string[];
  scoreTypes: Array<{ key: string; isDefault: boolean }>;
  defaultTime: number;
  defaultMalus: number;
}

export const EMPTY_TRACKS_OPTIONS: TracksLaunchOptions = {
  routes: [],
  displays: [],
  playModes: [],
  scoreTypes: [],
  defaultTime: 60,
  defaultMalus: 1,
};

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

  // Enabled keys in declaration order — `Object.entries` preserves insertion
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
  return {
    routes: enabledKeys(gm.routes),
    displays: enabledKeys(gm.displays),
    playModes: enabledKeys(gm.play_modes),
    scoreTypes,
    defaultTime: num(gm.default_time, 60),
    defaultMalus: num(gm.default_time_malus, 1),
  };
}

// ---------------------------------------------------------------- roster
/** Whether tagquest team-mode bundles several chips into one team. */
function teamModeOf(config: Pick<GameConfig, 'playMode'>, gameTypeName: string): boolean {
  return gameTypeName.toLowerCase() === 'tagquest' && config.playMode === 'team';
}

/**
 * Build the team roster from `numberOfTeams` + `firstChipIndex` against the
 * given chip array — the exact logic that used to live inline in the modal's
 * `handleNextStep`. Solo: one chip per team. TagQuest team-mode: `chipsPerTeam`
 * consecutive chips per team, the first chip naming the team. Stops early if
 * the chip array runs out.
 */
export function buildRoster(
  config: Pick<GameConfig, 'firstChipIndex' | 'numberOfTeams' | 'playMode' | 'teammatesPerTeam'>,
  chips: RosterChip[],
  gameTypeName: string
): Team[] {
  const startIndex = config.firstChipIndex;
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

// ---------------------------------------------------------------- devices
/**
 * The headless default device selection: the mother participates, plus every
 * currently-online satellite — mirroring the launch wizard's step-3 defaults.
 * Network failure degrades to mother-only rather than throwing.
 */
export async function resolveDefaultDeviceSelection(): Promise<LaunchDeviceSelection> {
  try {
    const rows = await listPairedDevicesForLaunch();
    return {
      include_self: true,
      satellite_targets: rows.filter((r) => !r.is_self && r.online).map((r) => r.id),
    };
  } catch (err) {
    console.error('[launchResolve] resolveDefaultDeviceSelection failed:', err);
    return { include_self: true, satellite_targets: [] };
  }
}

// ---------------------------------------------------------------- validation
export interface HeadlessWorld {
  /** Pattern folders available for this scenario's game type. */
  patterns: PatternOption[];
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
    critical.push("This scenario isn't downloaded yet — open the full launch screen to sync it.");
  }

  // Pattern: missing entirely is critical; a stale id falls back to the first.
  if (world.patterns.length === 0) {
    critical.push('No pattern is available for this scenario.');
  } else if (!world.patterns.some((p) => p.uniqid === config.pattern)) {
    resolved.pattern = world.patterns[0].uniqid;
  }

  // Tracks: default any saved option that the scenario no longer enables.
  if (gt === 'tracks') {
    const t = world.tracksOptions;
    // Carry the enabled route set for the per-team Add Team override.
    resolved.tracksRoutes = t.routes;
    if (t.routes.length && !t.routes.includes(resolved.route ?? '')) resolved.route = t.routes[0];
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
      resolved.firstChipIndex = Math.max(0, Math.min(config.firstChipIndex, free - required));
    }
  }

  return { ok: critical.length === 0, critical, resolved };
}
