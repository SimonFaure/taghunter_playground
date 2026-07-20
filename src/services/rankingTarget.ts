import type { GameConfig } from '../components/LaunchGameModal';
import type { TimeRange } from '../components/RankingsModal';

/**
 * What a ranking view is scoped to. Shared by the three ranking actions
 * (show full page / second screen / push to device) so they all carry the
 * same descriptor:
 *   - `game`     → a single launched game's live leaderboard (the default,
 *                  chosen via the "only this launched game" toggle).
 *   - `scenario` → the cross-game leaderboard for a scenario over a time range.
 */
export type RankingTarget =
  | { mode: 'game'; launchedGameId: number; gameName: string; config: GameConfig; autoScroll?: boolean }
  | { mode: 'scenario'; scenarioUniqid: string; scenarioTitle: string; timeRange: TimeRange; autoScroll?: boolean };

/** Stable identity for a target - used to track which target the projector
 *  window is currently showing (so a re-open of the same target is a no-op). */
export function rankingTargetKey(target: RankingTarget): string {
  return target.mode === 'game'
    ? `game:${target.launchedGameId}`
    : `scenario:${target.scenarioUniqid}:${target.timeRange}`;
}

/** Serialize a target into a flat command/url payload (JSON-safe primitives). */
export function encodeRankingTarget(target: RankingTarget): Record<string, unknown> {
  if (target.mode === 'game') {
    return {
      mode: 'game',
      launched_game_id: target.launchedGameId,
      game_name: target.gameName,
      config: target.config,
      auto_scroll: target.autoScroll !== false,
    };
  }
  return {
    mode: 'scenario',
    scenario_uniqid: target.scenarioUniqid,
    scenario_title: target.scenarioTitle,
    time_range: target.timeRange,
    auto_scroll: target.autoScroll !== false,
  };
}

/** Parse a target back from a command/url payload. Returns null when malformed. */
export function decodeRankingTarget(raw: unknown): RankingTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (p.mode === 'game') {
    const id = Number(p.launched_game_id);
    if (!Number.isFinite(id) || id <= 0) return null;
    if (!p.config || typeof p.config !== 'object') return null;
    return {
      mode: 'game',
      launchedGameId: id,
      gameName: typeof p.game_name === 'string' ? p.game_name : '',
      config: p.config as GameConfig,
      autoScroll: p.auto_scroll !== false,
    };
  }
  if (p.mode === 'scenario') {
    if (typeof p.scenario_uniqid !== 'string' || !p.scenario_uniqid) return null;
    return {
      mode: 'scenario',
      scenarioUniqid: p.scenario_uniqid,
      scenarioTitle: typeof p.scenario_title === 'string' ? p.scenario_title : p.scenario_uniqid,
      timeRange: (p.time_range as TimeRange) ?? 'all',
      autoScroll: p.auto_scroll !== false,
    };
  }
  return null;
}
