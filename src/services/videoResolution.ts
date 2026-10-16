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

// Resolve every scenario-intro subtitle track on disk. Subtitle filenames are
// keyed `scenario_video_subtitle_<lang>` in the studio's sound bucket, which
// reaches the device under different names depending on the source:
//   - cloud sync : `game_sounds` {key: filename} (the studio's medias.sounds)
//   - ZIP import : `medias.sounds`, {key: filename} or [{sound_type, sound_file}]
//   - inline     : `game_meta.<key>` (types that keep media on game_meta)
// with or without the legacy `{ game_data: ... }` envelope.
export async function collectIntroSubtitleUrls(
  rawGameData: unknown,
  gameUniqid: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [lang, file] of Object.entries(introSubtitleFiles(rawGameData))) {
    const url = await scenarioStore.getMediaPath(gameUniqid, file).catch(() => null);
    if (url) out[lang] = url;
  }
  return out;
}

// The intro subtitle tracks a scenario DECLARES ({lang: filename}), whether or
// not the files are on this device.
function introSubtitleFiles(rawGameData: unknown): Record<string, string> {
  const PREFIX = 'scenario_video_subtitle_';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = rawGameData as any;
  const root = raw?.game_data ?? raw;
  const files: Record<string, string> = {};
  const take = (key: unknown, value: unknown) => {
    if (typeof key !== 'string' || !key.startsWith(PREFIX)) return;
    if (typeof value !== 'string' || !value) return;
    const lang = key.slice(PREFIX.length);
    if (!files[lang]) files[lang] = value;
  };
  for (const bucket of [root?.game_sounds, root?.medias?.sounds, raw?.medias?.sounds, root?.game_meta]) {
    if (Array.isArray(bucket)) {
      for (const s of bucket) take(s?.sound_type, s?.sound_file);
    } else if (bucket && typeof bucket === 'object') {
      for (const [key, value] of Object.entries(bucket)) take(key, value);
    }
  }
  return files;
}

// What the operator picked for subtitles when pushing a video:
//   undefined - no opinion, each device keeps its own default (app language +
//               the "use subtitles by default" preference);
//   'off'     - no subtitles;
//   '<lang>'  - that language. A video with no track for it plays without
//               subtitles rather than falling back to another language.
export type SubtitleChoice = string | undefined;

// Picker value for "no opinion" (see <VideoSubtitlePicker>); 'off' and language
// codes are sent as-is.
export const SUBTITLE_AUTO = 'auto';

export function subtitlePickOf(pickerValue: string): SubtitleChoice {
  return pickerValue === SUBTITLE_AUTO ? undefined : pickerValue;
}

export function applySubtitleChoice(sources: VideoSource[], choice: SubtitleChoice): VideoSource[] {
  if (!choice) return sources;
  return sources.map((v) => ({
    ...v,
    defaultSubtitleLang: choice !== 'off' && v.subtitles[choice] ? choice : null,
  }));
}

type IntroGameData = {
  scenario_video?: unknown;
  game_meta?: { scenario_video?: unknown };
  medias?: { video?: unknown; sounds?: Record<string, string> };
} | null;

// Same probing chain as the first-bip flow - handles legacy data shapes
// (top-level scenario_video, nested game_meta, or medias.video). Returns the
// bare filename, or null when the scenario declares no intro video.
function introFilenameOf(rawGameData: IntroGameData): string | null {
  const introFilename =
    rawGameData?.scenario_video
    ?? rawGameData?.game_meta?.scenario_video
    ?? rawGameData?.medias?.video;
  if (typeof introFilename !== 'string' || introFilename.trim().length === 0) return null;
  return introFilename.split('/').filter(Boolean).pop() ?? introFilename;
}

// Which video kinds this game DECLARES, read from synced metadata only (the
// scenario's game-data + the game-type rows) - no file has to be on disk here.
// That's the question to ask before PUSHING a video to another device: an
// operator-only device (tablet) syncs the metadata but never the video files,
// and the target resolves the actual file itself with resolveVideosByKind().
//
// `subtitleLangs` lists the subtitle languages those videos declare, per kind,
// so the operator can pick one to push along (same metadata-only rule).
export async function declaredVideoKinds(
  gameUniqid: string,
  gameTypeCode: string,
): Promise<{
  intro: boolean;
  tutorial: boolean;
  subtitleLangs: { intro: string[]; tutorial: string[] };
}> {
  const rawGameData = (await scenarioStore.getGameData(gameUniqid).catch(() => null)) as IntroGameData;
  const code = gameTypeCode.toLowerCase();
  const [override, admin] = await Promise.all([
    gameTypesStore.getOverride(code).catch(() => null),
    gameTypesStore.getGameType(code).catch(() => null),
  ]);
  const intro = introFilenameOf(rawGameData) !== null;
  // Same precedence as resolveTutorialVideoUrl: the client's own video (and
  // its tracks) wins over the Tag Hunter default.
  const tutorialRow = override?.tutorial_video_filename
    ? override
    : admin?.tutorial_video_filename
      ? admin
      : null;
  return {
    intro,
    tutorial: tutorialRow !== null,
    subtitleLangs: {
      intro: intro ? Object.keys(introSubtitleFiles(rawGameData)) : [],
      tutorial: tutorialRow ? Object.keys(tutorialRow.tutorial_subtitles) : [],
    },
  };
}

// Every subtitle language the game's videos declare (tutorial + intro merged),
// sorted - what a subtitle picker offers.
export async function declaredSubtitleLangs(
  gameUniqid: string,
  gameTypeCode: string,
): Promise<string[]> {
  const { subtitleLangs } = await declaredVideoKinds(gameUniqid, gameTypeCode);
  return Array.from(new Set([...subtitleLangs.tutorial, ...subtitleLangs.intro])).sort();
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
  const rawGameData = (await scenarioStore.getGameData(gameUniqid).catch(() => null)) as IntroGameData;
  const lang = language || 'en';

  for (const kind of kinds) {
    if (kind === 'intro') {
      const bare = introFilenameOf(rawGameData);
      if (bare) {
        const url = await scenarioStore.getMediaPath(gameUniqid, bare).catch(() => null);
        if (url) {
          const subtitles = await collectIntroSubtitleUrls(rawGameData, gameUniqid);
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
