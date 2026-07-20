// Clash final results - the match-over screen. Winning clan's seal centred (or
// a draw), per-clan point totals, and the final territory ownership grid.
// Ownership is whatever the mother locked at expiry.
//
// Design: project_clash_game_type_design.

import type { ClashStandings } from '../services/clash';
import type { ClashClanVisual } from './ClashGameRenderer';

interface ClashResultsScreenProps {
  standings: ClashStandings | null;
  clanByTeamId: Record<number, ClashClanVisual>;
  territoryNames: Record<number, string>;
  resolveMedia: (filename: string) => string;
  fontFamily?: string;
  onBack: () => void;
}

export function ClashResultsScreen({
  standings,
  clanByTeamId,
  territoryNames,
  resolveMedia,
  fontFamily,
  onBack,
}: ClashResultsScreenProps) {
  // Tiebreak on the exact (unrounded) weighted score; a true tie ⇒ Draw.
  const clans = (standings?.clans ?? [])
    .map((c) => ({ standing: c, visual: clanByTeamId[c.team_id] }))
    .filter((c) => c.visual)
    .sort((a, b) => (b.standing.points_exact ?? b.standing.points) - (a.standing.points_exact ?? a.standing.points));

  const topExact = clans[0] ? clans[0].standing.points_exact ?? clans[0].standing.points : 0;
  const winners = clans.filter(
    (c) => (c.standing.points_exact ?? c.standing.points) === topExact && topExact > 0,
  );
  const isDraw = winners.length !== 1;
  const winner = !isDraw ? winners[0] : null;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white overflow-auto"
      style={{ fontFamily }}
    >
      <div className="flex-1 w-full max-w-4xl mx-auto p-8 flex flex-col items-center gap-8">
        {/* Winner / draw */}
        <div className="flex flex-col items-center gap-4 pt-6">
          {winner ? (
            <>
              <div
                className="w-40 h-40 rounded-full bg-black/40 border-4 flex items-center justify-center overflow-hidden shadow-2xl"
                style={{ borderColor: winner.visual!.color }}
              >
                {winner.visual!.logo ? (
                  <img src={resolveMedia(winner.visual!.logo)} alt="" className="w-full h-full object-contain" />
                ) : (
                  <span className="text-white/50">-</span>
                )}
              </div>
              <h1 className="text-4xl font-bold" style={{ color: winner.visual!.color }}>
                {winner.visual!.name} wins!
              </h1>
            </>
          ) : (
            <>
              <div className="flex gap-3">
                {winners.map((w) => (
                  <div
                    key={w.standing.team_id}
                    className="w-24 h-24 rounded-full bg-black/40 border-4 flex items-center justify-center overflow-hidden"
                    style={{ borderColor: w.visual!.color }}
                  >
                    {w.visual!.logo && (
                      <img src={resolveMedia(w.visual!.logo)} alt="" className="w-full h-full object-contain" />
                    )}
                  </div>
                ))}
              </div>
              <h1 className="text-4xl font-bold text-white/90">
                {topExact > 0 ? 'Draw!' : 'No territory taken'}
              </h1>
            </>
          )}
        </div>

        {/* Per-clan totals */}
        <div className="w-full max-w-md space-y-2">
          {clans.map((c, i) => (
            <div
              key={c.standing.team_id}
              className="flex items-center gap-3 rounded-lg bg-white/5 px-4 py-3"
            >
              <span className="w-6 text-center text-white/50 font-bold">{i + 1}</span>
              <span className="w-4 h-4 rounded-full" style={{ backgroundColor: c.visual!.color }} />
              <span className="flex-1 font-semibold">{c.visual!.name}</span>
              <span className="tabular-nums text-lg font-bold">{c.standing.points} pts</span>
            </div>
          ))}
        </div>

        {/* Final territory ownership */}
        <div className="w-full">
          <h2 className="text-sm font-bold uppercase tracking-wide text-white/50 mb-2">Territories</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(standings?.territories ?? []).map((t, i) => {
              const owner = t.owner_team_id != null ? clanByTeamId[t.owner_team_id] : undefined;
              return (
                <div
                  key={t.index}
                  className="rounded-lg bg-white/5 p-3 flex flex-col items-center gap-2 border-2"
                  style={{ borderColor: owner?.color ?? '#6b7280' }}
                >
                  <div className="w-14 h-14 rounded-full bg-black/40 overflow-hidden flex items-center justify-center">
                    {owner?.logo ? (
                      <img src={resolveMedia(owner.logo)} alt="" className="w-full h-full object-contain" />
                    ) : (
                      <span className="text-xs text-white/40">Neutre</span>
                    )}
                  </div>
                  <span className="text-xs text-center truncate w-full">
                    {territoryNames[t.index] || `Territory ${i + 1}`}
                  </span>
                  <span className="text-[10px] text-white/50">{t.points} pts/min</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 w-full bg-slate-900/90 border-t border-white/10 p-4 flex justify-center">
        <button
          onClick={onBack}
          className="px-8 py-3 bg-slate-700 hover:bg-slate-600 rounded-xl text-lg font-semibold"
        >
          Back to games
        </button>
      </div>
    </div>
  );
}
