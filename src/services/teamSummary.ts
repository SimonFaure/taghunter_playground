/**
 * Build a self-contained per-team final-summary snapshot on the operator, to be
 * pushed to a paired device (show_team_summary) and rendered by
 * <TeamSummaryOverlay>. Only mystery + tracks have a per-team final page.
 *
 * Reuses the punch-reconstruction + route helpers shared with the report engine
 * (`reportStats.ts`) and the tracks scoring helpers (`tracksScoring.ts`) so the
 * mystery level/score and tracks found/missing sets match what the live game and
 * the printed reports show. Images are emitted as relative scenario paths - the
 * target device resolves them locally via `scenarioAssetUrl()`.
 */

import { getLaunchedGameState, getLaunchedGameMeta, type RawPunchRow, type TeamRow } from './launchedGames';
import * as scenarioStore from './scenarioStore';
import * as patternStore from './patternStore';
import { checkpointsForRoute, firstSlotByCheckpoint, orderedHitCheckpointIds, type TracksCheckpoint } from './tracksScoring';
import { gameConfigFromMeta } from '../utils/gameConfigFromMeta';
import {
  livePunchesForTeam,
  chipIdsForTeam,
  parseTeamsConfig,
  rawRecordsFromState,
} from './reportStats';
import type { TeamSummarySnapshot, TeamSummaryCheckpoint } from './teamSummaryTarget';

export interface TeamSummaryGameInput {
  id: number;
  game_uniqid: string;
  game_type: string;
  name: string;
  number_of_teams: number;
}

/** Game types that have a renderable per-team final page. */
export function gameTypeHasTeamSummary(gameType: string): boolean {
  const t = (gameType || '').toLowerCase();
  return t === 'mystery' || t === 'tracks';
}

export async function buildTeamSummarySnapshot(
  game: TeamSummaryGameInput,
  teamId: number,
): Promise<TeamSummarySnapshot | null> {
  const type = (game.game_type || '').toLowerCase();
  if (type !== 'mystery' && type !== 'tracks') return null;

  const [state, meta, gdRaw] = await Promise.all([
    getLaunchedGameState(game.id, 0),
    getLaunchedGameMeta(game.id),
    scenarioStore.getGameData(game.game_uniqid).catch(() => null),
  ]);
  const team = state.teams.find((t) => t.id === teamId);
  if (!team) return null;
  const language = (team.language || meta.language || 'fr').toLowerCase();

  return type === 'mystery'
    ? buildMystery(game, team, language, meta, gdRaw)
    : buildTracks(game, team, language, meta, gdRaw, state.new_raw_data);
}

// ---------- mystery ----------

function buildMystery(
  game: TeamSummaryGameInput,
  team: TeamRow,
  language: string,
  meta: Record<string, string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gdRaw: any,
): TeamSummarySnapshot {
  const gm = (gdRaw?.game_data?.game_meta ?? gdRaw?.game_meta ?? {}) as Record<string, unknown>;
  const translations = (gdRaw?.translations ?? gdRaw?.game_data?.translations ?? {}) as Record<
    string,
    { levels?: Record<string, { name?: string; description?: string }> }
  >;
  const score = team.score ?? 0;
  // Mirrors MysteryGamePage.formatScore: percentage when units = percentage,
  // else "score / full".
  const finalScoreText =
    gm.points_units === 'percentage'
      ? `${Math.round(score)}%`
      : `${Math.round(score)} / ${gm.score_full_game ?? ''}`;
  const level = reachedLevel(
    (gm.levels ?? {}) as Record<string, { points?: string; name?: string; description?: string }>,
    translations,
    language,
    score,
  );
  // Mirror the in-game "Auto-reset page" option so a device showing this over
  // its in-game screen self-dismisses (MysteryGamePage.waitForReset).
  const cfg = gameConfigFromMeta(meta, { name: game.name, numberOfTeams: game.number_of_teams });
  return {
    gameType: 'mystery',
    launchedGameId: game.id,
    scenarioUniqid: game.game_uniqid,
    teamName: team.team_name ?? '',
    language,
    backgroundImage: typeof gm.background_image === 'string' ? gm.background_image : '',
    finalScoreText,
    levelName: level?.name || undefined,
    levelDescription: level?.description || undefined,
    levelFontColor: typeof gm.level_font_color === 'string' ? gm.level_font_color : undefined,
    autoReset: !!cfg.autoResetTeam,
    autoResetSeconds: cfg.delayBeforeReset || 0,
  };
}

/** Highest level whose points threshold ≤ score, localized to `lang`.
 *  Mirrors MysteryGamePage.reachedLevelFor. */
function reachedLevel(
  levels: Record<string, { points?: string; name?: string; description?: string }>,
  translations: Record<string, { levels?: Record<string, { name?: string; description?: string }> }>,
  lang: string,
  scoreValue: number,
): { name: string; description: string } | null {
  const localizedLevels = lang ? translations?.[lang]?.levels : undefined;
  let bestKey: string | null = null;
  let bestPts = -Infinity;
  for (const [key, lvl] of Object.entries(levels)) {
    const pts = parseFloat(lvl?.points ?? '0') || 0;
    if (pts <= scoreValue && pts > bestPts) {
      bestKey = key;
      bestPts = pts;
    }
  }
  if (bestKey === null) return null;
  const flat = levels[bestKey];
  const loc = localizedLevels?.[bestKey];
  return {
    name: loc?.name ?? flat?.name ?? '',
    description: loc?.description ?? flat?.description ?? '',
  };
}

// ---------- tracks ----------

