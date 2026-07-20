// Clash registration - bind players' chips to clans before the match.
//
// Self mode: select a clan on this station, then players bip to join it (a
// dedicated "join reader" is just a station left on one clan). Full clans grey
// out. Bulk mode: hand out contiguous chip blocks from the local card DB,
// skipping gaps. Both call the server-authoritative clashRegister.
//
// Design: project_clash_game_type_design.

import { useState } from 'react';
import { Check, Play, Users } from 'lucide-react';
import * as cardsRepo from '../services/cardsRepo';
import { clashRegister, type ClashStandings } from '../services/clash';
import type { ClashClanVisual } from './ClashGameRenderer';

interface ClashRegistrationScreenProps {
  launchedGameId: number;
  standings: ClashStandings | null;
  clanByTeamId: Record<number, ClashClanVisual>;
  mode: 'self' | 'bulk';
  selectedTeamId: number | null;
  onSelectClan: (teamId: number) => void;
  onStart: () => void;
  onBack: () => void;
  /** Last self-register outcome, surfaced as a transient line. */
  lastJoin: { teamId: number; status: string } | null;
  /** Scenario visual (resolved URL, '' ⇒ none) shown as the full-bleed
   *  background; falls back to the clan banners when the scenario has none. */
  visualUrl: string;
  /** Resolves a scenario media filename to a displayable URL. */
  resolveMedia: (filename: string) => string;
  /** Station assignment (self mode): this station is hard-locked to these clan
   *  team_numbers - only they render, no switching off them. null ⇒ the
   *  legacy pick-any-clan grid. Design: project_selfregister_team_device_assignment. */
  assignedTeamNumbers?: number[] | null;
}

function clanIsFull(memberCount: number, maxPerClan: number): boolean {
  return maxPerClan > 0 && memberCount >= maxPerClan;
}

