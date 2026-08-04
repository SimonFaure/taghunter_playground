import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Film, Image as ImageIcon, Play, RefreshCw, FolderOpen, X, Subtitles } from 'lucide-react';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import * as scenarioStore from '../services/scenarioStore';
import * as gameTypesStore from '../services/gameTypesStore';
import { resolveVideosByKind } from '../services/videoResolution';
import { loadConfig, saveConfig } from '../utils/config';
import { LANG_NAMES } from '../services/langFlags';
import { scenarioAssetUrl, mediaRootAbs, ensureDir } from '../services/contentFs';
import { gameTypeLabel } from '../utils/labels';
import { GameTypeIcon } from './icons/GameTypeIcons';
import { ScenarioThumbnail } from './ScenarioThumbnail';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

// Every image file a downloaded scenario holds - game_visual, background, quest
// / enigma / checkpoint / podium / level images, etc. Read from the scenario's
// active manifest (scenario_files), filtering by image extension on the
// rel_path. The rel_paths are exactly what scenarioAssetUrl resolves per-request
// through the manifest into the blob pool.
async function listScenarioImagePaths(uniqid: string): Promise<string[]> {
  const paths = await scenarioStore.listManifestPaths(uniqid);
  const out = paths.filter((p) => p !== 'game-data.json' && IMAGE_EXT.test(p));
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

// These two tabs are only mounted when their tab is selected in the settings
// nav, so all media discovery (and the <video>/<img> loads) happen lazily on
// access.

function Panel({
  icon,
  title,
  headerExtra,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="pg-panel p-6 mb-6">
      <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-xl font-semibold">{title}</h2>
        </div>
        {headerExtra}
      </div>
      {children}
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <Panel icon={<Film className="text-[var(--pg-accent-bright)]" size={24} />} title={text}>
      <div className="flex items-center justify-center py-10">
        <RefreshCw className="w-8 h-8 text-[var(--pg-text-dim)] animate-spin" />
      </div>
    </Panel>
  );
}

// Resolve a scenario's cover image (game_visual, falling back to background)
// to a webview URL - used as a video poster / thumbnail.
async function scenarioCoverUrl(uniqid: string): Promise<string | null> {
  const gd = (await scenarioStore.getGameData(uniqid).catch(() => null)) as
    | { game_media_images?: Record<string, unknown> }
    | null;
  const mi = gd?.game_media_images;
  const raw = mi?.game_visual ?? mi?.background_image;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const fileName = raw.startsWith('media/') ? raw.slice('media/'.length) : raw;
  return scenarioAssetUrl(uniqid, fileName) || null;
}

// ─────────────────────────────────────────────────────────────── Videos ──

interface VideoItem {
  key: string;
  title: string;
  gameType: string;
  videoUrl: string;
  posterUrl: string | null;
  // All available subtitle tracks, keyed by language code → local webview URL.
  subtitles: Record<string, string>;
}

function VideoCard({ item, appLang, useSubsDefault }: { item: VideoItem; appLang: string; useSubsDefault: boolean }) {
  const { t } = useTranslation('cards');
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const subtitleLangs = Object.keys(item.subtitles);
  const [selectedLang, setSelectedLang] = useState<string | null>(
    useSubsDefault && item.subtitles[appLang] ? appLang : null
  );

  // Re-derive the default selection when the app language or pref changes.
  useEffect(() => {
    setSelectedLang(useSubsDefault && item.subtitles[appLang] ? appLang : null);
  }, [appLang, useSubsDefault, item.subtitles]);

  // Show only the chosen subtitle track on the underlying <video>.
  const applyTrack = useCallback((lang: string | null) => {
    const el = videoRef.current;
    if (!el) return;
    for (let i = 0; i < el.textTracks.length; i++) {
      const tr = el.textTracks[i];
      tr.mode = lang && tr.language === lang ? 'showing' : 'disabled';
    }
  }, []);

  useEffect(() => { if (playing) applyTrack(selectedLang); }, [playing, selectedLang, applyTrack]);

  return (
    <div className="rounded-[var(--pg-radius-md)] border border-[var(--pg-line)] bg-[var(--pg-surface-2)] overflow-hidden">
      <div className="relative w-full aspect-video bg-black">
        {playing ? (
          // preload only happens now (on click), and autoPlay starts it.
          <video
            ref={videoRef}
            controls
            autoPlay
            className="w-full h-full bg-black"
            onLoadedMetadata={() => applyTrack(selectedLang)}
          >
            <source src={item.videoUrl} />
            {subtitleLangs.map((lang) => (
              <track
                key={lang}
                kind="subtitles"
                srcLang={lang}
                label={LANG_NAMES[lang] || lang}
                src={item.subtitles[lang]}
              />
            ))}
          </video>
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            className="group absolute inset-0 w-full h-full"
            aria-label={item.title}
          >
            {/* Cover image when present, else the game-type icon placeholder. */}
            <ScenarioThumbnail imageUrl={item.posterUrl} gameTypeName={item.gameType} title={item.title} />
            <span className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
              <span className="flex items-center justify-center w-14 h-14 rounded-full bg-black/60 text-white">
                <Play className="w-6 h-6 ml-0.5" />
              </span>
            </span>
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 p-3 min-w-0">
        <GameTypeIcon type={item.gameType} className="w-4 h-4 text-[var(--pg-text-dim)] shrink-0" />
        <span className="font-medium truncate">{item.title}</span>
        {playing && subtitleLangs.length > 0 && (
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <Subtitles className="w-4 h-4 text-[var(--pg-text-dim)]" />
            <select
              value={selectedLang ?? 'off'}
              onChange={(e) => setSelectedLang(e.target.value === 'off' ? null : e.target.value)}
              aria-label={t('subtitles')}
              className="bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded px-1.5 py-0.5 text-sm"
            >
              <option value="off">{t('subtitlesOff')}</option>
              {subtitleLangs.map((lang) => (
                <option key={lang} value={lang}>{LANG_NAMES[lang] || lang}</option>
              ))}
            </select>
          </div>
        )}
      </div>
    </div>
  );
}

export function VideosTab() {
  const { t, i18n } = useTranslation('cards');
  const lang = i18n.language || 'fr';
  const [loading, setLoading] = useState(true);
  const [gameTypeVideos, setGameTypeVideos] = useState<VideoItem[]>([]);
  const [scenarioVideos, setScenarioVideos] = useState<VideoItem[]>([]);
  const [useSubsDefault, setUseSubsDefault] = useState(true);

  useEffect(() => {
    loadConfig()
      .then((c) => setUseSubsDefault(c.useSubtitlesByDefault !== false))
      .catch(() => {});
  }, []);

  const toggleSubsDefault = async (v: boolean) => {
    setUseSubsDefault(v);
    try {
      const c = await loadConfig();
      await saveConfig({ ...c, useSubtitlesByDefault: v });
    } catch (e) {
      console.error('[media] save subtitle pref failed:', e);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // Default game-type tutorial videos (admin default or client override).
        // No cover art for these - VideoCard falls back to the game-type icon.
        const gts = await gameTypesStore.listGameTypes();
        const gtOut: VideoItem[] = [];
        for (const gt of gts) {
          const resolved = await gameTypesStore.resolveTutorialVideoUrl(gt.code).catch(() => null);
          if (resolved) {
            gtOut.push({
              key: gt.code,
              title: gameTypeLabel(gt.name || gt.code),
              gameType: gt.code,
              videoUrl: resolved.videoUrl,
              posterUrl: null,
              subtitles: resolved.subtitleUrls,
            });
          }
        }

        // Scenario intro videos (downloaded scenarios only), with the scenario
        // cover image as the thumbnail.
        const scenarios = await scenarioStore.list({ downloaded: true });
        const scOut: VideoItem[] = [];
        for (const s of scenarios) {
          const vids = await resolveVideosByKind(['intro'], s.uniqid, s.game_type, lang).catch(() => []);
          const intro = vids.find((v) => v.kind === 'intro');
          if (intro) {
            scOut.push({
              key: s.uniqid,
              title: s.title,
              gameType: s.game_type,
              videoUrl: intro.videoUrl,
              posterUrl: await scenarioCoverUrl(s.uniqid).catch(() => null),
              subtitles: intro.subtitles,
            });
          }
        }

        if (cancelled) return;
        setGameTypeVideos(gtOut);
        setScenarioVideos(scOut);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lang]);

  if (loading) return <Loading text={t('loadingVideos')} />;

  return (
    <>
      <div className="pg-panel p-4 mb-6 flex items-center gap-3">
        <input
          id="useSubsDefault"
          type="checkbox"
          checked={useSubsDefault}
          onChange={(e) => toggleSubsDefault(e.target.checked)}
          className="w-4 h-4 shrink-0"
        />
        <label htmlFor="useSubsDefault" className="flex flex-col cursor-pointer">
          <span className="font-medium">{t('useSubtitlesByDefault')}</span>
          <span className="text-sm text-[var(--pg-text-dim)]">{t('useSubtitlesByDefaultDesc')}</span>
        </label>
      </div>

      <Panel icon={<Film className="text-[var(--pg-accent-bright)]" size={24} />} title={t('gameTypeVideos')}>
        {gameTypeVideos.length === 0 ? (
          <p className="text-[var(--pg-text-dim)] italic text-sm">{t('noVideosAvailable')}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {gameTypeVideos.map((v) => (
              <VideoCard key={v.key} item={v} appLang={lang} useSubsDefault={useSubsDefault} />
            ))}
          </div>
        )}
      </Panel>

      <Panel icon={<Film className="text-[var(--pg-accent-bright)]" size={24} />} title={t('scenarioVideos')}>
        {scenarioVideos.length === 0 ? (
          <p className="text-[var(--pg-text-dim)] italic text-sm">{t('noVideosAvailable')}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {scenarioVideos.map((v) => (
              <VideoCard key={v.key} item={v} appLang={lang} useSubsDefault={useSubsDefault} />
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}

// ─────────────────────────────────────────────────────────────── Images ──

const IMAGE_PREVIEW_COUNT = 4;

interface ScenarioImageItem {
  url: string;
  relPath: string; // path relative to the scenario version dir, e.g. 'images/enigma_1.png'
}

interface ScenarioImages {
  uniqid: string;
  title: string;
  gameType: string;
  version: number;
  images: ScenarioImageItem[];
}

// The image being viewed in the lightbox - carries enough to reveal its file.
interface LightboxImage {
  uniqid: string;
  version: number;
  relPath: string;
  url: string;
  title: string;
}

function ImageLightbox({ item, onClose }: { item: LightboxImage | null; onClose: () => void }) {
  const { t } = useTranslation('cards');
  if (!item) return null;

  const openContainingFolder = async () => {
    try {
      // The file is a content-addressed blob (hash-named, no extension);
      // reveal it in the shared pool folder.
      const blobAbs = await scenarioStore.getMediaBlobAbs(item.uniqid, item.relPath);
      if (!blobAbs) return;
      await revealItemInDir(blobAbs);
    } catch (err) {
      console.error('[media] reveal in folder failed:', err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="max-w-5xl w-full max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 mb-3 text-white">
          <span className="text-sm truncate min-w-0">
            <span className="font-medium">{item.title}</span>
            <span className="opacity-70"> · {item.relPath}</span>
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={openContainingFolder}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--pg-radius-md)] bg-white/10 hover:bg-white/20 text-sm transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              {t('openContainingFolder')}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-[var(--pg-radius-md)] bg-white/10 hover:bg-white/20 transition-colors"
              aria-label={t('cancel')}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <img src={item.url} alt="" className="max-w-full max-h-[80vh] object-contain mx-auto rounded-[var(--pg-radius-md)]" />
      </div>
    </div>
  );
}

function ImageGroupView({
  group,
  onOpen,
}: {
  group: ScenarioImages;
  onOpen: (img: LightboxImage) => void;
}) {
  const { t } = useTranslation('cards');
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? group.images : group.images.slice(0, IMAGE_PREVIEW_COUNT);
  const hiddenCount = group.images.length - IMAGE_PREVIEW_COUNT;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2 min-w-0">
        <GameTypeIcon type={group.gameType} className="w-4 h-4 text-[var(--pg-text-dim)] shrink-0" />
        <span className="font-medium truncate">{group.title}</span>
        <span className="text-xs text-[var(--pg-text-dim)] shrink-0">
          · {t('imageCount', { count: group.images.length })}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {visible.map((img) => (
          <button
            key={img.relPath}
            type="button"
            onClick={() =>
              onOpen({
                uniqid: group.uniqid,
                version: group.version,
                relPath: img.relPath,
                url: img.url,
                title: group.title,
              })
            }
            className="block rounded-[var(--pg-radius-md)] border border-[var(--pg-line)] overflow-hidden bg-[var(--pg-surface-2)]"
          >
            <img
              src={img.url}
              loading="lazy"
              alt=""
              className="w-full aspect-video object-cover hover:opacity-90 transition"
            />
          </button>
        ))}
      </div>
      {group.images.length > IMAGE_PREVIEW_COUNT && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-sm text-[var(--pg-accent-bright)] hover:underline"
        >
          {expanded ? t('showLess') : t('seeMore', { count: hiddenCount })}
        </button>
      )}
    </div>
  );
}

export function ImagesTab() {
  const { t } = useTranslation('cards');
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<ScenarioImages[]>([]);
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const scenarios = await scenarioStore.list({ downloaded: true });
        const out: ScenarioImages[] = [];
        for (const s of scenarios) {
          if (s.local_version == null) continue;
          const paths = await listScenarioImagePaths(s.uniqid).catch(() => []);
          const images: ScenarioImageItem[] = paths
            .map((rel) => ({ url: scenarioAssetUrl(s.uniqid, rel), relPath: rel }))
            .filter((i): i is ScenarioImageItem => !!i.url);
          if (images.length) {
            out.push({ uniqid: s.uniqid, title: s.title, gameType: s.game_type, version: s.local_version, images });
          }
        }
        if (cancelled) return;
        setGroups(out);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openScenariosFolder = async () => {
    try {
      // Scenario media is now pooled by content hash under media/blobs; open
      // the media root so the operator can still browse on disk. On a fresh
      // install (or before any scenario is downloaded) the folder doesn't
      // exist yet and openPath would throw silently, so create it first.
      await ensureDir('media');
      await openPath(await mediaRootAbs());
    } catch (err) {
      console.error('[media] open media folder failed:', err);
    }
  };

  if (loading) return <Loading text={t('loadingImages')} />;

  return (
    <>
      <Panel
        icon={<ImageIcon className="text-[var(--pg-accent-bright)]" size={24} />}
        title={t('imagesTitle')}
        headerExtra={
          <button type="button" onClick={openScenariosFolder} className="pg-btn pg-btn--ghost pg-btn--sm">
            <FolderOpen className="w-4 h-4" />
            <span>{t('openScenariosFolder')}</span>
          </button>
        }
      >
        {groups.length === 0 ? (
          <p className="text-[var(--pg-text-dim)] italic text-sm">{t('noImagesAvailable')}</p>
        ) : (
          <div className="space-y-6">
            {groups.map((g) => (
              <ImageGroupView key={g.uniqid} group={g} onOpen={setLightbox} />
            ))}
          </div>
        )}
      </Panel>

      <ImageLightbox item={lightbox} onClose={() => setLightbox(null)} />
    </>
  );
}