interface NormalizedTracksMedia {
  checkpoints: TracksCheckpoint[];
  checkpoints_unique_image: boolean;
  images: Record<string, string>;
  checkpointImages: Record<string, string>;
  showScore: boolean;
  autoReset: boolean;
}

/** Subset of TracksGamePage.normalizeTracksGameData - only the checkpoints +
 *  image slots the summary needs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeTracksMedia(raw: any): NormalizedTracksMedia {
  const gm = raw?.game_data?.game_meta ?? raw?.game_meta ?? {};
  const medias = raw?.game_data?.medias ?? raw?.medias ?? {};
  const SLOTS = ['background_image', 'missing_checkpoint_image', 'checkpoints_unique_image_id'];
  const images: Record<string, string> = {};
  for (const slot of SLOTS) {
    const fromMeta = typeof gm[slot] === 'string' ? gm[slot] : '';
    const fromMedias = typeof medias?.images?.[slot] === 'string' ? medias.images[slot] : '';
    const v = fromMeta || fromMedias;
    if (v) images[slot] = v;
  }
  const checkpoints: TracksCheckpoint[] = Array.isArray(gm.checkpoints) ? gm.checkpoints : [];
  const checkpointImages: Record<string, string> = {};
  for (const cp of checkpoints) {
    if (typeof cp.image === 'string' && cp.image) checkpointImages[cp.id] = cp.image;
  }
  if (Array.isArray(medias?.checkpoints)) {
    for (const mc of medias.checkpoints) {
      if (mc?.checkpoint_id && typeof mc.image === 'string' && mc.image) {
        checkpointImages[mc.checkpoint_id] = mc.image;
      }
    }
  }
  return {
    checkpoints,
    checkpoints_unique_image: !!gm.checkpoints_unique_image,
    images,
    checkpointImages,
    showScore: gm.display_score !== false,
    autoReset: gm.auto_reset !== false,
  };
}

/** Tracks clues-review hold before auto-reset (TracksGamePage clues path). */
const TRACKS_AUTO_RESET_SECONDS = 6;

async function buildTracks(
  game: TeamSummaryGameInput,
  team: TeamRow,
  language: string,
  meta: Record<string, string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gdRaw: any,
  rawRows: RawPunchRow[],
): Promise<TeamSummarySnapshot> {
  const cfg = gameConfigFromMeta(meta, { name: game.name, numberOfTeams: game.number_of_teams });
  const scoreType = cfg.scoreType ?? 'percentage';
  const trackPlayMode = cfg.trackPlayMode ?? 'free';
  const pattern = cfg.pattern || meta.pattern || '';

  const norm = normalizeTracksMedia(gdRaw);
  const allCps = norm.checkpoints;
  // Honour any per-team route override (Add-Team), else the launch default.
  const routeKey = meta[`route:${team.id}`] || cfg.route || 'default';
  const routeCps = checkpointsForRoute(allCps, routeKey);

  // Reconstruct which route checkpoints this team actually reached from their
  // stored punches. Mirrors TracksGamePage's clues found-set computation; on any
  // failure we fall back to "all missing" (empty set).
  const found = new Set<string>();
  try {
    const stations = await patternStore.getTracksCheckpointStations(pattern);
    const chips = chipIdsForTeam({ key_id: team.key_id, team_name: team.team_name ?? '' }, parseTeamsConfig(meta));
    const records = rawRecordsFromState(rawRows).filter(
      (r) => r.raw_data?.id != null && chips.has(Number(r.raw_data.id)),
    );
    const punches = livePunchesForTeam(records, team.start_time, team.end_time);
    const numberOf = (cp: TracksCheckpoint) => allCps.findIndex((c) => c.id === cp.id) + 1;
    const hitSlotByCp = firstSlotByCheckpoint(routeCps, numberOf, stations, punches);
    if (trackPlayMode === 'itinerary') {
      for (const id of orderedHitCheckpointIds(routeCps, hitSlotByCp).hitIds) found.add(id);
    } else {
      for (const cp of routeCps) if (hitSlotByCp.get(cp.id) !== undefined) found.add(cp.id);
    }
  } catch (err) {
    console.error('[teamSummary] tracks found-set error:', err);
  }

  const checkpoints: TeamSummaryCheckpoint[] = routeCps.map((cp) => ({
    id: cp.id,
    title: cp.title as TeamSummaryCheckpoint['title'],
    description: cp.description as TeamSummaryCheckpoint['description'],
    // Mirrors TracksGamePage.resolveCheckpointImage: a single shared image when
    // checkpoints_unique_image, else the checkpoint's own image.
    image: norm.checkpoints_unique_image
      ? norm.images.checkpoints_unique_image_id || ''
      : norm.checkpointImages[cp.id] || '',
    found: found.has(cp.id),
  }));

  const durationSec = team.start_time && team.end_time ? team.end_time - team.start_time : 0;
  const score = team.score ?? 0;
  return {
    gameType: 'tracks',
    launchedGameId: game.id,
    scenarioUniqid: game.game_uniqid,
    teamName: team.team_name ?? '',
    language,
    backgroundImage: norm.images.background_image || '',
    scoreText: scoreType === 'percentage' ? `${Math.round(score)}%` : `${Math.round(score)} pts`,
    timerText: formatTime(durationSec),
    showScore: norm.showScore,
    missingCheckpointImage: norm.images.missing_checkpoint_image || '',
    clues: {
      show_image: cfg.cluesPage?.show_image !== false,
      show_title: cfg.cluesPage?.show_title !== false,
      show_text: cfg.cluesPage?.show_text !== false,
    },
    checkpoints,
    autoReset: norm.autoReset,
    autoResetSeconds: TRACKS_AUTO_RESET_SECONDS,
  };
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
