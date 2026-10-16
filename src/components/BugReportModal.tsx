// Licensee "Report a problem" modal, opened from the launched-games page (the
// button right after Raw Data). The comment goes to studio together with a
// snapshot of the game (teams, raw punches, config, this device's console log).
// Delivery + snapshot: services/bugReport.ts. Design: project_bug_report_button.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Bug, Loader2, CheckCircle, CloudOff, AlertTriangle, ChevronRight } from 'lucide-react';
import type { LaunchedGameStatePayload, TeamRow } from '../services/launchedGames';
import {
  type BugReportGame,
  BUG_REPORT_MAX_COMMENT,
  BUG_REPORT_MIN_COMMENT,
  loadGameState,
  sendBugReport,
} from '../services/bugReport';

interface BugReportModalProps {
  game: BugReportGame;
  /** This device is viewing its mother's games (it is a child). */
  isChildView: boolean;
  onClose: () => void;
}

type Phase = 'form' | 'sending' | 'sent' | 'queued';

export function BugReportModal({ game, isChildView, onClose }: BugReportModalProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<LaunchedGameStatePayload | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState(true);
  const [comment, setComment] = useState('');
  const [selectedTeams, setSelectedTeams] = useState<Set<number>>(new Set());
  const [showDetails, setShowDetails] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadGameState(game.id).then(({ state: s, error: e }) => {
      if (cancelled) return;
      setState(s);
      setStateError(e);
      setLoadingState(false);
    });
    return () => {
      cancelled = true;
    };
  }, [game.id]);

  const teams: TeamRow[] = [...(state?.teams ?? [])].sort((a, b) => a.team_number - b.team_number);
  const punchCount = state?.new_raw_data?.length ?? 0;
  const commentOk = comment.trim().length >= BUG_REPORT_MIN_COMMENT;
  const busy = phase === 'sending';

  const toggleTeam = (id: number) => {
    setSelectedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const send = async () => {
    if (!commentOk || busy) return;
    setPhase('sending');
    setError(null);
    try {
      const outcome = await sendBugReport({
        game,
        state,
        stateError,
        isChildView,
        comment,
        teamsConcerned: teams.filter((tm) => selectedTeams.has(tm.id)),
      });
      setPhase(outcome);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('form');
    }
  };

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <div className="pg-overlay" onClick={close}>
      <div className="pg-modal max-w-xl" onClick={(e) => e.stopPropagation()}>
        <div className="pg-modal-head">
          <div className="min-w-0">
            <h3 className="pg-modal-title flex items-center gap-2">
              <Bug size={20} className="text-yellow-400" />
              {t('bugReport:title')}
            </h3>
            <p className="pg-modal-sub truncate">
              {t('bugReport:gameLine', { name: game.name, type: game.game_type || '-', id: game.id })}
            </p>
          </div>
          <button onClick={close} className="pg-modal-close" disabled={busy}>
            <X size={20} />
          </button>
        </div>

        {phase === 'sent' || phase === 'queued' ? (
          <div className="pg-modal-body">
            <div className="flex flex-col items-center text-center py-6 gap-3">
              {phase === 'sent' ? (
                <CheckCircle size={44} className="text-emerald-400" />
              ) : (
                <CloudOff size={44} className="text-amber-400" />
              )}
              <p className="text-[var(--pg-text)] font-semibold">
                {phase === 'sent' ? t('bugReport:sentTitle') : t('bugReport:queuedTitle')}
              </p>
              <p className="text-sm text-[var(--pg-text-dim)] max-w-sm">
                {phase === 'sent' ? t('bugReport:sentBody') : t('bugReport:queuedBody')}
              </p>
            </div>
            <div className="flex justify-end">
              <button onClick={onClose} className="pg-btn pg-btn--primary">
                {t('bugReport:close')}
              </button>
            </div>
          </div>
        ) : (
          <div className="pg-modal-body space-y-4">
            <label className="block">
              <span className="pg-label">{t('bugReport:commentLabel')} *</span>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value.slice(0, BUG_REPORT_MAX_COMMENT))}
                rows={6}
                autoFocus
                disabled={busy}
                placeholder={t('bugReport:commentPlaceholder')}
                className="pg-textarea"
              />
              <span className="block text-right text-[11px] text-[var(--pg-text-dim)] mt-1">
                {comment.trim().length > 0 && !commentOk
                  ? t('bugReport:commentTooShort', { count: BUG_REPORT_MIN_COMMENT })
                  : `${comment.length} / ${BUG_REPORT_MAX_COMMENT}`}
              </span>
            </label>

            <div>
              <span className="pg-label">{t('bugReport:teamsLabel')}</span>
              {loadingState ? (
                <p className="text-sm text-[var(--pg-text-dim)] flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" /> {t('bugReport:loadingGame')}
                </p>
              ) : teams.length === 0 ? (
                <p className="text-sm text-[var(--pg-text-dim)]">
                  {stateError ? t('bugReport:teamsUnavailable') : t('bugReport:noTeams')}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
                  {teams.map((tm) => {
                    const on = selectedTeams.has(tm.id);
                    return (
                      <button
                        key={tm.id}
                        type="button"
                        disabled={busy}
                        onClick={() => toggleTeam(tm.id)}
                        className={`px-3 py-1.5 rounded-lg text-sm border transition ${
                          on
                            ? 'border-yellow-500 bg-yellow-500/20 text-[var(--pg-text)]'
                            : 'border-[var(--pg-line)] bg-[var(--pg-bg)] text-[var(--pg-text-dim)] hover:border-[var(--pg-line-strong)]'
                        }`}
                      >
                        {tm.team_name || t('bugReport:teamNumber', { n: tm.team_number })}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {stateError && !loadingState && (
              <div className="p-3 bg-amber-500/15 border border-amber-500/40 text-amber-200 rounded-lg text-sm flex items-start gap-2">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>{t('bugReport:snapshotUnavailable')}</span>
              </div>
            )}

            <div>
              <button
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                className="flex items-center gap-1.5 text-sm text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] transition"
              >
                <ChevronRight size={14} className={`transition-transform ${showDetails ? 'rotate-90' : ''}`} />
                {t('bugReport:whatIsSent')}
              </button>
              {showDetails && (
                <ul className="mt-2 ml-5 list-disc text-sm text-[var(--pg-text-dim)] space-y-1">
                  <li>{t('bugReport:sentComment')}</li>
                  <li>{t('bugReport:sentGame')}</li>
                  <li>{t('bugReport:sentTeams', { count: teams.length })}</li>
                  <li>{t('bugReport:sentPunches', { count: punchCount })}</li>
                  <li>{t('bugReport:sentDevice')}</li>
                  <li>{t('bugReport:sentLog')}</li>
                </ul>
              )}
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <div className="flex justify-end gap-3">
              <button onClick={close} disabled={busy} className="pg-btn">
                {t('bugReport:cancel')}
              </button>
              <button
                onClick={send}
                disabled={!commentOk || busy || loadingState}
                className="pg-btn pg-btn--primary"
              >
                {busy ? (
                  <>
                    <Loader2 size={16} className="animate-spin" /> {t('bugReport:sending')}
                  </>
                ) : (
                  t('bugReport:send')
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
