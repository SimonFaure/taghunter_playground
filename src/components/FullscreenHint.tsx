import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Mounted once at the app root (main.tsx), outside AuthProvider, so it
// overlays both the LoginScreen and the App. Two jobs:
//   1. F11 toggles the window in/out of fullscreen at runtime. This is a
//      pure window action — it does NOT rewrite the saved `fullscreenOnLaunch`
//      preference (browser-style).
//   2. While in fullscreen, reveal an "Exit fullscreen by pressing F11" hint
//      when the cursor reaches the very top edge of the screen (like a
//      fullscreen video player revealing its controls).

// Height of the top trigger band, in CSS pixels.
const TOP_BAND_PX = 4;

export function FullscreenHint() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cursorAtTop, setCursorAtTop] = useState(false);

  // Seed fullscreen state once, and keep it in sync with window resizes
  // (entering/exiting fullscreen fires a resize).
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const sync = () => {
      void getCurrentWindow()
        .isFullscreen()
        .then((v) => {
          if (!cancelled) setIsFullscreen(v);
        })
        .catch(() => {
          /* not in a Tauri runtime — leave as windowed */
        });
    };

    sync();
    getCurrentWindow()
      .onResized(() => sync())
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* event listening unavailable — F11 handler still updates state */
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // F11 toggles fullscreen.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'F11') return;
      e.preventDefault();
      const win = getCurrentWindow();
      void win
        .isFullscreen()
        .then((v) => win.setFullscreen(!v).then(() => setIsFullscreen(!v)))
        .catch(() => {
          /* not in a Tauri runtime — no-op */
        });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Reveal the hint only while the cursor is in the top band.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      setCursorAtTop(e.clientY <= TOP_BAND_PX);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  const visible = isFullscreen && cursorAtTop;

  return (
    <div
      className={`fixed top-0 left-1/2 -translate-x-1/2 z-[100] pointer-events-none transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div className="mt-2 px-4 py-2 rounded-full bg-black/80 text-white text-sm font-medium shadow-lg border border-white/10">
        Exit fullscreen by pressing F11
      </div>
    </div>
  );
}
