// Operator "add time" modal - extends a running game's duration by N minutes
// (bumps the server duration, which every station's timer reads via the poll).
//
// Design: project_clash_game_type_design.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Clock } from 'lucide-react';
import { addLaunchedGameTime } from '../services/launchedGames';

interface AddTimeModalProps {
  gameId: number;
  gameName?: string;
  onClose: () => void;
  /** Called with the new total duration (minutes) after a successful bump. */
  onAdded?: (newDuration: number) => void;
}

const QUICK = [1, 5, 10, 15];

export function AddTimeModal({ gameId, gameName, onClose, onAdded }: AddTimeModalProps) {
  const { t } = useTranslation();
  const [minutes, setMinutes] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    if (busy || minutes === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await addLaunchedGameTime(gameId, minutes);
      onAdded?.(res.duration);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('operatorControls:addTime.failed'));
      setBusy(false);
    }
  };

  return (
    <div className="pg-overlay" onClick={onClose}>
      <div
        className="pg-modal max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pg-modal-head">
          <h3 className="pg-modal-title flex items-center gap-2">
            <Clock size={20} className="text-emerald-400" />
            {t('operatorControls:addTime.title')}{gameName ? ` - ${gameName}` : ''}
          </h3>
          <button onClick={onClose} className="pg-modal-close">
            <X size={20} />
          </button>
        </div>

        <div className="pg-modal-body">
          <div className="grid grid-cols-4 gap-2 mb-4">
            {QUICK.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMinutes(m)}
                className={`px-3 py-2 rounded-lg text-sm font-medium border transition ${
                  minutes === m
                    ? 'border-emerald-500 bg-emerald-500/20 text-[var(--pg-text)]'
                    : 'border-[var(--pg-line)] bg-[var(--pg-bg)] text-[var(--pg-text-dim)] hover:border-[var(--pg-line-strong)]'
                }`}
              >
                +{m}
              </button>
            ))}
          </div>

          <label className="block mb-5">
            <span className="pg-label">{t('operatorControls:addTime.minutesToAdd')}</span>
            <input
              type="number"
              min={1}
              value={minutes}
              onChange={(e) => setMinutes(Math.max(1, parseInt(e.target.value) || 1))}
              className="pg-input"
            />
          </label>

          {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

          <div className="flex gap-3">
            <button
              onClick={apply}
              disabled={busy}
              className="pg-btn pg-btn--primary flex-1"
            >
              {busy ? t('operatorControls:addTime.adding') : t('operatorControls:addTime.addMinutes', { count: minutes })}
            </button>
            <button
              onClick={onClose}
              className="pg-btn"
            >
              {t('operatorControls:addTime.cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
