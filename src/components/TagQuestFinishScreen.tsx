import { tIngame } from '../i18n/ingame';

// Full-screen card shown on the reading kiosk when a team punches the arrival
// station. Player-facing, so it speaks the launch language (it used to be a
// hardcoded English "Game Over / Good game"). The parent closes it on a timer;
// a tap closes it sooner.

interface TagQuestFinishScreenProps {
  teamName: string;
  score: number;
  elapsedSec: number | null;
  lang: string;
  fontFamily?: string;
  onClose: () => void;
}

function formatElapsed(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function TagQuestFinishScreen({ teamName, score, elapsedSec, lang, fontFamily, onClose }: TagQuestFinishScreenProps) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.82)',
        backdropFilter: 'blur(6px)',
        zIndex: 2000,
        fontFamily,
      }}
      onClick={onClose}
    >
      <div
        style={{
          textAlign: 'center',
          padding: '48px 64px',
          maxWidth: '90vw',
          borderRadius: '20px',
          background: 'rgba(15,23,42,0.9)',
          border: '1px solid rgba(74,222,128,0.3)',
          boxShadow: '0 0 60px rgba(74,222,128,0.15), 0 24px 48px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ fontSize: '4rem', marginBottom: '12px' }}>🏁</div>
        <div
          style={{
            fontSize: 'clamp(2rem, 5vw, 3.5rem)',
            fontWeight: 800,
            color: '#4ade80',
            lineHeight: 1.1,
            marginBottom: '16px',
          }}
        >
          {tIngame('ingame_tagquest', 'finish_title', lang)}
        </div>
        <div style={{ fontSize: 'clamp(1.2rem, 3vw, 2rem)', color: '#fff', fontWeight: 600, marginBottom: '20px' }}>
          {tIngame('ingame_tagquest', 'finish_well_done', lang, { team: teamName })}
        </div>
        <div style={{ display: 'flex', gap: '32px', justifyContent: 'center', flexWrap: 'wrap', color: '#fff' }}>
          <div>
            <div style={{ fontSize: '0.9rem', opacity: 0.6, textTransform: 'uppercase' }}>
              {tIngame('ingame_tagquest', 'score', lang)}
            </div>
            <div style={{ fontSize: 'clamp(1.5rem, 4vw, 2.75rem)', fontWeight: 800 }}>{score}</div>
          </div>
          {elapsedSec != null && (
            <div>
              <div style={{ fontSize: '0.9rem', opacity: 0.6, textTransform: 'uppercase' }}>
                {tIngame('ingame_tagquest', 'finish_time', lang)}
              </div>
              <div style={{ fontSize: 'clamp(1.5rem, 4vw, 2.75rem)', fontWeight: 800 }}>{formatElapsed(elapsedSec)}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
