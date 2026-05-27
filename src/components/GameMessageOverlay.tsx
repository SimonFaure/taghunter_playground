import { useEffect, useState } from 'react';
import type { GameMessageType } from '../services/gameMessages';

// Full-viewport in-game status message, shared by all game types (Mystery,
// TagQuest, Tracks). The whole screen tints to the message-type colour at 50%
// opacity with the scenario font centred on top. Purely visual: pointer-events
// are off so taps reach the game / operator controls underneath, and it fades
// in/out via opacity (it stays mounted, retaining the last message during the
// fade-out so the text doesn't blank mid-transition).

const WASH: Record<GameMessageType, string> = {
  success: 'rgba(34, 197, 94, 0.5)', // green-500 @ 50%
  error: 'rgba(239, 68, 68, 0.5)', //   red-500 @ 50%
  warning: 'rgba(249, 115, 22, 0.5)', // orange-500 @ 50%
  info: 'rgba(0, 0, 0, 0.5)', //         neutral dim @ 50%
};

interface GameMessageOverlayProps {
  /** Message text; null/empty hides the overlay (fading it out). */
  message: string | null;
  type?: GameMessageType;
  /** Scenario font-family, inherited from the game renderer root. */
  fontFamily?: string;
  /** Optional smaller secondary line (e.g. TagQuest level-up). */
  subMessage?: string | null;
}

export function GameMessageOverlay({
  message,
  type = 'info',
  fontFamily,
  subMessage,
}: GameMessageOverlayProps) {
  // Retain the last shown content so the fade-out animates with text + colour
  // intact instead of blanking the instant `message` clears.
  const [shown, setShown] = useState<{
    message: string;
    type: GameMessageType;
    subMessage?: string | null;
  }>({ message: '', type: 'info' });

  useEffect(() => {
    if (message) setShown({ message, type, subMessage });
  }, [message, type, subMessage]);

  const visible = !!message;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        // Above the game board/HUD (z ≤ 50) but below the blocking modals and
        // operator UI that share GamePage's stacking context: intro video (100),
        // self-register (110), 4-tap corner (110), operator panel (120), PIN
        // prompt (200), punch-reveal overlay (5000). A full-screen wash must not
        // cover those.
        zIndex: 90,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '0 6vw',
        background: WASH[shown.type],
        fontFamily: fontFamily || undefined,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.25s ease',
      }}
    >
      <div
        style={{
          color: '#fff',
          fontWeight: 700,
          fontSize: 'clamp(1.5rem, 4vw, 2.5rem)',
          lineHeight: 1.2,
          maxWidth: '80vw',
          textShadow: '0 2px 12px rgba(0, 0, 0, 0.7)',
        }}
      >
        {shown.message}
      </div>
      {shown.subMessage && (
        <div
          style={{
            marginTop: '0.6em',
            color: '#fff',
            fontWeight: 700,
            fontSize: 'clamp(1.1rem, 2.6vw, 1.75rem)',
            textShadow: '0 2px 12px rgba(0, 0, 0, 0.7)',
          }}
        >
          {shown.subMessage}
        </div>
      )}
    </div>
  );
}
