// Shared "first-bip video" resolution, used by both MysteryGamePage and
// TracksGamePage. Given a launch config + the scenario's raw game-data, it
// returns the ordered list of <video> sources to play on a team's first bip
// (intro first, then tutorial). An empty list means the caller skips the
// overlay entirely.

import type { GameConfig } from '../components/LaunchGameModal';
import * as scenarioStore from './scenarioStore';
import * as gameTypesStore from './gameTypesStore';

export interface VideoSource {
  kind: 'intro' | 'tutorial';
  videoUrl: string;
  subtitleLang: string | null;
  subtitleUrl: string | null;
}

export async function resolveFirstBipVideos(
  config: GameConfig,
  gameUniqid: string,
  gameTypeCode: string,
  rawGameData: unknown,
): Promise<VideoSource[]> {
  const lang = config.language || 'en';
  const sources: VideoSource[] = [];

  // Intro = per-scenario scenario_video. Subtitle file lives in
  // scenarios/<uniqid>/v<N>/<scenario_video_subtitle_<lang>>.
  if (config.playIntroOnBip) {
    const introFilename =
      (rawGameData as { scenario_video?: unknown } | null)?.scenario_video
      ?? (rawGameData as { game_meta?: { scenario_video?: unknown } } | null)?.game_meta?.scenario_video
      ?? (rawGameData as { medias?: { video?: unknown } } | null)?.medias?.video;
    if (typeof introFilename === 'string' && introFilename.trim().length > 0) {
      // `medias.video` historically carries a `/media/<uniqid>/...` path; strip
      // to bare filename for local resolution.
      const bare = introFilename.split('/').filter(Boolean).pop() ?? introFilename;
      const url = await scenarioStore.getMediaPath(gameUniqid, bare);
      if (url) {
        const subtitleField = `scenario_video_subtitle_${lang}`;
        const subFilename =
          (rawGameData as { medias?: { sounds?: Record<string, string> } } | null)?.medias?.sounds?.[subtitleField];
        let subUrl: string | null = null;
        if (typeof subFilename === 'string' && subFilename) {
          subUrl = await scenarioStore.getMediaPath(gameUniqid, subFilename);
        }
        sources.push({ kind: 'intro', videoUrl: url, subtitleLang: lang, subtitleUrl: subUrl });
      }
    }
  }

  // Tutorial = game-type-level video, with override-wins resolution.
  if (config.playTutorialOnBip) {
    const resolved = await gameTypesStore.resolveTutorialVideoUrl(gameTypeCode);
    if (resolved) {
      const subUrl = resolved.subtitleUrls[lang] ?? null;
      sources.push({ kind: 'tutorial', videoUrl: resolved.videoUrl, subtitleLang: lang, subtitleUrl: subUrl });
    }
  }

  return sources;
}
