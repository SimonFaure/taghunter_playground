import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Subtitles } from 'lucide-react';
import { LANG_NAMES } from '../services/langFlags';
import type { VideoSource } from '../services/videoResolution';

// Fullscreen overlay shown when a team scans their first tag. Plays the
// scenario intro video first (if enabled and present), then the game-type
// tutorial video (if enabled and present). Players cannot skip - only
// the operator can, via a hidden 4-tap gesture in the top-right corner
// followed by a confirm prompt.
//
// When all enabled videos have finished, `onComplete` fires and the parent
// (MysteryGamePage) records `team.start_time` and resumes normal play.

interface FirstBipVideoOverlayProps {
  videos: VideoSource[];
  onComplete: () => void;
}

// Window of time inside which the 4 taps in the top-right corner must
// happen for the skip gesture to trigger.
const TAP_WINDOW_MS = 3000;

// Side length (in pixels) of the invisible hit zone in the top-right
// corner of the overlay. Sized to be a comfortable thumb target on a
// tablet while remaining un-discoverable by players.
const TAP_ZONE_PX = 96;

export function FirstBipVideoOverlay({ videos, onComplete }: FirstBipVideoOverlayProps) {
  const { t } = useTranslation('cards');
  const [index, setIndex] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // null = subtitles off. Initialised per-video from defaultSubtitleLang below.
  const [selectedLang, setSelectedLang] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const tapTimestamps = useRef<number[]>([]);

  // Edge case: if the parent mounts the overlay with zero enabled videos,
  // resolve immediately. The MysteryGamePage trigger already guards against
  // this; double-checking keeps the component well-behaved in isolation.
  useEffect(() => {
    if (videos.length === 0) onComplete();
  }, [videos.length, onComplete]);

  const current = videos[index] ?? null;
  const subtitleLangs = current ? Object.keys(current.subtitles) : [];

  // Reset the chosen subtitle to the current video's default whenever the
  // video advances.
  useEffect(() => {
    setSelectedLang(current?.defaultSubtitleLang ?? null);
  }, [current]);

  // Show only the chosen subtitle track on the underlying <video>; disable
  // the rest. Re-applied when the selection or the video changes.
  const applyTrack = useCallback((lang: string | null) => {
    const el = videoRef.current;
    if (!el) return;
    for (let i = 0; i < el.textTracks.length; i++) {
      const tr = el.textTracks[i];
      tr.mode = lang && tr.language === lang ? 'showing' : 'disabled';
    }
  }, []);

  useEffect(() => { applyTrack(selectedLang); }, [selectedLang, index, applyTrack]);

  const handleEnded = useCallback(() => {
    if (index + 1 >= videos.length) {
      onComplete();
    } else {
      setIndex((i) => i + 1);
    }
  }, [index, videos.length, onComplete]);

  const handleTapZoneClick = () => {
    const now = Date.now();
    tapTimestamps.current = [...tapTimestamps.current, now].filter(
      (t) => now - t <= TAP_WINDOW_MS
    );
    if (tapTimestamps.current.length >= 4) {
      tapTimestamps.current = [];
      setConfirmOpen(true);
    }
  };

  const confirmSkip = () => {
    setConfirmOpen(false);
    handleEnded();
  };

  // The `key` prop on the <video> element remounts it whenever the source
  // changes, so we get a fresh element with a fresh <source>/<track> on
  // every index advance - no manual load() needed. Calling load() here
  // would abort the autoPlay attribute's already-in-flight play() promise
  // and surface as a noisy AbortError.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    void el.play().catch((err) => {
      const name = (err as Error | null)?.name;
      // AbortError: typically a stale promise from a previous remount -
      // benign. NotAllowedError: browser blocked autoplay without a user
      // gesture - also nothing we can do here.
      if (name === 'AbortError' || name === 'NotAllowedError') return;
      console.warn('[FirstBipVideoOverlay] play rejected:', err);
    });
  }, [index]);

  if (!current) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-black flex items-center justify-center">
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        autoPlay
        controls={false}
        playsInline
        onEnded={handleEnded}
        onLoadedMetadata={() => applyTrack(selectedLang)}
        key={`${current.videoUrl}-${index}`}
      >
        <source src={current.videoUrl} />
        {subtitleLangs.map((lang) => (
          <track
            key={lang}
            kind="subtitles"
            srcLang={lang}
            label={LANG_NAMES[lang] || lang}
            src={current.subtitles[lang]}
          />
        ))}
      </video>

      {/* Invisible 4-tap admin escape hatch. Positioned in the top-right
          corner; not visually decorated so players don't discover it. */}
      <button
        type="button"
        aria-label="Admin escape - tap 4 times to skip"
        onClick={handleTapZoneClick}
        className="absolute top-0 right-0 bg-transparent border-0 cursor-default"
        style={{ width: TAP_ZONE_PX, height: TAP_ZONE_PX }}
      />

      {/* Subtitle selector (only when this video has subtitle tracks). */}
      {subtitleLangs.length > 0 && (
        <div className="absolute bottom-6 left-6 flex items-center gap-2 text-white/80 text-sm bg-black/50 px-3 py-1.5 rounded-full">
          <Subtitles className="w-4 h-4" />
          <select
            value={selectedLang ?? 'off'}
            onChange={(e) => setSelectedLang(e.target.value === 'off' ? null : e.target.value)}
            className="bg-transparent text-white text-sm outline-none cursor-pointer [&>option]:text-black"
            aria-label={t('subtitles')}
          >
            <option value="off">{t('subtitlesOff')}</option>
            {subtitleLangs.map((lang) => (
              <option key={lang} value={lang}>{LANG_NAMES[lang] || lang}</option>
            ))}
          </select>
        </div>
      )}

      {/* Bottom bar: video index. */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-white/60 text-sm bg-black/40 px-3 py-1 rounded-full">
        {index + 1} / {videos.length} - {current.kind === 'intro' ? 'Intro' : 'Tutorial'}
      </div>

      {/* Visible skip control. Opens the confirm prompt so a stray player tap
          can't drop the video; the hidden 4-tap gesture above still works too. */}
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        className="absolute bottom-6 right-6 text-white/70 hover:text-white text-sm bg-black/40 hover:bg-black/60 px-4 py-2 rounded-full transition"
      >
        {t('skipVideo')} ⏭
      </button>

      {confirmOpen && (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 max-w-md space-y-4">
            <h3 className="text-lg font-semibold text-white">{t('skipVideoTitle')}</h3>
            <p className="text-sm text-slate-300">{t('skipVideoBody')}</p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 text-sm bg-slate-700 text-white rounded-lg hover:bg-slate-600"
              >
                {t('cancel')}
              </button>
              <button
                onClick={confirmSkip}
                className="px-4 py-2 text-sm bg-rose-600 text-white rounded-lg hover:bg-rose-700"
              >
                {t('skipVideoConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
