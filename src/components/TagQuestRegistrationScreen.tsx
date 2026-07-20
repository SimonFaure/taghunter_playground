// TagQuest registration - players bind their chip to a team before the match,
// mirroring Clash's self-register flow (clashRegistrationMode='self').
//
// Team mode: the operator selects a predefined team on this station, then
// players bip their chip to join it (a station left on one team acts as a
// dedicated join reader). Full teams grey out, and the station's selection
// auto-advances to the next team with room (handled by TagQuestGamePage).
// Binding is server-authoritative (reuses clashRegister / lg_clash_members).
// Solo mode: each bipped chip enrols itself as its own team - no team to pick,
// just a growing roster.
//
// Purely presentational: the reader→register wiring lives in TagQuestGamePage
// (handleRegisterCard), which also polls the live counts fed in via props.

import { useEffect, useState } from 'react';
import { Play, Users, ArrowLeft, Check, AlertTriangle } from 'lucide-react';

export interface TagQuestRegTeam {
  team_id: number;
  team_number: number;
  team_name: string;
  /** Live member count (team mode). Solo teams are always a party of one. */
  member_count: number;
}

export interface TagQuestRegJoin {
  teamId: number;
  status: string;
  /** Changes on every outcome so repeat joins re-trigger the flash. */
  nonce: number;
}

interface TagQuestRegistrationScreenProps {
  playMode: 'solo' | 'team';
  /** Team mode: the predefined teams with live counts. Solo: the players
   *  enrolled so far (one team per chip). */
  teams: TagQuestRegTeam[];
  /** Max players per team; 0 ⇒ unlimited (team mode only). */
  maxPerTeam: number;
  selectedTeamId: number | null;
  onSelectTeam: (teamId: number) => void;
  onStart: () => void;
  onBack: () => void;
  /** Last self-register outcome, surfaced as a big transient flash. */
  lastJoin: TagQuestRegJoin | null;
  /** Scenario background image URL; empty ⇒ the slate gradient fallback. */
  backgroundUrl?: string;
  /** Station assignment (team mode): this station is hard-locked to the teams
   *  in `teams` (the page pre-filters the list) - adjust the copy and show a
   *  "station complete" state when every assigned team fills up.
   *  Design: project_selfregister_team_device_assignment. */
  restricted?: boolean;
}

function teamIsFull(memberCount: number, maxPerTeam: number): boolean {
  return maxPerTeam > 0 && memberCount >= maxPerTeam;
}

// How long the join flash stays on screen.
const JOIN_FLASH_MS = 2600;

function joinFlashCopy(
  status: string,
  teamName: string,
  playMode: 'solo' | 'team',
): { text: string; tone: 'ok' | 'warn' } {
  switch (status) {
    case 'ok':
      // Solo can flash before the poll delivers the freshly-created team row -
      // fall back to a generic line rather than an empty name.
      if (!teamName) return { text: playMode === 'team' ? 'Joined!' : 'Player enrolled!', tone: 'ok' };
      return {
        text: playMode === 'team' ? `Joined ${teamName}!` : `${teamName} enrolled!`,
        tone: 'ok',
      };
    case 'clan_full':
      return { text: 'Team full - moved to the next team, bip again', tone: 'warn' };
    case 'already_in_clan':
      return {
        text: playMode === 'team' ? `Already in ${teamName}` : 'Already enrolled',
        tone: 'warn',
      };
    case 'already_in_other_clan':
      return { text: 'Chip already belongs to another team', tone: 'warn' };
    default:
      return { text: 'Team not found', tone: 'warn' };
  }
}

