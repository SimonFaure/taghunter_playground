// Shared video resolution for both the first-bip flow and operator-triggered
// playback. Given a list of `kinds` ('intro'|'tutorial'), the scenario id,
// the game-type code, and a language code, returns a VideoSource[] suitable
// for <FirstBipVideoOverlay>. Sources whose underlying asset is missing
// silently drop out of the list - the overlay simply plays whatever was
// resolvable.

import * as scenarioStore from './scenarioStore';
import * as gameTypesStore from './gameTypesStore';
import { loadConfig } from '../utils/config';

export interface VideoSource {
  kind: 'intro' | 'tutorial';
  videoUrl: string;
  // All available subtitle tracks, keyed by language code → local webview URL.
  subtitles: Record<string, string>;
  // Which track to pre-select when playback starts (the app language, when a
  // subtitle exists for it and the "use subtitles by default" pref is on);
  // null = start with subtitles off.
  defaultSubtitleLang: string | null;
}

// Pick the track to show by default: the app language when present and the
// "use subtitles by default" preference is on, otherwise none.
export function pickDefaultSubtitleLang(
  subtitles: Record<string, string>,
  appLang: string,
  useByDefault: boolean,
): string | null {
  if (!useByDefault) return null;
  return subtitles[appLang] ? appLang : null;
}

// Resolve every scenario-intro subtitle track on disk. Subtitle filenames live
// in `medias.sounds` under keys like `scenario_video_subtitle_<lang>`.
export async function collectIntroSubtitleUrls(
  sounds: Record<string, string> | undefined,
  gameUniqid: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const PREFIX = 'scenario_video_subtitle_';
  for (const [key, value] of Object.entries(sounds ?? {})) {
    if (!key.startsWith(PREFIX)) continue;
    if (typeof value !== 'string' || !value) continue;
    const lang = key.slice(PREFIX.length);
    const url = await scenarioStore.getMediaPath(gameUniqid, value).catch(() => null);
    if (url) out[lang] = url;
  }
  return out;
}

export async function resolveVideosByKind(
  kinds: Array<'intro' | 'tutorial'>,
  gameUniqid: string,
  gameTypeCode: string,
  language: string
): Promise<VideoSource[]> {
  const out: VideoSource[] = [];
  const cfg = await loadConfig().catch(() => null);
  const useSubs = cfg?.useSubtitlesByDefault !== false; // default on
  const rawGameData = (await scenarioStore.getGameData(gameUniqid).catch(() => null)) as
    | { scenario_video?: unknown; game_meta?: { scenario_video?: unknown }; medias?: { video?: unknown; sounds?: Record<string, string> } }
    | null;
  const lang = language || 'en';

  for (const kind of kinds) {
    if (kind === 'intro') {
      // Same probing chain as the first-bip flow - handles legacy data
      // shapes (top-level scenario_video, nested game_meta, or medias.video).
      const introFilename =
        rawGameData?.scenario_video
        ?? rawGameData?.game_meta?.scenario_video
        ?? rawGameData?.medias?.video;
      if (typeof introFilename === 'string' && introFilename.trim().length > 0) {
        const bare = introFilename.split('/').filter(Boolean).pop() ?? introFilename;
        const url = await scenarioStore.getMediaPath(gameUniqid, bare).catch(() => null);
        if (url) {
          const subtitles = await collectIntroSubtitleUrls(rawGameData?.medias?.sounds, gameUniqid);
          out.push({
            kind: 'intro',
            videoUrl: url,
            subtitles,
            defaultSubtitleLang: pickDefaultSubtitleLang(subtitles, lang, useSubs),
          });
        }
      }
    } else if (kind === 'tutorial') {
      const resolved = await gameTypesStore.resolveTutorialVideoUrl(gameTypeCode).catch(() => null);
      if (resolved) {
        out.push({
          kind: 'tutorial',
          videoUrl: resolved.videoUrl,
          subtitles: resolved.subtitleUrls,
          defaultSubtitleLang: pickDefaultSubtitleLang(resolved.subtitleUrls, lang, useSubs),
        });
      }
    }
  }

  return out;
}
