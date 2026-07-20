import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { scenarioAssetUrl } from '../services/contentFs';
import { TracksCluesGrid, type TracksCluesCell } from './TracksCluesGrid';
import type { TeamSummarySnapshot } from '../services/teamSummaryTarget';

interface TeamSummaryOverlayProps {
  snapshot: TeamSummarySnapshot;
  onBack: () => void;
}

/**
 * Full-screen overlay rendering a finished team's final summary, pushed to this
 * device by the operator (`show_team_summary`). Meant to look exactly like the
 * in-game final summary (tracks = the clues page; mystery = the centre summary
 * panel), so - like the in-game screen - it carries NO return button. It
 * dismisses the same way the in-game final state does: auto-reset when the
 * game's "auto-reset page" option is on, otherwise on a tap / Enter / Esc.
 * Self-contained from the snapshot - images resolve locally via `scenarioAssetUrl`.
 */
export function TeamSummaryOverlay({ snapshot, onBack }: TeamSummaryOverlayProps) {
  // Mirror the in-game manual reset (click / Enter) for when auto-reset is off.
  // Suppressed while auto-resetting so the timer owns the dismissal.
  const manualDismiss = () => {
    if (!snapshot.autoReset) onBack();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
      else if (e.key === 'Enter') manualDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onBack, snapshot.autoReset]);

  // Honour the game's "auto-reset page" option: when on, self-dismiss after the
  // configured delay so a device showing this over its in-game screen returns to
  // the game on its own (no operator action needed).
  useEffect(() => {
    if (!snapshot.autoReset) return;
    const ms = Math.max(0, snapshot.autoResetSeconds) * 1000;
    const id = window.setTimeout(onBack, ms);
    return () => window.clearTimeout(id);
  }, [snapshot.autoReset, snapshot.autoResetSeconds, onBack]);

  const bgUrl = snapshot.backgroundImage
    ? scenarioAssetUrl(snapshot.scenarioUniqid, snapshot.backgroundImage)
    : '';

  return (
    <div
      className="fixed inset-0 z-[140] bg-black text-white overflow-hidden"
      onClick={manualDismiss}
    >
      <div
        className="absolute inset-0 tracks-fade-in"
        style={
          bgUrl
            ? { backgroundImage: `url(${bgUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : undefined
        }
      >
        {snapshot.gameType === 'mystery' ? (
          <MysterySummaryPanel snapshot={snapshot} />
        ) : (
          <TracksCluesGrid
            cells={tracksCells(snapshot)}
            showImage={snapshot.clues.show_image}
            showTitle={snapshot.clues.show_title}
            showText={snapshot.clues.show_text}
            showScore={snapshot.showScore}
            teamName={snapshot.teamName}
            scoreText={snapshot.scoreText}
            timerText={snapshot.timerText}
            language={snapshot.language}
          />
        )}
      </div>
    </div>
  );
}

/** Resolve each route checkpoint to a clues-grid cell: found → the checkpoint's
 *  own image, missing → the "not found" image (both via scenarioAssetUrl). */
function tracksCells(snapshot: Extract<TeamSummarySnapshot, { gameType: 'tracks' }>): TracksCluesCell[] {
  const missingUrl = snapshot.missingCheckpointImage
    ? scenarioAssetUrl(snapshot.scenarioUniqid, snapshot.missingCheckpointImage)
    : '';
  return snapshot.checkpoints.map((cp) => ({
    id: cp.id,
    title: cp.title,
    description: cp.description,
    imageUrl: cp.found && cp.image ? scenarioAssetUrl(snapshot.scenarioUniqid, cp.image) : missingUrl,
  }));
}

/**
 * Mystery final summary - the centre panel (team / score / level / description).
 * Font sizes use the SAME height-relative factors as the in-game renderer
 * (MysteryGameRenderer summary block: 0.045 / 0.1 / 0.04 / 0.02 of the stage
 * height) so it matches what the game screen shows. We measure our own height as
 * the stage (full bleed ≈ the in-game letterboxed stage on a 16:9 display).
 */
function MysterySummaryPanel({
  snapshot,
}: {
  snapshot: Extract<TeamSummarySnapshot, { gameType: 'mystery' }>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 800));
  useLayoutEffect(() => {
    const measure = () => setH(ref.current?.clientHeight || window.innerHeight);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  return (
    <div
      ref={ref}
      className="absolute inset-0 flex flex-col items-center justify-center text-center"
      style={{ gap: `${h * 0.02}px`, padding: `${h * 0.02}px` }}
    >
      {snapshot.teamName && (
        <div
          style={{ fontSize: `${h * 0.045}px`, fontWeight: 'bold', textShadow: '0 1px 4px rgba(0,0,0,0.8)', lineHeight: 1.1 }}
        >
          {snapshot.teamName}
        </div>
      )}
      <div
        style={{ fontSize: `${h * 0.1}px`, fontWeight: 'bold', color: '#4ade80', textShadow: '0 2px 8px rgba(0,0,0,0.8)', lineHeight: 1 }}
      >
        {snapshot.finalScoreText}
      </div>
      {snapshot.levelName && (
        <div
          style={{ fontSize: `${h * 0.04}px`, fontWeight: 'bold', color: snapshot.levelFontColor || '#ffffff', textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}
        >
          {snapshot.levelName}
        </div>
      )}
      {snapshot.levelDescription && (
        <div
          style={{ fontSize: `${h * 0.02}px`, maxWidth: '95%', lineHeight: 1.3, textShadow: '0 1px 4px rgba(0,0,0,0.8)', opacity: 0.95 }}
        >
          {snapshot.levelDescription}
        </div>
      )}
    </div>
  );
}
