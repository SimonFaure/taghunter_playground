import { useCallback, useEffect, useRef, useState } from 'react';

// Fullscreen overlay shown when a team scans their first tag. Plays the
// scenario intro video first (if enabled and present), then the game-type
// tutorial video (if enabled and present). Players cannot skip — only
// the operator can, via a hidden 4-tap gesture in the top-right corner
// followed by a confirm prompt.
//
// When all enabled videos have finished, `onComplete` fires and the parent
// (MysteryGamePage) records `team.start_time` and resumes normal play.

interface VideoSource {
  kind: 'intro' | 'tutorial';
  videoUrl: string;
  subtitleLang: string | null;
  subtitleUrl: string | null;
}

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
  const [index, setIndex] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const tapTimestamps = useRef<number[]>([]);

  // Edge case: if the parent mounts the overlay with zero enabled videos,
  // resolve immediately. The MysteryGamePage trigger already guards against
  // this; double-checking keeps the component well-behaved in isolation.
  useEffect(() => {
    if (videos.length === 0) onComplete();
  }, [videos.length, onComplete]);

  const current = videos[index] ?? null;

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
  // every index advance — no manual load() needed. Calling load() here
  // would abort the autoPlay attribute's already-in-flight play() promise
  // and surface as a noisy AbortError.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    void el.play().catch((err) => {
      const name = (err as Error | null)?.name;
      // AbortError: typically a stale promise from a previous remount —
      // benign. NotAllowedError: browser blocked autoplay without a user
      // gesture — also nothing we can do here.
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
        key={`${current.videoUrl}-${index}`}
      >
        <source src={current.videoUrl} />
        {current.subtitleUrl && current.subtitleLang && (
          <track
            kind="subtitles"
            srcLang={current.subtitleLang}
            label={current.subtitleLang}
            src={current.subtitleUrl}
            default
          />
        )}
      </video>

      {/* Invisible 4-tap admin escape hatch. Positioned in the top-right
          corner; not visually decorated so players don't discover it. */}
      <button
        type="button"
        aria-label="Admin escape — tap 4 times to skip"
        onClick={handleTapZoneClick}
        className="absolute top-0 right-0 bg-transparent border-0 cursor-default"
        style={{ width: TAP_ZONE_PX, height: TAP_ZONE_PX }}
      />

      {/* Bottom bar: video index, no skip control for players. */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-white/60 text-sm bg-black/40 px-3 py-1 rounded-full">
        {index + 1} / {videos.length} — {current.kind === 'intro' ? 'Intro' : 'Tutorial'}
      </div>

      {confirmOpen && (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 max-w-md space-y-4">
            <h3 className="text-lg font-semibold text-white">Skip this video?</h3>
            <p className="text-sm text-slate-300">
              Admin override — confirm to skip the current video and continue with the next
              (or start gameplay if this was the last).
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 text-sm bg-slate-700 text-white rounded-lg hover:bg-slate-600"
              >
                Cancel
              </button>
              <button
                onClick={confirmSkip}
                className="px-4 py-2 text-sm bg-rose-600 text-white rounded-lg hover:bg-rose-700"
              >
                Skip video
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
