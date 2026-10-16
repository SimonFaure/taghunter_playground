import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Subtitles } from 'lucide-react';
import { LANG_NAMES } from '../services/langFlags';
import type { VideoSource } from '../services/videoResolution';
import { useSubtitleBlobUrls } from '../hooks/useSubtitleBlobUrls';
import { useSubtitleCue } from '../hooks/useSubtitleCue';
import { gameClock } from '../services/gameClock';

// Fullscreen overlay shown when a team scans their first tag. Plays the
// game-type tutorial video first (if enabled and present), then the
// scenario intro video (if enabled and present). Players cannot skip - only
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

// How long the control bar stays up after the last mouse move / tap.
const CONTROLS_IDLE_MS = 3000;

// A video whose playback position has not moved for this long is skipped.
const STALL_MS = 20_000;

const NO_SUBTITLES: Record<string, string> = {};

export function FirstBipVideoOverlay({ videos, onComplete }: FirstBipVideoOverlayProps) {
  const { t } = useTranslation('cards');
  const [index, setIndex] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // null = subtitles off. Initialised per-video from defaultSubtitleLang below.
  const [selectedLang, setSelectedLang] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const tapTimestamps = useRef<number[]>([]);
  // The subtitle <select> keeps the bar up while it has focus (its native
  // dropdown swallows mouse moves).
  const [selectFocused, setSelectFocused] = useState(false);

  // Edge case: if the parent mounts the overlay with zero enabled videos,
  // resolve immediately. The MysteryGamePage trigger already guards against
  // this; double-checking keeps the component well-behaved in isolation.
  useEffect(() => {
    if (videos.length === 0) onComplete();
  }, [videos.length, onComplete]);

  const current = videos[index] ?? null;
  const subtitleLangs = current ? Object.keys(current.subtitles) : [];
  const trackUrls = useSubtitleBlobUrls(current?.subtitles ?? NO_SUBTITLES);

  // Control bar (subtitles / index / skip) stays hidden while the video
  // plays; any mouse move or tap reveals it for CONTROLS_IDLE_MS.
  const [controlsVisible, setControlsVisible] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS);
  }, []);
  useEffect(() => () => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
  }, []);

  // Reset the chosen subtitle to the current video's default whenever the
  // video advances.
  useEffect(() => {
    setSelectedLang(current?.defaultSubtitleLang ?? null);
  }, [current]);

  // The chosen track's current line, painted by us (never natively) so only
  // one subtitle can be on screen. trackUrls is in the key: the <track>
  // elements only mount once the blob URLs resolve.
  const subtitleText = useSubtitleCue(videoRef, selectedLang, `${index}|${JSON.stringify(trackUrls)}`);

  const handleEnded = useCallback(() => {
    if (index + 1 >= videos.length) {
      onComplete();
    } else {
      setIndex((i) => i + 1);
    }
  }, [index, videos.length, onComplete]);
  // The play()/watchdog effect below only re-runs per video; read the latest
  // handleEnded through a ref.
  const handleEndedRef = useRef(handleEnded);
  useEffect(() => { handleEndedRef.current = handleEnded; });

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
    // Game simulator: play at the simulation speed (browsers cap at 16x) so a
    // team's videos take as long in game time as they would for real.
    const sim = gameClock.getSim();
    // defaultPlaybackRate too: loading the source resets playbackRate to it.
    if (sim) {
      const rate = Math.min(16, Math.max(1, sim.speed));
      el.defaultPlaybackRate = rate;
      el.playbackRate = rate;
    }
    let disposed = false;
    // A video that never ends would hold the team's start (and, in Quest,
    // the whole game's start) forever: skip it instead.
    const skip = (why: string) => {
      if (disposed) return;
      disposed = true;
      console.warn(`[FirstBipVideoOverlay] ${why}, skipped:`, el.currentSrc);
      handleEndedRef.current();
    };
    void el.play().catch((err) => {
      const name = (err as Error | null)?.name;
      // AbortError: typically a stale promise from a previous remount - benign.
      if (name === 'AbortError') return;
      // NotAllowedError: autoplay blocked without a user gesture (no one has
      // touched the window yet, e.g. an unattended PC). Muted autoplay is
      // always allowed; if even that fails, skip.
      if (name === 'NotAllowedError') {
        el.muted = true;
        void el.play().catch(() => skip('autoplay blocked even muted'));
        return;
      }
      console.warn('[FirstBipVideoOverlay] play rejected:', err);
    });
    // Watchdog: no playback progress for STALL_MS (stalled source, decoder
    // error with no `error` event...) -> skip.
    let lastTime = -1;
    let lastProgressAt = Date.now();
    const watchdog = window.setInterval(() => {
      if (el.ended) return;
      if (el.currentTime !== lastTime) {
        lastTime = el.currentTime;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt > STALL_MS) {
        window.clearInterval(watchdog);
        skip('no playback progress');
      }
    }, 2000);
    return () => {
      disposed = true;
      window.clearInterval(watchdog);
    };
  }, [index]);

  if (!current) return null;

  const showControls = controlsVisible || selectFocused || confirmOpen;
  const controlsClass = `transition-opacity duration-300 ${
    showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
  }`;

  return (
    <div
      className={`fixed inset-0 z-[100] bg-black flex items-center justify-center ${showControls ? '' : 'cursor-none'}`}
      onPointerMove={revealControls}
      onPointerDown={revealControls}
    >
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        autoPlay
        controls={false}
        playsInline
        onEnded={handleEnded}
        key={`${current.videoUrl}-${index}`}
      >
        {/* A video that cannot load is skipped - otherwise `ended` never
            fires and the team's start (and every start queued behind it)
            stays blocked. */}
        <source
          src={current.videoUrl}
          onError={() => {
            console.warn('[FirstBipVideoOverlay] video failed to load, skipped:', current.videoUrl);
            handleEnded();
          }}
        />
        {subtitleLangs.filter((lang) => trackUrls[lang]).map((lang) => (
          <track
            key={trackUrls[lang]}
            kind="subtitles"
            srcLang={lang}
            label={LANG_NAMES[lang] || lang}
            src={trackUrls[lang]}
          />
        ))}
      </video>

      {subtitleText && (
        <div className="absolute inset-x-0 bottom-20 flex justify-center px-8 pointer-events-none">
          <p
            className="max-w-5xl text-center text-white font-medium leading-snug whitespace-pre-line text-[clamp(1.25rem,2.6vw,2.5rem)]"
            style={{ textShadow: '0 0 4px #000, 0 2px 6px #000' }}
          >
            {subtitleText}
          </p>
        </div>
      )}

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
        <div className={`absolute bottom-6 left-6 flex items-center gap-2 text-white/80 text-sm bg-black/50 px-3 py-1.5 rounded-full ${controlsClass}`}>
          <Subtitles className="w-4 h-4" />
          <select
            value={selectedLang ?? 'off'}
            onChange={(e) => {
              setSelectedLang(e.target.value === 'off' ? null : e.target.value);
              e.target.blur();
              revealControls();
            }}
            onFocus={() => setSelectFocused(true)}
            onBlur={() => setSelectFocused(false)}
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

      {/* Bottom bar: video index. The three bottom controls auto-hide (see
          revealControls). */}
      <div className={`absolute bottom-6 left-1/2 -translate-x-1/2 text-white/60 text-sm bg-black/40 px-3 py-1 rounded-full ${controlsClass}`}>
        {index + 1} / {videos.length} - {current.kind === 'intro' ? 'Intro' : 'Tutorial'}
      </div>

      {/* Visible skip control. Opens the confirm prompt so a stray player tap
          can't drop the video; the hidden 4-tap gesture above still works too. */}
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        className={`absolute bottom-6 right-6 text-white/70 hover:text-white text-sm bg-black/40 hover:bg-black/60 px-4 py-2 rounded-full transition ${controlsClass}`}
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
