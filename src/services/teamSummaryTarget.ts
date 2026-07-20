/**
 * A self-contained snapshot of a finished team's "final summary", pushed to a
 * specific paired device (the `show_team_summary` LAN command) and rendered
 * there by <TeamSummaryOverlay>. Everything needed to render is carried inline;
 * images are RELATIVE scenario paths the target resolves locally via
 * `scenarioAssetUrl()` (so the bytes never travel over the wire).
 *
 * Only mystery + tracks have a per-team final page - see
 * `buildTeamSummarySnapshot` (services/teamSummary.ts). Mirrors the encode/decode
 * shape of `rankingTarget.ts` (the leaderboard equivalent).
 */

type Localizedish = Record<string, string> | string | null | undefined;

export interface TeamSummaryCheckpoint {
  id: string;
  title: Localizedish;
  description: Localizedish;
  /** Relative path to the checkpoint's own image ('' if none). */
  image: string;
  found: boolean;
}

/** Whether the pushed summary auto-dismisses, mirroring the game's "auto-reset
 *  page" option, and after how many seconds. Lets a device showing this over
 *  its in-game screen fall back to the game on its own. */
interface AutoResetFields {
  autoReset: boolean;
  autoResetSeconds: number;
}

export type TeamSummarySnapshot =
  | ({
      gameType: 'mystery';
      launchedGameId: number;
      scenarioUniqid: string;
      teamName: string;
      language: string;
      /** Relative path; '' → black background. */
      backgroundImage: string;
      finalScoreText: string;
      levelName?: string;
      levelDescription?: string;
      /** game_meta.level_font_color, so the level line matches the in-game panel. */
      levelFontColor?: string;
    } & AutoResetFields)
  | ({
      gameType: 'tracks';
      launchedGameId: number;
      scenarioUniqid: string;
      teamName: string;
      language: string;
      backgroundImage: string;
      scoreText: string;
      timerText: string;
      showScore: boolean;
      /** Relative path to the "not found" image ('' if none). */
      missingCheckpointImage: string;
      clues: { show_image: boolean; show_title: boolean; show_text: boolean };
      checkpoints: TeamSummaryCheckpoint[];
    } & AutoResetFields);

/** Serialize a snapshot into a flat command payload (JSON-safe). */
export function encodeTeamSummarySnapshot(s: TeamSummarySnapshot): Record<string, unknown> {
  if (s.gameType === 'mystery') {
    return {
      game_type: 'mystery',
      launched_game_id: s.launchedGameId,
      scenario_uniqid: s.scenarioUniqid,
      team_name: s.teamName,
      language: s.language,
      background_image: s.backgroundImage,
      final_score_text: s.finalScoreText,
      level_name: s.levelName ?? '',
      level_description: s.levelDescription ?? '',
      level_font_color: s.levelFontColor ?? '',
      auto_reset: s.autoReset,
      auto_reset_seconds: s.autoResetSeconds,
    };
  }
  return {
    game_type: 'tracks',
    launched_game_id: s.launchedGameId,
    scenario_uniqid: s.scenarioUniqid,
    team_name: s.teamName,
    language: s.language,
    background_image: s.backgroundImage,
    score_text: s.scoreText,
    timer_text: s.timerText,
    show_score: s.showScore,
    missing_checkpoint_image: s.missingCheckpointImage,
    clues: s.clues,
    checkpoints: s.checkpoints,
    auto_reset: s.autoReset,
    auto_reset_seconds: s.autoResetSeconds,
  };
}

/** Parse a snapshot back from a command payload. Returns null when malformed. */
export function decodeTeamSummarySnapshot(raw: unknown): TeamSummarySnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const scenarioUniqid = typeof p.scenario_uniqid === 'string' ? p.scenario_uniqid : '';
  if (!scenarioUniqid) return null;
  const lgid = Number(p.launched_game_id);
  const asec = Number(p.auto_reset_seconds);
  const common = {
    launchedGameId: Number.isFinite(lgid) ? lgid : 0,
    scenarioUniqid,
    teamName: typeof p.team_name === 'string' ? p.team_name : '',
    language: typeof p.language === 'string' ? p.language : '',
    backgroundImage: typeof p.background_image === 'string' ? p.background_image : '',
    autoReset: !!p.auto_reset,
    autoResetSeconds: Number.isFinite(asec) && asec > 0 ? asec : 0,
  };

  if (p.game_type === 'mystery') {
    return {
      gameType: 'mystery',
      ...common,
      finalScoreText: typeof p.final_score_text === 'string' ? p.final_score_text : '',
      levelName: typeof p.level_name === 'string' && p.level_name ? p.level_name : undefined,
      levelDescription:
        typeof p.level_description === 'string' && p.level_description ? p.level_description : undefined,
      levelFontColor:
        typeof p.level_font_color === 'string' && p.level_font_color ? p.level_font_color : undefined,
    };
  }

  if (p.game_type === 'tracks') {
    const cluesRaw = (p.clues ?? {}) as Record<string, unknown>;
    const checkpoints: TeamSummaryCheckpoint[] = Array.isArray(p.checkpoints)
      ? (p.checkpoints as unknown[]).map((c) => {
          const cc = (c ?? {}) as Record<string, unknown>;
          return {
            id: String(cc.id ?? ''),
            title: (cc.title ?? '') as Localizedish,
            description: (cc.description ?? '') as Localizedish,
            image: typeof cc.image === 'string' ? cc.image : '',
            found: !!cc.found,
          };
        })
      : [];
    return {
      gameType: 'tracks',
      ...common,
      scoreText: typeof p.score_text === 'string' ? p.score_text : '',
      timerText: typeof p.timer_text === 'string' ? p.timer_text : '',
      showScore: p.show_score !== false,
      missingCheckpointImage:
        typeof p.missing_checkpoint_image === 'string' ? p.missing_checkpoint_image : '',
      clues: {
        show_image: cluesRaw.show_image !== false,
        show_title: cluesRaw.show_title !== false,
        show_text: cluesRaw.show_text !== false,
      },
      checkpoints,
    };
  }

  return null;
}
