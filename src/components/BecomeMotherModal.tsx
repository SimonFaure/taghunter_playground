// Mother-failover slice 4/6 UI: the operator-facing "Become mother" flow.
//
// Opened by clicking the footer's "⚠ Mother unreachable" badge (a deliberate
// manual action - we intentionally do NOT auto-pop this, to avoid two operators
// promoting two devices at once; see the design's Q5/Q10). Confirms, then calls
// `becomeMother(launchedGameId)` which adopts this device's cached snapshot,
// bumps the epoch, starts the local server, and best-effort raises the
// same-named hotspot. Surfaces the content/snapshot guards as readable errors.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crown, X, AlertTriangle, Loader2, CheckCircle } from 'lucide-react';
import { becomeMother, type BecomeMotherInfo } from '../services/lanMotherBoot';

type Phase = 'confirm' | 'promoting' | 'success' | 'error';

export function BecomeMotherModal({
  launchedGameId,
  onClose,
}: {
  launchedGameId: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('confirm');
  const [error, setError] = useState<string>('');
  const [info, setInfo] = useState<BecomeMotherInfo | null>(null);

  const promote = async () => {
    setPhase('promoting');
    setError('');
    try {
      const result = await becomeMother(launchedGameId);
      setInfo(result);
      setPhase('success');
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
      setPhase('error');
    }
  };

  // While promoting, block the backdrop-close so the operator can't dismiss
  // mid-adoption.
  const dismissable = phase !== 'promoting';

  return (
    <div
      className="pg-overlay p-4"
      onClick={dismissable ? onClose : undefined}
      // Above the in-game reveal overlays (z-5000) and the failover banner
      // (z-6000). pg-overlay's own z-50 is too low to clear the game renderer.
      style={{ zIndex: 6100 }}
    >
      <div className="pg-modal max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="pg-modal-head">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-yellow-400/15 flex items-center justify-center">
              <Crown size={16} className="text-yellow-400" />
            </div>
            <h2 className="pg-modal-title">
              {t('failover:becomeMotherTitle', { defaultValue: 'Become the mother' })}
            </h2>
          </div>
          {dismissable && (
            <button onClick={onClose} className="pg-modal-close" title={t('launched:close', { defaultValue: 'Close' })}>
              <X size={16} />
            </button>
          )}
        </div>

        <div className="p-6">
          {phase === 'confirm' && (
            <div className="space-y-5">
              <p className="text-sm text-[var(--pg-text)]">
                {t('failover:becomeMotherBody', {
                  defaultValue:
                    'Make THIS device the mother for the current game. It adopts the latest saved state, and the other devices reconnect to it automatically. Use this when the original mother has crashed.',
                })}
              </p>
              <div className="flex items-center gap-2 text-xs text-[var(--pg-text-dim)]">
                <AlertTriangle size={14} className="text-yellow-400 shrink-0" />
                <span>
                  {t('failover:becomeMotherNote', {
                    defaultValue:
                      'A few seconds of scans made right before the crash may be missing. Only promote one device.',
                  })}
                </span>
              </div>
              <div className="flex gap-2.5">
                <button onClick={onClose} className="pg-btn flex-1 justify-center">
                  {t('failover:cancel', { defaultValue: 'Cancel' })}
                </button>
                <button onClick={promote} className="pg-btn pg-btn--primary flex-1 justify-center">
                  <Crown size={16} />
                  {t('failover:becomeMotherConfirm', { defaultValue: 'Become mother' })}
                </button>
              </div>
            </div>
          )}

          {phase === 'promoting' && (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <Loader2 size={28} className="animate-spin text-[var(--pg-accent-bright)]" />
              <p className="text-sm text-[var(--pg-text)]">
                {t('failover:promoting', { defaultValue: 'Promoting this device…' })}
              </p>
            </div>
          )}

          {phase === 'success' && (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-3 py-2 text-center">
                <CheckCircle size={28} className="text-green-400" />
                <p className="text-sm text-[var(--pg-text)]">
                  {t('failover:promotedBody', {
                    defaultValue:
                      'This device is now the mother. The other devices will reconnect to it within a few seconds.',
                  })}
                </p>
                {info && !info.hotspot_started && info.hotspot_error && (
                  <p className="text-xs text-yellow-400">
                    {t('failover:hotspotWarn', {
                      defaultValue:
                        'Note: the Wi-Fi hotspot could not be started automatically - start it from Settings → Network if devices cannot reconnect.',
                    })}
                  </p>
                )}
              </div>
              <button onClick={onClose} className="pg-btn pg-btn--primary w-full justify-center">
                {t('failover:done', { defaultValue: 'Done' })}
              </button>
            </div>
          )}

          {phase === 'error' && (
            <div className="space-y-5">
              <div className="flex items-start gap-2.5">
                <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-sm text-[var(--pg-text)]">{error}</p>
              </div>
              <div className="flex gap-2.5">
                <button onClick={onClose} className="pg-btn flex-1 justify-center">
                  {t('failover:close', { defaultValue: 'Close' })}
                </button>
                <button onClick={promote} className="pg-btn pg-btn--primary flex-1 justify-center">
                  {t('failover:retry', { defaultValue: 'Retry' })}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
