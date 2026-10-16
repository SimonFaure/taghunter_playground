// The two questions the device SET as the mother may ask, and the only ones the
// role rules leave to the operator (services/hostingRole.ts):
//
//  - "Reprendre le contrôle ?": the mother is back while a game is still
//    running on the substitute that stood in for it. Take the game back now, or
//    let it finish there - the mother then takes the hosting back by itself.
//  - "Deux postes mères": another device is set as mother too, and nothing says
//    which designation came last. Asked once; the answer settles it.
//
// Everything else is automatic and silent. This used to pop up on every device
// whose copy of a game differed from the current host's, whatever its role, and
// neither button could save the game (the refusal was `stale_snapshot`). Copies
// now converge by themselves: the newer one wins.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crown, AlertTriangle, Loader2, CheckCircle, X } from 'lucide-react';
import {
  onHostingNotice, takeBackNow, resolveTwoMothers, type HostingNotice,
} from '../services/hostingRole';
import { displayDeviceLabel } from '../services/lanPairing';
import { ErrorDetails } from './ErrorDetails';

type Phase = 'confirm' | 'taking' | 'success' | 'error';

export function RegainControlPrompt({ clientId }: { clientId: number | null }) {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<HostingNotice>({ kind: 'none' });
  // Asked once per substitute / per rival: "Laisser finir" and "Plus tard" are
  // answers, not something to ask again every 20 s. The Network page keeps the
  // action available.
  const [answered, setAnswered] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('confirm');
  const [error, setError] = useState<unknown>(null);

  useEffect(() => onHostingNotice(setNotice), []);

  const subject =
    notice.kind === 'substitute_busy' ? notice.substitute
    : notice.kind === 'two_mothers' ? notice.other
    : null;
  const askKey = subject ? `${notice.kind}:${subject.mother_uuid}` : null;
  // Keep the result of an action on screen after the notice it answered cleared.
  const open = phase !== 'confirm' || (askKey != null && askKey !== answered);
  if (!open || clientId == null) return null;

  const name = displayDeviceLabel(subject?.label) || t('failover:anotherDevice');
  const twoMothers = notice.kind === 'two_mothers';
  const dismissable = phase !== 'taking';
  const close = () => {
    setAnswered(askKey);
    setPhase('confirm');
    setError(null);
  };

  const run = async (action: () => Promise<void>) => {
    setPhase('taking');
    setError(null);
    try {
      await action();
      setAnswered(askKey);
      setPhase('success');
    } catch (e) {
      setError(e);
      setPhase('error');
    }
  };
  const takeBack = () => void run(() => takeBackNow(clientId));
  // Either answer restarts Playground to apply it.
  const keep = (thisDevice: boolean) => void run(() => resolveTwoMothers(thisDevice));

  return (
    <div
      className="pg-overlay p-4"
      style={{ zIndex: 6200 }}
      onClick={dismissable ? close : undefined}
    >
      <div className="pg-modal max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="pg-modal-head">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-yellow-400/15 flex items-center justify-center">
              <Crown size={16} className="text-yellow-400" />
            </div>
            <h2 className="pg-modal-title">
              {twoMothers ? t('failover:twoMothersTitle') : t('failover:regainTitle')}
            </h2>
          </div>
          {dismissable && (
            <button onClick={close} className="pg-modal-close">
              <X size={16} />
            </button>
          )}
        </div>

        <div className="p-6">
          {phase === 'confirm' && (
            <div className="space-y-5">
              <p className="text-sm text-[var(--pg-text)]">
                {twoMothers ? t('failover:twoMothersBody', { name }) : t('failover:regainBody', { name })}
              </p>
              <div className="flex items-center gap-2 text-xs text-[var(--pg-text-dim)]">
                <AlertTriangle size={14} className="text-yellow-400 shrink-0" />
                <span>{twoMothers ? t('failover:twoMothersNote') : t('failover:regainNote')}</span>
              </div>
              {twoMothers ? (
                <div className="space-y-2.5">
                  <div className="flex gap-2.5">
                    <button onClick={() => keep(true)} className="pg-btn pg-btn--primary flex-1 justify-center">
                      <Crown size={16} />
                      {t('failover:twoMothersKeepThis')}
                    </button>
                    <button onClick={() => keep(false)} className="pg-btn flex-1 justify-center">
                      {name}
                    </button>
                  </div>
                  <button onClick={close} className="pg-btn w-full justify-center">
                    {t('failover:twoMothersLater')}
                  </button>
                </div>
              ) : (
                <div className="flex gap-2.5">
                  <button onClick={close} className="pg-btn flex-1 justify-center">
                    {t('failover:regainKeep')}
                  </button>
                  <button onClick={takeBack} className="pg-btn pg-btn--primary flex-1 justify-center">
                    <Crown size={16} />
                    {t('failover:regainConfirm')}
                  </button>
                </div>
              )}
            </div>
          )}

          {phase === 'taking' && (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <Loader2 size={28} className="animate-spin text-[var(--pg-accent-bright)]" />
              <p className="text-sm text-[var(--pg-text)]">
                {twoMothers ? t('devicesLan:relaunchingToApply') : t('failover:regainTaking')}
              </p>
            </div>
          )}

          {phase === 'success' && (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-3 py-2 text-center">
                <CheckCircle size={28} className="text-green-400" />
                <p className="text-sm text-[var(--pg-text)]">
                  {twoMothers ? t('devicesLan:relaunchingToApply') : t('failover:regainDone')}
                </p>
              </div>
              <button onClick={close} className="pg-btn pg-btn--primary w-full justify-center">
                {t('failover:done')}
              </button>
            </div>
          )}

          {phase === 'error' && (
            <div className="space-y-5">
              <ErrorDetails error={error} />
              <div className="flex gap-2.5">
                <button onClick={close} className="pg-btn flex-1 justify-center">
                  {t('failover:close')}
                </button>
                {!twoMothers && (
                  <button onClick={takeBack} className="pg-btn pg-btn--primary flex-1 justify-center">
                    {t('failover:retry')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