export function ClashRegistrationScreen({
  launchedGameId,
  standings,
  clanByTeamId,
  mode,
  selectedTeamId,
  onSelectClan,
  onStart,
  onBack,
  lastJoin,
  visualUrl,
  resolveMedia,
  assignedTeamNumbers = null,
}: ClashRegistrationScreenProps) {
  // Station assignment (self mode): a locked station renders only its clan(s).
  const restricted = mode === 'self' && assignedTeamNumbers != null;
  const clans = restricted
    ? (standings?.clans ?? []).filter((c) => assignedTeamNumbers!.includes(c.team_number))
    : standings?.clans ?? [];
  const maxPerClan = standings?.max_per_clan ?? 0;
  // Every assigned clan full ⇒ this station's registration job is done.
  const stationComplete =
    restricted && clans.length > 0 && clans.every((c) => clanIsFull(c.member_count, maxPerClan));
  // Background fallback: one banner per active clan when the scenario has no visual.
  const bannerUrls = visualUrl
    ? []
    : clans
        .map((c) => clanByTeamId[c.team_id]?.banner)
        .filter((b): b is string => !!b)
        .map(resolveMedia);

  const [firstKeyNumber, setFirstKeyNumber] = useState(1);
  const [headcounts, setHeadcounts] = useState<Record<number, number>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ assigned: number; full: number; failed: number } | null>(null);

  const handleBulkAssign = async () => {
    if (!standings || bulkBusy) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const cards = await cardsRepo.list(); // ordered by key_number ASC
      const eligible = cards.filter((c) => c.key_number >= firstKeyNumber);
      let cursor = 0;
      let assigned = 0;
      let full = 0;
      let failed = 0;
      for (const clan of clans) {
        const need = headcounts[clan.team_id] ?? 0;
        for (let k = 0; k < need && cursor < eligible.length; k++) {
          const card = eligible[cursor++];
          try {
            const res = await clashRegister(launchedGameId, clan.team_id, card.id);
            if (res.status === 'ok') assigned++;
            else if (res.status === 'clan_full') full++;
            else if (res.status === 'already_in_clan' || res.status === 'already_in_other_clan') assigned++;
            else failed++;
          } catch {
            failed++;
          }
        }
      }
      setBulkResult({ assigned, full, failed });
    } finally {
      setBulkBusy(false);
    }
  };

  const lastJoinClan = lastJoin ? clanByTeamId[lastJoin.teamId] : undefined;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white overflow-auto">
      {/* Full-bleed background - scenario visual, or the clan banners spread
          edge to edge when there is none - under a dark scrim so the UI stays
          readable. The content wrapper below is `relative` to paint above. */}
      {visualUrl ? (
        <>
          <img src={visualUrl} alt="" className="fixed inset-0 w-full h-full object-cover" />
          <div className="fixed inset-0 bg-slate-900/75" />
        </>
      ) : bannerUrls.length > 0 ? (
        <>
          <div className="fixed inset-0 flex">
            {bannerUrls.map((url, i) => (
              <img key={i} src={url} alt="" className="flex-1 min-w-0 h-full object-cover" />
            ))}
          </div>
          <div className="fixed inset-0 bg-slate-900/75" />
        </>
      ) : null}

      <div className="relative flex-1 max-w-5xl w-full mx-auto p-8 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Clan registration</h1>
          <button onClick={onBack} className="text-sm text-white/60 hover:text-white">Back</button>
        </div>

        <p className="text-white/70">
          {restricted
            ? clans.length === 1
              ? 'This station registers one clan only - players bip their chip here to join it.'
              : 'This station registers the clans below only - pick one, then players bip their chip to join it.'
            : mode === 'self'
              ? 'Select a clan on this station, then players bip their chip to join it. Leave a station on one clan to use it as a dedicated join reader.'
              : 'Hand out contiguous chip blocks from the card list. Gaps are skipped automatically.'}
        </p>

        {restricted && clans.length === 0 && (
          <div className="rounded-xl border-2 border-amber-400 bg-amber-500/15 p-4 text-amber-200">
            No clan matches this station's assignment - ask the operator to update it from the
            Devices panel.
          </div>
        )}

        {/* Clan cards with live counts - centered, sized up when few clans
            show (a locked station usually shows 1-3), readable from across
            the room. */}
        <div className="flex flex-wrap justify-center gap-5 py-2">
          {clans.map((c) => {
            const v = clanByTeamId[c.team_id];
            const full = clanIsFull(c.member_count, maxPerClan);
            const selected = selectedTeamId === c.team_id;
            const pct = maxPerClan > 0 ? Math.min(100, (c.member_count / maxPerClan) * 100) : 0;
            const sizeCls =
              clans.length <= 2 ? 'w-80 p-8' : clans.length === 3 ? 'w-72 p-7' : 'w-64 p-6';
            return (
              <button
                key={c.team_id}
                type="button"
                disabled={mode !== 'self' || full}
                onClick={() => onSelectClan(c.team_id)}
                className={`relative ${sizeCls} max-w-full rounded-2xl border-2 text-center transition-all duration-200 ${
                  full
                    ? 'border-slate-700 bg-slate-800/40 opacity-40 cursor-not-allowed'
                    : selected
                      ? 'border-white bg-white/10 ring-4 ring-white/20 shadow-2xl'
                      : 'border-slate-700 bg-slate-800/60 hover:border-slate-400 hover:bg-slate-800 active:scale-95'
                }`}
              >
                {/* Selected = the clan this station enrols into. A check badge
                    on top of the border change - never color alone. */}
                {selected && !full && (
                  <span className="absolute top-3 right-3 rounded-full bg-white text-slate-900 p-1 shadow-lg">
                    <Check size={14} strokeWidth={3.5} />
                  </span>
                )}
                {full && (
                  <span className="absolute top-3 right-3 text-[10px] font-bold uppercase tracking-wider text-amber-300 border border-amber-300/60 rounded px-1.5 py-0.5">
                    Full
                  </span>
                )}
                {v?.logo ? (
                  <img
                    src={resolveMedia(v.logo)}
                    alt=""
                    className="w-16 h-16 object-contain mx-auto mb-3"
                  />
                ) : (
                  <span
                    className="block w-6 h-6 rounded-full mx-auto mb-3"
                    style={{ backgroundColor: v?.color ?? '#888' }}
                  />
                )}
                <div className="text-2xl font-bold leading-tight break-words mb-4">
                  {v?.name ?? `Clan ${c.team_number}`}
                </div>
                <div className="flex items-baseline justify-center gap-2 text-white">
                  <Users size={22} className="self-center opacity-60" />
                  <span className="text-4xl font-extrabold tabular-nums leading-none">
                    {c.member_count}
                  </span>
                  {maxPerClan > 0 && (
                    <span className="text-xl font-semibold text-white/50 tabular-nums">
                      / {maxPerClan}
                    </span>
                  )}
                </div>
                {maxPerClan > 0 && (
                  <div className="mt-4 h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: full ? '#fbbf24' : v?.color || 'rgba(255,255,255,0.7)',
                      }}
                    />
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {stationComplete && (
          <div className="rounded-xl border-2 border-green-400 bg-green-500/15 p-5 text-center">
            <p className="text-2xl font-bold text-green-300">Registration complete on this station</p>
            <p className="text-white/70 mt-1">
              {clans.length === 1 ? 'The assigned clan is full.' : 'All assigned clans are full.'}
            </p>
          </div>
        )}

        {mode === 'self' && !stationComplete && (
          <div className="rounded-xl bg-slate-800/50 p-4 text-center">
            {selectedTeamId != null ? (
              <p className="text-lg">
                Bip a chip to join{' '}
                <span className="font-bold" style={{ color: clanByTeamId[selectedTeamId]?.color }}>
                  {clanByTeamId[selectedTeamId]?.name}
                </span>
              </p>
            ) : (
              <p className="text-white/60">Select a clan above to start enrolling players.</p>
            )}
            {lastJoin && (
              <p className="mt-2 text-sm text-white/70">
                {lastJoin.status === 'ok' && `Joined ${lastJoinClan?.name ?? ''} ✓`}
                {lastJoin.status === 'clan_full' && 'Clan full - pick another clan'}
                {lastJoin.status === 'already_in_clan' && 'Already in this clan'}
                {lastJoin.status === 'already_in_other_clan' && 'Chip already belongs to another clan'}
              </p>
            )}
          </div>
        )}

        {mode === 'bulk' && (
          <div className="rounded-xl bg-slate-800/50 p-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-slate-300 mb-1">First chip number</label>
                <input
                  type="number"
                  min="0"
                  value={firstKeyNumber}
                  onChange={(e) => setFirstKeyNumber(parseInt(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {clans.map((c) => (
                <div key={c.team_id}>
                  <label className="block text-xs text-slate-400 mb-1 truncate">
                    {clanByTeamId[c.team_id]?.name ?? `Clan ${c.team_number}`}
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={headcounts[c.team_id] ?? 0}
                    onChange={(e) =>
                      setHeadcounts((h) => ({ ...h, [c.team_id]: Math.max(0, parseInt(e.target.value) || 0) }))
                    }
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg"
                  />
                </div>
              ))}
            </div>
            <button
              onClick={handleBulkAssign}
              disabled={bulkBusy}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
            >
              {bulkBusy ? 'Assigning…' : 'Assign chips'}
            </button>
            {bulkResult && (
              <p className="text-sm text-white/70">
                Assigned {bulkResult.assigned}
                {bulkResult.full > 0 ? ` · ${bulkResult.full} hit clan cap` : ''}
                {bulkResult.failed > 0 ? ` · ${bulkResult.failed} failed` : ''}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="sticky bottom-0 bg-slate-900/90 border-t border-white/10 p-4 flex justify-end">
        <button
          onClick={onStart}
          className="inline-flex items-center gap-2 px-8 py-3 bg-green-600 hover:bg-green-700 rounded-xl text-lg font-semibold"
        >
          <Play size={22} /> Start game
        </button>
      </div>
    </div>
  );
}
