// Clash registration - bind players' chips to clans before the match.
//
// Self mode: select a clan on this station, then players bip to join it (a
// dedicated "join reader" is just a station left on one clan). Full clans grey
// out, calling the server-authoritative clashRegister.
//
// Bulk mode ("Équipes prédéfinies"): the clans were already dealt contiguous
// chip blocks at launch (see GameList), so this screen is read-only - it just
// shows the formed clans and a Start button.
//
// Design: project_clash_game_type_design.

import { Check, Play, Users } from 'lucide-react';
import { type ClashStandings } from '../services/clash';
import { tIngame } from '../i18n/ingame';
import type { ClashClanVisual } from './ClashGameRenderer';
import { useSimBus } from '../services/simBus';

/** Split marker for the two sentences that style part of themselves (the clan
 *  name, the Start-game label). Interpolating a sentinel then splitting on it
 *  keeps the translator's word order while letting us wrap that fragment in
 *  its own <span>. NUL can never occur in a catalog string. */
const SLOT = String.fromCharCode(0);

interface ClashRegistrationScreenProps {
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
  /** Language chosen at launch - every string on this screen resolves against
   *  it, not against the operator's chrome language. */
  lang: string;
}

function clanIsFull(memberCount: number, maxPerClan: number): boolean {
  return maxPerClan > 0 && memberCount >= maxPerClan;
}

export function ClashRegistrationScreen({
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
  lang,
}: ClashRegistrationScreenProps) {
  // Game simulator: pick the team for the next mock player's bip, then press
  // Start once everyone is registered - the same handlers a tap calls.
  useSimBus((a) => {
    if (a.kind === 'selectTeam') onSelectClan(a.teamId);
    else if (a.kind === 'pressStart') onStart();
  });
  const tc = (key: string, vars?: Record<string, string | number>) =>
    tIngame('ingame_clash', key, lang, vars);
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

  const lastJoinClan = lastJoin ? clanByTeamId[lastJoin.teamId] : undefined;

  const startLabel = tc('start_game');
  // Sentences that style one fragment: interpolate the sentinel, then split.
  const [bipBefore, bipAfter = ''] =
    selectedTeamId != null ? tc('bip_to_join', { clan: SLOT }).split(SLOT) : [''];
  const [bulkBefore, bulkAfter = ''] = tc('bulk_footer', { start: SLOT }).split(SLOT);

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
          <h1 className="text-3xl font-bold">{tc('title')}</h1>
          <button onClick={onBack} className="text-sm text-white/60 hover:text-white">{tc('back')}</button>
        </div>

        <p className="text-white/70">
          {restricted
            ? clans.length === 1
              ? tc('intro_locked_one')
              : tc('intro_locked_many')
            : mode === 'self'
              ? tc('intro_self')
              : tc('intro_bulk')}
        </p>

        {restricted && clans.length === 0 && (
          <div className="rounded-xl border-2 border-amber-400 bg-amber-500/15 p-4 text-amber-200">
            {tc('no_assigned_clan')}
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
                    {tc('full')}
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
                  {v?.name ?? tc('clan_fallback', { n: c.team_number })}
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
            <p className="text-2xl font-bold text-green-300">{tc('station_complete')}</p>
            <p className="text-white/70 mt-1">
              {clans.length === 1 ? tc('station_complete_one') : tc('station_complete_many')}
            </p>
          </div>
        )}

        {mode === 'self' && !stationComplete && (
          <div className="rounded-xl bg-slate-800/50 p-4 text-center">
            {selectedTeamId != null ? (
              <p className="text-lg">
                {bipBefore}
                <span className="font-bold" style={{ color: clanByTeamId[selectedTeamId]?.color }}>
                  {clanByTeamId[selectedTeamId]?.name}
                </span>
                {bipAfter}
              </p>
            ) : (
              <p className="text-white/60">{tc('select_clan_hint')}</p>
            )}
            {lastJoin && (
              <p className="mt-2 text-sm text-white/70">
                {lastJoin.status === 'ok' && tc('join_ok', { clan: lastJoinClan?.name ?? '' })}
                {lastJoin.status === 'clan_full' && tc('join_clan_full')}
                {lastJoin.status === 'already_in_clan' && tc('join_already_in_clan')}
                {lastJoin.status === 'already_in_other_clan' && tc('join_already_other_clan')}
              </p>
            )}
          </div>
        )}

        {mode === 'bulk' && (
          <div className="rounded-xl bg-slate-800/50 p-4 text-center">
            <p className="text-lg">
              {bulkBefore}
              <span className="font-semibold">{startLabel}</span>
              {bulkAfter}
            </p>
          </div>
        )}
      </div>

      <div className="sticky bottom-0 bg-slate-900/90 border-t border-white/10 p-4 flex justify-end">
        <button
          onClick={onStart}
          className="inline-flex items-center gap-2 px-8 py-3 bg-green-600 hover:bg-green-700 rounded-xl text-lg font-semibold"
        >
          <Play size={22} /> {startLabel}
        </button>
      </div>
    </div>
  );
}