export function TagQuestRegistrationScreen({
  playMode,
  teams,
  maxPerTeam,
  selectedTeamId,
  onSelectTeam,
  onStart,
  onBack,
  lastJoin,
  backgroundUrl,
  restricted = false,
}: TagQuestRegistrationScreenProps) {
  const selectedTeam = teams.find((t) => t.team_id === selectedTeamId) ?? null;
  // Station assignment: every assigned team full ⇒ this station's job is done.
  const stationComplete =
    restricted &&
    playMode === 'team' &&
    teams.length > 0 &&
    teams.every((t) => teamIsFull(t.member_count, maxPerTeam));

  // Transient copy of the last outcome - shown big, then auto-dismissed. Keyed
  // on the nonce so back-to-back joins on the same team re-animate.
  const [joinFlash, setJoinFlash] = useState<TagQuestRegJoin | null>(null);
  useEffect(() => {
    if (!lastJoin) return;
    setJoinFlash(lastJoin);
    const h = setTimeout(() => setJoinFlash(null), JOIN_FLASH_MS);
    return () => clearTimeout(h);
  }, [lastJoin]);

  const flashTeam = joinFlash ? teams.find((t) => t.team_id === joinFlash.teamId) ?? null : null;
  const flash = joinFlash
    ? joinFlashCopy(
        joinFlash.status,
        flashTeam?.team_name ||
          (flashTeam
            ? (playMode === 'team' ? `Équipe ${flashTeam.team_number}` : `Joueur ${flashTeam.team_number}`)
            : ''),
        playMode,
      )
    : null;
  // The tile that just gained a member pulses green while the flash is up.
  const flashOkTeamId = joinFlash?.status === 'ok' ? joinFlash.teamId : null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white overflow-auto">
      {/* Scenario background + a dark scrim to keep the UI readable. */}
      {backgroundUrl && (
        <>
          <img
            src={backgroundUrl}
            alt=""
            className="fixed inset-0 w-full h-full object-cover"
          />
          <div className="fixed inset-0 bg-slate-900/75" />
        </>
      )}

      <style>{`
        @keyframes tqJoinPop {
          0% { transform: scale(0.55); opacity: 0; }
          55% { transform: scale(1.06); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes tqTilePulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.7); }
          50% { box-shadow: 0 0 0 10px rgba(74, 222, 128, 0); }
        }
      `}</style>

      <div className="relative flex-1 max-w-5xl w-full mx-auto p-8 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">
            {playMode === 'team' ? 'Team registration' : 'Player registration'}
          </h1>
          <button onClick={onBack} className="text-sm text-white/60 hover:text-white flex items-center gap-1">
            <ArrowLeft size={16} /> Back
          </button>
        </div>

        <p className="text-white/70">
          {playMode === 'team'
            ? restricted
              ? teams.length === 1
                ? 'This station registers one team only - players bip their chip here to join it.'
                : 'This station registers the teams below only - pick one, then players bip their chip to join it.'
              : 'Select a team on this station, then players bip their chip to join it. Leave a station on one team to use it as a dedicated join reader.'
            : 'Each player bips their chip to enrol - a team is created per chip. Start the game once everyone has joined.'}
        </p>

        {restricted && playMode === 'team' && teams.length === 0 && (
          <div className="rounded-xl border-2 border-amber-400 bg-amber-500/15 p-4 text-amber-200">
            No team matches this station's assignment - ask the operator to update it from the
            Devices panel.
          </div>
        )}

        {playMode === 'team' ? (
          <>
            {/* Team cards with live counts - centered, sized up when few teams
                show (a locked station usually shows 1-3), readable from across
                the room. */}
            <div className="flex flex-wrap justify-center gap-5 py-2">
              {teams.map((t) => {
                const full = teamIsFull(t.member_count, maxPerTeam);
                const selected = selectedTeamId === t.team_id;
                const justJoined = flashOkTeamId === t.team_id;
                const pct = maxPerTeam > 0 ? Math.min(100, (t.member_count / maxPerTeam) * 100) : 0;
                const sizeCls =
                  teams.length <= 2 ? 'w-80 p-8' : teams.length === 3 ? 'w-72 p-7' : 'w-64 p-6';
                return (
                  <button
                    key={t.team_id}
                    type="button"
                    disabled={full}
                    onClick={() => onSelectTeam(t.team_id)}
                    style={justJoined ? { animation: 'tqTilePulse 0.9s ease-out 2' } : undefined}
                    className={`relative ${sizeCls} max-w-full rounded-2xl border-2 text-center transition-all duration-200 ${
                      full
                        ? 'border-slate-700 bg-slate-800/40 opacity-40 cursor-not-allowed'
                        : justJoined
                          ? 'border-green-400 bg-green-500/15'
                          : selected
                            ? 'border-white bg-white/10 ring-4 ring-white/20 shadow-2xl'
                            : 'border-slate-700 bg-slate-800/60 hover:border-slate-400 hover:bg-slate-800 active:scale-95'
                    }`}
                  >
                    {/* Selected = the team this station enrols into. A check
                        badge on top of the border change - never color alone. */}
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
                    <div className="text-2xl font-bold leading-tight break-words mb-4">
                      {t.team_name || `Équipe ${t.team_number}`}
                    </div>
                    <div
                      className={`flex items-baseline justify-center gap-2 ${
                        justJoined ? 'text-green-300' : 'text-white'
                      }`}
                    >
                      <Users size={22} className="self-center opacity-60" />
                      <span className="text-4xl font-extrabold tabular-nums leading-none">
                        {t.member_count}
                      </span>
                      {maxPerTeam > 0 && (
                        <span className="text-xl font-semibold text-white/50 tabular-nums">
                          / {maxPerTeam}
                        </span>
                      )}
                    </div>
                    {maxPerTeam > 0 && (
                      <div className="mt-4 h-1.5 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            full ? 'bg-amber-400' : justJoined ? 'bg-green-400' : 'bg-white/70'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {stationComplete ? (
              <div className="rounded-xl border-2 border-green-400 bg-green-500/15 p-5 text-center">
                <p className="text-2xl font-bold text-green-300">Registration complete on this station</p>
                <p className="text-white/70 mt-1">
                  {teams.length === 1 ? 'The assigned team is full.' : 'All assigned teams are full.'}
                </p>
              </div>
            ) : (
              <div className="rounded-xl bg-slate-800/50 p-4 text-center">
                {selectedTeam ? (
                  <p className="text-lg">
                    Bip a chip to join <span className="font-bold">{selectedTeam.team_name || `Équipe ${selectedTeam.team_number}`}</span>
                  </p>
                ) : (
                  <p className="text-white/60">Select a team above to start enrolling players.</p>
                )}
              </div>
            )}
          </>
        ) : (
          /* Solo: growing list of enrolled players. */
          <div className="rounded-xl bg-slate-800/50 p-4 space-y-3">
            <div className="flex items-center gap-2 text-white/70">
              <Users size={16} />
              {teams.length} {teams.length === 1 ? 'player enrolled' : 'players enrolled'}
            </div>
            {teams.length === 0 ? (
              <p className="text-white/50 text-sm">Waiting for the first bip…</p>
            ) : (
              <ul className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {teams.map((t) => {
                  const justJoined = flashOkTeamId === t.team_id;
                  return (
                    <li
                      key={t.team_id}
                      style={justJoined ? { animation: 'tqTilePulse 0.9s ease-out 2' } : undefined}
                      className={`px-3 py-2 rounded-lg truncate text-sm ${
                        justJoined ? 'bg-green-500/20 border border-green-400 font-semibold' : 'bg-slate-900/60'
                      }`}
                    >
                      {t.team_name || `Joueur ${t.team_number}`}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Big transient join flash - unmissable across the room. */}
      {joinFlash && flash && (
        <div className="pointer-events-none fixed inset-0 z-[110] flex items-center justify-center p-8">
          <div
            key={joinFlash.nonce}
            style={{ animation: 'tqJoinPop 0.35s cubic-bezier(0.34, 1.4, 0.64, 1) both' }}
            className={`flex items-center gap-4 px-10 py-7 rounded-2xl border-2 shadow-2xl max-w-full ${
              flash.tone === 'ok'
                ? 'bg-green-600/95 border-green-300'
                : 'bg-amber-600/95 border-amber-300'
            }`}
          >
            {flash.tone === 'ok' ? (
              <Check size={44} strokeWidth={3} className="shrink-0" />
            ) : (
              <AlertTriangle size={40} className="shrink-0" />
            )}
            <span className="text-3xl font-bold truncate">{flash.text}</span>
          </div>
        </div>
      )}

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
