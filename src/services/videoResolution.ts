// Shared video resolution for both the first-bip flow and operator-triggered
// playback. Given a list of `kinds` ('intro'|'tutorial'), the scenario id,
// the game-type code, and a language code, returns a VideoSource[] suitable
// for <FirstBipVideoOverlay>. Sources whose underlying asset is missing
// silently drop out of the list — the overlay simply plays whatever was
// resolvable.

import * as scenarioStore from './scenarioStore';
import * as gameTypesStore from './gameTypesStore';

export interface VideoSource {
  kind: 'intro' | 'tutorial';
  videoUrl: string;
  subtitleLang: string | null;
  subtitleUrl: string | null;
}

export async function resolveVideosByKind(
  kinds: Array<'intro' | 'tutorial'>,
  gameUniqid: string,
  gameTypeCode: string,
  language: string
): Promise<VideoSource[]> {
  const out: VideoSource[] = [];
  const rawGameData = (await scenarioStore.getGameData(gameUniqid).catch(() => null)) as
    | { scenario_video?: unknown; game_meta?: { scenario_video?: unknown }; medias?: { video?: unknown; sounds?: Record<string, string> } }
    | null;
  const lang = language || 'en';

  for (const kind of kinds) {
    if (kind === 'intro') {
      // Same probing chain as the first-bip flow — handles legacy data
      // shapes (top-level scenario_video, nested game_meta, or medias.video).
      const introFilename =
        rawGameData?.scenario_video
        ?? rawGameData?.game_meta?.scenario_video
        ?? rawGameData?.medias?.video;
      if (typeof introFilename === 'string' && introFilename.trim().length > 0) {
        const bare = introFilename.split('/').filter(Boolean).pop() ?? introFilename;
        const url = await scenarioStore.getMediaPath(gameUniqid, bare).catch(() => null);
        if (url) {
          const subtitleField = `scenario_video_subtitle_${lang}`;
          const subFilename = rawGameData?.medias?.sounds?.[subtitleField];
          let subUrl: string | null = null;
          if (typeof subFilename === 'string' && subFilename) {
            subUrl = (await scenarioStore.getMediaPath(gameUniqid, subFilename).catch(() => null)) ?? null;
          }
          out.push({ kind: 'intro', videoUrl: url, subtitleLang: lang, subtitleUrl: subUrl });
        }
      }
    } else if (kind === 'tutorial') {
      const resolved = await gameTypesStore.resolveTutorialVideoUrl(gameTypeCode).catch(() => null);
      if (resolved) {
        const subUrl = resolved.subtitleUrls[lang] ?? null;
        out.push({
          kind: 'tutorial',
          videoUrl: resolved.videoUrl,
          subtitleLang: lang,
          subtitleUrl: subUrl,
        });
      }
    }
  }

  return out;
}
