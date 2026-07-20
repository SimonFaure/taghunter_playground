// Text-only line pinned to the bottom of an in-game page listing the teams
// whose reveal animation / message is waiting in the presentation queue while a
// previous one is still on screen. Shared by all game types. Purely visual:
// pointer-events are off so taps reach the game / operator UI underneath (same
// as GameMessageOverlay). Renders nothing when the queue is empty.

interface PendingTeamsBarProps {
  /** Labels of waiting items, arrival order (= usePresentationQueue().pending). */
  labels: string[];
  /** Scenario font-family, inherited from the game renderer root. */
  fontFamily?: string;
  /** Separator between names. */
  separator?: string;
  /** Leading label shown before the team list. */
  prefix?: string;
  /** Hide the bar entirely (e.g. while a full-screen game message is on screen,
   *  so the waiting line doesn't show through under the "C'est parti …" wash). */
  hidden?: boolean;
}

export function PendingTeamsBar({
  labels,
  fontFamily,
  separator = ' · ',
  prefix = 'En attente :',
  hidden = false,
}: PendingTeamsBarProps) {
  if (hidden || !labels.length) return null;

  const text = (prefix ? `${prefix} ` : '') + labels.join(separator);

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        // Above the game board/HUD (z ≤ 50) so it's readable over the scene,
        // below the GameMessageOverlay wash (z90, so a full-screen message dims
        // it too) and below every blocking/operator overlay (intro video 100,
        // self-register/corner 110, Clash reveal 115, operator panel 120, PIN
        // 200, punch-reveal 5000).
        zIndex: 80,
        pointerEvents: 'none',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '0.5rem 4vw',
        background: 'rgba(0, 0, 0, 0.55)',
        fontFamily: fontFamily || undefined,
      }}
    >
      <div
        style={{
          color: '#fff',
          fontWeight: 600,
          fontSize: 'clamp(0.9rem, 2vw, 1.25rem)',
          maxWidth: '92vw',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          textShadow: '0 1px 6px rgba(0, 0, 0, 0.7)',
        }}
      >
        {text}
      </div>
    </div>
  );
}
