import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { loadConfig } from '../utils/config';
import { hasPin } from '../services/pinStore';
import { PinExitPrompt } from './PinExitPrompt';

// Mounted once at the app root (main.tsx), outside AuthProvider, so it
// overlays both the LoginScreen and the App. Two jobs:
//   1. F11 toggles the window in/out of fullscreen at runtime. This is a
//      pure window action — it does NOT rewrite the saved `fullscreenOnLaunch`
//      preference (browser-style). When the "Require PIN to exit fullscreen"
//      kiosk gate is on, LEAVING fullscreen first asks for the device PIN
//      (entering is never gated). Bypassed when no device PIN is set yet, so
//      a brand-new device can't get trapped in a fullscreen login screen.
//   2. While in fullscreen, reveal an "Exit fullscreen by pressing F11" hint
//      when the cursor reaches the very top edge of the screen (like a
//      fullscreen video player revealing its controls).

// Height of the top trigger band, in CSS pixels.
const TOP_BAND_PX = 4;

export function FullscreenHint() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cursorAtTop, setCursorAtTop] = useState(false);
  // When the PIN-to-exit-fullscreen gate fires, we surface PinExitPrompt and
  // only drop out of fullscreen on success. The ref mirrors the state so the
  // window-level keydown handler (registered once) can guard against opening
  // a second prompt without re-subscribing.
  const [pinPromptOpen, setPinPromptOpen] = useState(false);
  const pinPromptOpenRef = useRef(false);

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

  const setPromptOpen = (open: boolean) => {
    pinPromptOpenRef.current = open;
    setPinPromptOpen(open);
  };

  const exitFullscreen = () => {
    const win = getCurrentWindow();
    void win
      .setFullscreen(false)
      .then(() => setIsFullscreen(false))
      .catch(() => {
        /* not in a Tauri runtime — no-op */
      });
  };

  // F11 toggles fullscreen. Entering is immediate; leaving may be gated by
  // the device PIN ("Require PIN to exit fullscreen"). The handler reads the
  // config lazily on each press so a freshly saved toggle takes effect at once.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'F11') return;
      e.preventDefault();
      // Already prompting for the exit PIN — ignore repeat presses.
      if (pinPromptOpenRef.current) return;
      const win = getCurrentWindow();
      void (async () => {
        try {
          const fullscreen = await win.isFullscreen();
          if (!fullscreen) {
            // Entering fullscreen is never gated.
            await win.setFullscreen(true);
            setIsFullscreen(true);
            return;
          }
          // Leaving fullscreen — apply the kiosk gate if enabled and a PIN
          // exists (no PIN ⇒ bypass so a new device can't get trapped).
          const cfg = await loadConfig();
          if (cfg.requirePinToExitFullscreen && (await hasPin())) {
            setPromptOpen(true);
            return;
          }
          exitFullscreen();
        } catch {
          /* not in a Tauri runtime — no-op */
        }
      })();
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
    <>
      <div
        className={`fixed top-0 left-1/2 -translate-x-1/2 z-[100] pointer-events-none transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="mt-2 px-4 py-2 rounded-full bg-black/80 text-white text-sm font-medium shadow-lg border border-white/10">
          Exit fullscreen by pressing F11
        </div>
      </div>

      {pinPromptOpen && (
        <PinExitPrompt
          title="Enter your PIN"
          subtitle="Enter the device PIN to exit fullscreen."
          onSuccess={() => {
            setPromptOpen(false);
            exitFullscreen();
          }}
          onCancel={() => setPromptOpen(false)}
        />
      )}
    </>
  );
}
