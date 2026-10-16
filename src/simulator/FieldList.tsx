// Field view: every mock team, its players and what they're doing at the
// current simulated time. Shared by the game-page floating window and the
// control panel (local or remote/tablet). Internal tool - English only.

import type { FieldRow, FieldState } from './types';

const SECTIONS: Array<{ state: FieldState; title: string; tone: string }> = [
  { state: 'reader', title: 'At the reader', tone: 'text-fuchsia-300' },
  { state: 'field', title: 'In the field', tone: 'text-emerald-300' },
  { state: 'not_arrived', title: 'Not arrived', tone: 'text-sky-300' },
  { state: 'done', title: 'Finished', tone: 'text-white/50' },
  { state: 'abandoned', title: 'Gave up', tone: 'text-amber-400/70' },
];

function countdown(at: number | null, now: number | null): string {
  if (at === null || now === null) return '';
  const s = Math.max(0, Math.round((at - now) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function FieldList({
  rows,
  virtualNow,
  compact = false,
}: {
  rows: FieldRow[];
  /** Simulated time, for the "next bip in" countdowns. */
  virtualNow: number | null;
  compact?: boolean;
}) {
  if (rows.length === 0) return <div className="text-white/50">No mock team yet.</div>;
  return (
    <div className="space-y-2">
      {SECTIONS.map(({ state, title, tone }) => {
        const list = rows.filter((r) => r.state === state);
        if (list.length === 0) return null;
        const dim = state === 'done' || state === 'abandoned';
        return (
          <div key={state}>
            <div className={`text-[10px] uppercase tracking-wide ${tone}`}>
              {title} · {list.length}
            </div>
            {dim && compact ? (
              <div className="text-white/50">{list.map((r) => r.team).join(' · ')}</div>
            ) : (
              <ul className="space-y-1">
                {list.map((r) => (
                  <li key={r.key} className={dim ? 'opacity-60' : ''}>
                    <div className="flex gap-2">
                      <span className="font-semibold truncate">{r.team}</span>
                      <span className="text-white/50 truncate">{r.players.join(', ')}</span>
                      {r.profile === 'chaotic' && <span className="text-amber-400">chaotic</span>}
                      {r.nextBipAt !== null && state !== 'reader' && (
                        <span className="ml-auto font-mono text-white/60" title={`next bip: ${r.nextBipIntent ?? ''}`}>
                          {countdown(r.nextBipAt, virtualNow)}
                        </span>
                      )}
                    </div>
                    <div className="text-white/70 truncate" title={r.action}>
                      {r.action}
                      {!compact && r.nextBipIntent && state !== 'reader' && (
                        <span className="text-white/40"> · next bip: {r.nextBipIntent}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
