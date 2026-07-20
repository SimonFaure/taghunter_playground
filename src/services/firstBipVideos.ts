// Shared "first-bip video" resolution, used by both MysteryGamePage and
// TracksGamePage. Given a launch config + the scenario's raw game-data, it
// returns the ordered list of <video> sources to play on a team's first bip
// (intro first, then tutorial). An empty list means the caller skips the
// overlay entirely.

import type { GameConfig } from '../components/LaunchGameModal';
import * as scenarioStore from './scenarioStore';
import * as gameTypesStore from './gameTypesStore';
import { loadConfig } from '../utils/config';
import {
  pickDefaultSubtitleLang,
  collectIntroSubtitleUrls,
  type VideoSource,
} from './videoResolution';

export type { VideoSource };

export async function resolveFirstBipVideos(
  config: GameConfig,
  gameUniqid: string,
  gameTypeCode: string,
  rawGameData: unknown,
): Promise<VideoSource[]> {
  const lang = config.language || 'en';
  const appCfg = await loadConfig().catch(() => null);
  const useSubs = appCfg?.useSubtitlesByDefault !== false; // default on
  const sources: VideoSource[] = [];

  // Intro = per-scenario scenario_video. Subtitle files live in
  // scenarios/<uniqid>/v<N>/ and are referenced from medias.sounds under
  // keys like scenario_video_subtitle_<lang>.
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
        const sounds = (rawGameData as { medias?: { sounds?: Record<string, string> } } | null)?.medias?.sounds;
        const subtitles = await collectIntroSubtitleUrls(sounds, gameUniqid);
        sources.push({
          kind: 'intro',
          videoUrl: url,
          subtitles,
          defaultSubtitleLang: pickDefaultSubtitleLang(subtitles, lang, useSubs),
        });
      }
    }
  }

  // Tutorial = game-type-level video, with override-wins resolution.
  if (config.playTutorialOnBip) {
    const resolved = await gameTypesStore.resolveTutorialVideoUrl(gameTypeCode);
    if (resolved) {
      sources.push({
        kind: 'tutorial',
        videoUrl: resolved.videoUrl,
        subtitles: resolved.subtitleUrls,
        defaultSubtitleLang: pickDefaultSubtitleLang(resolved.subtitleUrls, lang, useSubs),
      });
    }
  }

  return sources;
}
