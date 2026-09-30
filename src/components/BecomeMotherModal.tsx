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
import { Crown, X, AlertTriangle, Loader2, CheckCircle, Wifi } from 'lucide-react';
import {
  promoteUnlessTakenOver,
  raiseMotherHotspotIfConfigured,
  type BecomeMotherInfo,
} from '../services/lanMotherBoot';
import { refreshLaunchedGamesRoute } from '../services/childControlLink';
import { useAuth } from './auth/AuthProvider';
import { hotspotStatus } from '../services/lanPairing';
import { getNetworkSource } from '../services/lanCredentials';
import { ErrorDetails } from './ErrorDetails';

// 'partial' = the game was adopted and we ARE serving it, but the Wi-Fi access
// point is not up. That is NOT a success to the operator: with no AP there is no
// LAN, so no satellite can reach us and the game cannot actually continue. It
// used to render as the plain green success panel (the yellow note required a
// non-null hotspot_error, which the missing-creds path never set), which is
// exactly why an operator saw "success" and nothing happened.
// 'joined' = another satellite had already taken over: this one joined it
// instead of becoming a second mother (retours sept. #10, first click wins).
type Phase = 'confirm' | 'promoting' | 'success' | 'partial' | 'joined' | 'error';

export function BecomeMotherModal({
  launchedGameId,
  onClose,
}: {
  launchedGameId: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const [phase, setPhase] = useState<Phase>('confirm');
  const [takerLabel, setTakerLabel] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [source, setSource] = useState<string>('hotspot');
  const [info, setInfo] = useState<BecomeMotherInfo | null>(null);
  const [retryingAp, setRetryingAp] = useState(false);

  // Promotion "succeeded" only if the other devices can actually reach us. In
  // hotspot mode that means the AP is up: without it there is no LAN at all.
  const settle = async (result: BecomeMotherInfo) => {
    setInfo(result);
    const src = await getNetworkSource().catch(() => 'hotspot');
    setSource(src);
    if (result.hotspot_started) {
      setPhase('success');
      return;
    }
    setPhase(src === 'hotspot' ? 'partial' : 'success');
  };

  const promote = async () => {
    setPhase('promoting');
    setError(null);
    try {
      const outcome = await promoteUnlessTakenOver(launchedGameId, auth.user?.client_id);
      if (outcome.kind === 'joined') {
        setTakerLabel(outcome.taker.label);
        await refreshLaunchedGamesRoute().catch(() => {});
        setPhase('joined');
        return;
      }
      await settle(outcome.info);
    } catch (e) {
      setError(e);
      setPhase('error');
    }
  };

  // Retry ONLY the access point - the game is already adopted and served, so we
  // must never re-run becomeMother here (it would bump the epoch and re-adopt a
  // now-staler snapshot).
  const retryHotspot = async () => {
    setRetryingAp(true);
    try {
      await raiseMotherHotspotIfConfigured();
      const st = await hotspotStatus().catch(() => null);
      if (st?.running) {
        setInfo((prev) => (prev ? { ...prev, hotspot_started: true, hotspot_error: null } : prev));
        setPhase('success');
      }
    } finally {
      setRetryingAp(false);
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
                  {/* "within a few seconds" is only true on a router: in hotspot mode
                      the satellites first have to find the NEW Wi-Fi (retours
                      sept. #19). */}
                  {source === 'hotspot' ? t('failover:promotedBodyHotspot') : t('failover:promotedBody')}
                </p>
                <p className="text-xs text-[var(--pg-text-dim)]">
                  {t('failover:stickyMotherNote', {
                    defaultValue:
                      'This device will keep hosting on the next start. To undo: Settings → Network → "I am not a mother".',
                  })}
                </p>
              </div>
              <button onClick={onClose} className="pg-btn pg-btn--primary w-full justify-center">
                {t('failover:done', { defaultValue: 'Done' })}
              </button>
            </div>
          )}

          {phase === 'joined' && (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-3 py-2 text-center">
                <CheckCircle size={28} className="text-green-400" />
                <p className="text-sm text-[var(--pg-text)]">
                  {t('failover:alreadyTakenOver', { name: takerLabel || t('failover:anotherDevice') })}
                </p>
              </div>
              <button onClick={onClose} className="pg-btn pg-btn--primary w-full justify-center">
                {t('failover:done', { defaultValue: 'Done' })}
              </button>
            </div>
          )}

          {/* Adopted and serving, but no Wi-Fi: deliberately NOT a green success.
              With no access point there is no LAN, so no other device can reach
              this one and the game cannot actually continue. */}
          {phase === 'partial' && (
            <div className="space-y-5">
              <div className="flex items-start gap-2.5">
                <Wifi size={18} className="text-yellow-400 shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <p className="text-sm text-[var(--pg-text)]">
                    {t('failover:apDownBody', {
                      defaultValue:
                        'This device has taken over the game, but its Wi-Fi hotspot is not up - the other devices cannot find it yet.',
                    })}
                  </p>
                  {info?.hotspot_error && (
                    <ErrorDetails error={new Error(info.hotspot_error)} tone="warning" />
                  )}
                  <p className="text-xs text-[var(--pg-text-dim)]">
                    {t('failover:apDownHint', {
                      defaultValue:
                        'Retry below, or start the hotspot from Settings → Network. The game itself is safe on this device.',
                    })}
                  </p>
                </div>
              </div>
              <div className="flex gap-2.5">
                <button onClick={onClose} className="pg-btn flex-1 justify-center">
                  {t('failover:close', { defaultValue: 'Close' })}
                </button>
                <button
                  onClick={retryHotspot}
                  disabled={retryingAp}
                  className="pg-btn pg-btn--primary flex-1 justify-center"
                >
                  {retryingAp ? <Loader2 size={16} className="animate-spin" /> : <Wifi size={16} />}
                  {t('failover:retryHotspot', { defaultValue: 'Retry hotspot' })}
                </button>
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="space-y-5">
              <ErrorDetails error={error} />
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
