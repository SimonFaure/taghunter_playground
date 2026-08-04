// Operator clan-details modal (clash) - opened from the launched-game page in
// place of the quest/enigma TeamDetailsModal. Shows the clan's points,
// territories controlled, validation count, and its member chips, and lets the
// operator manually add/remove chips (clashRegister / clashUnregister).
//
// Design: project_clash_game_type_design.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Users, Flag, Plus, Trash2, Zap, ChevronUp, ChevronDown } from 'lucide-react';
import * as cardsRepo from '../services/cardsRepo';
import {
  getClashMembers,
  getClashState,
  clashRegister,
  clashUnregister,
  type ClashStandings,
} from '../services/clash';
import { getLaunchedGameState } from '../services/launchedGames';

interface ClanPunchRow {
  id: number;
  chipId: number | null;
  punches: Array<{ code: number | string; time: number | string | null }>;
  end: boolean;
  created_at: string;
}

interface ClanTeam {
  id: number;
  team_number: number;
  team_name: string | null;
}

interface ClashClanDetailsModalProps {
  clanTeam: ClanTeam;
  launchedGameId: number;
  onClose: () => void;
  onChanged?: () => void;
}

interface CardLite {
  id: number;
  key_number: number;
  key_name: string;
}

export function ClashClanDetailsModal({
  clanTeam,
  launchedGameId,
  onClose,
  onChanged,
}: ClashClanDetailsModalProps) {
  const { t } = useTranslation();
  const [cards, setCards] = useState<CardLite[]>([]);
  const [memberChipIds, setMemberChipIds] = useState<number[]>([]);
  const [allMemberChipIds, setAllMemberChipIds] = useState<Set<number>>(new Set());
  const [standings, setStandings] = useState<ClashStandings | null>(null);
  const [punchRows, setPunchRows] = useState<ClanPunchRow[]>([]);
  const [expandedPunch, setExpandedPunch] = useState<number | null>(null);
  const [addChipId, setAddChipId] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const cardLabel = useCallback(
    (chipId: number) => {
      const c = cards.find((x) => x.id === chipId);
      return c
        ? `#${c.key_number}${c.key_name ? ` - ${c.key_name}` : ''}`
        : t('clashClanDetails:chipFallback', { id: chipId });
    },
    [cards, t],
  );

  // "Alice - (n°12 - id 8012345)": who punched, plus the chip's number and id.
  // Mirrors TeamDetailsModal's punch rows; falls back to the clan name when the
  // chip isn't in the card registry (so it has no carrier name).
  const chipHolderLabel = useCallback(
    (chipId: number) => {
      const c = cards.find((x) => x.id === chipId);
      const name =
        c?.key_name || clanTeam.team_name || t('clashClanDetails:clanFallback', { number: clanTeam.team_number });
      return c
        ? t('clashClanDetails:chipHolder', { name, number: c.key_number, id: chipId })
        : t('clashClanDetails:chipHolderNoNumber', { name, id: chipId });
    },
    [cards, clanTeam.team_name, clanTeam.team_number, t],
  );

  const refresh = useCallback(async () => {
    try {
      const [members, state, gameState] = await Promise.all([
        getClashMembers(launchedGameId),
        getClashState(launchedGameId),
        getLaunchedGameState(launchedGameId, 0),
      ]);
      const myChipIds = members.filter((m) => m.team_id === clanTeam.id).map((m) => m.chip_id);
      setMemberChipIds(myChipIds);
      setAllMemberChipIds(new Set(members.map((m) => m.chip_id)));
      setStandings(state);
      // Punches: the clan's card-reads - every raw_data row whose chip belongs to
      // this clan (mirrors how TeamDetailsModal filters punches to a team's chips).
      const chipSet = new Set(myChipIds.map(Number));
      const rows: ClanPunchRow[] = (gameState.new_raw_data ?? [])
        .map((r) => {
          const rd = (r.raw_data ?? {}) as {
            id?: number;
            punches?: Array<{ code: number | string; time: number | string | null }>;
            end?: number | boolean;
          };
          return {
            id: r.id,
            chipId: rd.id != null ? Number(rd.id) : null,
            punches: rd.punches ?? [],
            end: Boolean(rd.end),
            created_at: r.created_at,
          };
        })
        .filter((row) => row.chipId != null && chipSet.has(row.chipId))
        .sort((a, b) => a.id - b.id);
      setPunchRows(rows);
    } catch (err) {
      console.error('[ClashClanDetails] refresh failed', err);
    }
  }, [launchedGameId, clanTeam.id]);

  useEffect(() => {
    void cardsRepo.list().then((rows) =>
      setCards(rows.map((r) => ({ id: r.id, key_number: r.key_number, key_name: r.key_name }))),
    );
    void refresh();
  }, [refresh]);

  const standing = standings?.clans.find((c) => c.team_id === clanTeam.id);
  const points = standing?.points ?? 0;
  const ownedTerritories = (standings?.territories ?? []).filter(
    (t) => t.owner_team_id === clanTeam.id,
  );
  const validations = (standings?.territories ?? []).reduce(
    (n, t) => n + (t.counts[String(clanTeam.id)] ?? 0),
    0,
  );

  // Cards not yet bound to any clan in this game.
  const availableCards = cards.filter((c) => !allMemberChipIds.has(c.id));

  const handleAdd = async () => {
    if (busy || addChipId === '') return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await clashRegister(launchedGameId, clanTeam.id, Number(addChipId));
      if (res.status === 'ok') {
        setAddChipId('');
        await refresh();
        onChanged?.();
      } else {
        setNotice(
          res.status === 'clan_full'
            ? t('clashClanDetails:clanFull')
            : res.status === 'already_in_other_clan'
              ? t('clashClanDetails:alreadyOtherClan')
              : res.status === 'already_in_clan'
                ? t('clashClanDetails:alreadyInClan')
                : t('clashClanDetails:couldNotAdd'),
        );
      }
    } catch {
      setNotice(t('clashClanDetails:couldNotAdd'));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (chipId: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await clashUnregister(launchedGameId, chipId);
      await refresh();
      onChanged?.();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pg-overlay" onClick={onClose}>
      <div
        className="pg-modal max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pg-modal-head">
          <h3 className="pg-modal-title flex items-center gap-2">
            <Flag size={20} className="text-blue-400" />
            {clanTeam.team_name || t('clashClanDetails:clanFallback', { number: clanTeam.team_number })}
          </h3>
          <button onClick={onClose} className="pg-modal-close">
            <X size={20} />
          </button>
        </div>

        <div className="pg-modal-body space-y-5">
          {/* Summary */}
          <div className="grid grid-cols-3 gap-3">
            <div className="pg-stat">
              <div className="pg-stat-value">{points}</div>
              <div className="pg-stat-label">{t('clashClanDetails:points')}</div>
            </div>
            <div className="pg-stat">
              <div className="pg-stat-value">{memberChipIds.length}</div>
              <div className="pg-stat-label">{t('clashClanDetails:members')}</div>
            </div>
            <div className="pg-stat">
              <div className="pg-stat-value">{validations}</div>
              <div className="pg-stat-label">{t('clashClanDetails:validations')}</div>
            </div>
          </div>

          {/* Territories controlled */}
          <div>
            <h4 className="text-sm font-semibold text-[var(--pg-text-muted)] mb-2">{t('clashClanDetails:territoriesControlled')}</h4>
            {ownedTerritories.length === 0 ? (
              <p className="text-sm text-[var(--pg-text-dim)]">{t('clashClanDetails:noneYet')}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {ownedTerritories.map((terr) => (
                  <span key={terr.index} className="text-xs px-2 py-1 rounded bg-blue-600/30 text-blue-200 border border-blue-600/40">
                    {t('clashClanDetails:territoryChip', { number: terr.index + 1, points: terr.points })}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Members */}
          <div>
            <h4 className="text-sm font-semibold text-[var(--pg-text-muted)] mb-2 flex items-center gap-1.5">
              <Users size={15} /> {t('clashClanDetails:memberChips', { count: memberChipIds.length })}
            </h4>
            {memberChipIds.length === 0 ? (
              <p className="text-sm text-[var(--pg-text-dim)]">{t('clashClanDetails:noChipsBound')}</p>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {memberChipIds.map((chipId) => (
                  <div key={chipId} className="flex items-center gap-2 rounded bg-[var(--pg-surface-2)] px-3 py-1.5">
                    <span className="text-sm text-[var(--pg-text)] flex-1">{cardLabel(chipId)}</span>
                    <button
                      onClick={() => handleRemove(chipId)}
                      disabled={busy}
                      className="p-1 text-red-400 hover:bg-red-500/10 rounded disabled:opacity-40"
                      aria-label={t('clashClanDetails:removeChip')}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add chip */}
          <div>
            <h4 className="text-sm font-semibold text-[var(--pg-text-muted)] mb-2">{t('clashClanDetails:addChipHeading')}</h4>
            <div className="flex gap-2">
              <select
                value={addChipId}
                onChange={(e) => setAddChipId(e.target.value === '' ? '' : Number(e.target.value))}
                className="pg-select flex-1"
              >
                <option value="">{t('clashClanDetails:selectChip')}</option>
                {availableCards.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.key_number}{c.key_name ? ` - ${c.key_name}` : ''}
                  </option>
                ))}
              </select>
              <button
                onClick={handleAdd}
                disabled={busy || addChipId === ''}
                className="pg-btn pg-btn--primary"
              >
                <Plus size={15} /> {t('clashClanDetails:add')}
              </button>
            </div>
            {notice && <p className="text-sm text-amber-400 mt-2">{notice}</p>}
          </div>

          {/* Punches - the clan's card-reads (across all member chips) */}
          <div>
            <h4 className="text-sm font-semibold text-[var(--pg-text-muted)] mb-2 flex items-center gap-1.5">
              <Zap size={15} /> {t('clashClanDetails:punchesHeading', { count: punchRows.length })}
            </h4>
            {punchRows.length === 0 ? (
              <p className="text-sm text-[var(--pg-text-dim)]">{t('clashClanDetails:noCardReads')}</p>
            ) : (
              <div className="space-y-2">
                {punchRows.map((rec, i) => {
                  const isExpanded = expandedPunch === rec.id;
                  return (
                    <div key={rec.id} className="bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-lg overflow-hidden">
                      <button
                        className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--pg-surface-3)] transition text-left"
                        onClick={() => setExpandedPunch(isExpanded ? null : rec.id)}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[var(--pg-text-dim)] text-xs shrink-0">#{i + 1}</span>
                          <span className="text-[var(--pg-text)] text-sm font-medium truncate">
                            {rec.chipId != null
                              ? chipHolderLabel(rec.chipId)
                              : clanTeam.team_name || t('clashClanDetails:clanFallback', { number: clanTeam.team_number })}
                          </span>
                          <span className="text-[var(--pg-text-dim)] text-sm shrink-0">
                            - {t('clashClanDetails:stationCount', { count: rec.punches.length })}
                          </span>
                          {rec.end && (
                            <span className="px-1.5 py-0.5 bg-green-900/50 border border-green-700/50 rounded text-green-400 text-xs shrink-0">
                              {t('clashClanDetails:end')}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[var(--pg-text-dim)] text-xs">
                            {new Date(rec.created_at).toLocaleTimeString()}
                          </span>
                          {isExpanded ? (
                            <ChevronUp size={14} className="text-[var(--pg-text-dim)]" />
                          ) : (
                            <ChevronDown size={14} className="text-[var(--pg-text-dim)]" />
                          )}
                        </div>
                      </button>
                      {isExpanded && (
                        <div className="border-t border-[var(--pg-line)] px-3 py-2">
                          {rec.punches.length === 0 ? (
                            <p className="text-xs text-[var(--pg-text-dim)]">{t('clashClanDetails:noStations')}</p>
                          ) : (
                            <table className="pg-table !text-xs">
                              <thead>
                                <tr>
                                  <th>{t('clashClanDetails:stationCode')}</th>
                                  <th className="!text-right">{t('clashClanDetails:punchTime')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {rec.punches.map((p, j) => (
                                  <tr key={j}>
                                    <td className="text-[var(--pg-text)] font-mono">{p.code}</td>
                                    <td className="text-right text-[var(--pg-text-dim)]">
                                      {p.time != null && String(p.time) !== '00:00:00' ? String(p.time) : '-'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
