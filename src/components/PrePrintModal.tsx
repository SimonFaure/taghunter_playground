/**
 * Pre-print modal: paper size + orientation, shown every time the operator
 * prints a mission report from the launched-games page. Always opens on the
 * DEFAULT format (studio-synced, else built-in ticket); an adjustment applies
 * to this print only and is never persisted - the next print proposes the
 * default again. The chosen prefs are handed to onConfirm and travel with the
 * print job explicitly.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Printer, X } from 'lucide-react';
import {
  getPrintPrefs,
  cssPageSize,
  PAPER_PRESETS,
  type PrintPrefs,
  type PaperSizeId,
  type Orientation,
} from '../services/printPrefsStore';

interface Props {
  /** The game / team name shown under the title. */
  subject: string;
  onCancel: () => void;
  /** Receives the format to use for this print only. */
  onConfirm: (prefs: PrintPrefs) => void;
}

export function PrePrintModal({ subject, onCancel, onConfirm }: Props) {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<PrintPrefs>(() => getPrintPrefs());

  const update = (patch: Partial<PrintPrefs>) => {
    setPrefs((prev) => ({ ...prev, ...patch }));
  };

  const handlePrint = () => {
    onConfirm(prefs);
  };

  return (
    <div className="pg-overlay p-4" onClick={onCancel}>
      <div className="pg-modal max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="pg-modal-head">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-400/15 flex items-center justify-center">
              <Printer size={16} className="text-sky-400" />
            </div>
            <h2 className="pg-modal-title">{t('printing:modalTitle')}</h2>
          </div>
          <button onClick={onCancel} className="pg-modal-close" title={t('printing:modalCancel')}>
            <X size={16} />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <p className="text-sm text-[var(--pg-text-dim)] truncate">{subject}</p>

          {/* Paper size */}
          <label className="block">
            <span className="pg-label mb-1.5 block">{t('printing:paperLabel')}</span>
            <select
              value={prefs.paper}
              onChange={(e) => update({ paper: e.target.value as PaperSizeId })}
              className="pg-select w-full"
            >
              {PAPER_PRESETS.map((p) => (
                <option key={p} value={p}>{t(`printing:paper_${p}`)}</option>
              ))}
            </select>
          </label>

          {/* Custom dimensions */}
          {prefs.paper === 'custom' && (
            <div className="flex gap-3">
              <label className="flex-1">
                <span className="pg-label mb-1 block">{t('printing:customWidth')}</span>
                <input
                  type="number" min={10} max={2000}
                  value={prefs.customMm.width}
                  onChange={(e) => update({ customMm: { ...prefs.customMm, width: Number(e.target.value) || 0 } })}
                  className="pg-input w-full"
                />
              </label>
              <label className="flex-1">
                <span className="pg-label mb-1 block">{t('printing:customHeight')}</span>
                <input
                  type="number" min={10} max={2000}
                  value={prefs.customMm.height}
                  onChange={(e) => update({ customMm: { ...prefs.customMm, height: Number(e.target.value) || 0 } })}
                  className="pg-input w-full"
                />
              </label>
            </div>
          )}

          {/* Orientation */}
          <div>
            <span className="pg-label mb-1.5 block">{t('printing:orientationLabel')}</span>
            <div className="pg-pill-group flex">
              {(['portrait', 'landscape'] as Orientation[]).map((o) => (
                <button
                  key={o}
                  onClick={() => update({ orientation: o })}
                  className={`pg-pill flex-1${prefs.orientation === o ? ' is-active' : ''}`}
                >
                  {t(`printing:orientation_${o}`)}
                </button>
              ))}
            </div>
          </div>

          <p className="text-xs text-[var(--pg-text-dim)]">{t('printing:pageSizePreview', { size: cssPageSize(prefs) })}</p>
          <p className="text-xs text-[var(--pg-text-dim)]">{t('printing:printerPaperNote')}</p>

          <div className="flex gap-3 pt-1">
            <button onClick={onCancel} className="pg-btn flex-1 justify-center">
              {t('printing:modalCancel')}
            </button>
            <button onClick={handlePrint} className="pg-btn pg-btn--primary flex-1 justify-center">
              <Printer size={16} /> {t('printing:modalPrint')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
