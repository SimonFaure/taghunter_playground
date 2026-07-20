import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { on } from '../../services/syncEvents';

interface FirstLaunchProgressProps {
  onSkip: () => void;
  onDone: () => void;
}

// Full-screen "Setting up your library" overlay shown on first launch (no row
// has local_version IS NOT NULL) while the initial cycle is downloading
// content. Dismissible - user can skip into the app and let downloads finish
// in the background (the SyncStatusPill takes over).
export function FirstLaunchProgress({ onSkip, onDone }: FirstLaunchProgressProps) {
  const { t } = useTranslation();
  const [total, setTotal] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [failed, setFailed] = useState(0);
  const [currentLabel, setCurrentLabel] = useState<string | null>(null);
  const [phase, setPhase] = useState<'starting' | 'syncing' | 'done' | 'failed'>('starting');
  const [errorReason, setErrorReason] = useState<string | null>(null);

  useEffect(() => {
    const offStarted = on('cycle:started', () => {
      setPhase('syncing');
      setTotal(0);
      setCompleted(0);
      setFailed(0);
      setCurrentLabel(null);
      setErrorReason(null);
    });
    const offProgress = on('cycle:progress', (p) => {
      setTotal(p.total);
      setCompleted(p.completed);
      setFailed(p.failed);
      if (p.currentLabel) setCurrentLabel(p.currentLabel);
    });
    const offFinished = on('cycle:finished', (p) => {
      setTotal(p.total);
      setCompleted(p.completed);
      setFailed(p.failed);
      setPhase('done');
      // Hand control to App after a short beat so the user sees "All set".
      setTimeout(onDone, 600);
    });
    const offFailed = on('cycle:failed', (p) => {
      setPhase('failed');
      setErrorReason(p.reason);
    });
    return () => {
      offStarted();
      offProgress();
      offFinished();
      offFailed();
    };
  }, [onDone]);

  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="min-h-screen flex items-center justify-center p-6 pg-app-bg">
      <div className="max-w-md w-full bg-[var(--pg-surface)] border border-[var(--pg-line)] rounded-2xl p-8 text-center space-y-5">
        {phase === 'failed' ? (
          <div className="bg-red-500/20 border border-red-500/40 rounded-full p-3 inline-flex">
            <AlertTriangle className="w-6 h-6 text-red-400" />
          </div>
        ) : phase === 'done' ? (
          <div className="bg-emerald-500/20 border border-emerald-500/40 rounded-full p-3 inline-flex">
            <CheckCircle2 className="w-6 h-6 text-emerald-400" />
          </div>
        ) : (
          <div className="bg-[var(--pg-accent-tint)] border border-[var(--pg-accent-line)] rounded-full p-3 inline-flex">
            <Loader2 className="w-6 h-6 text-[var(--pg-accent-bright)] animate-spin" />
          </div>
        )}

        <h2 className="text-2xl font-semibold text-[var(--pg-text)]">
          {phase === 'done'
            ? t('sync:allSet')
            : phase === 'failed'
              ? t('sync:couldNotFinishSetup')
              : t('sync:settingUpLibrary')}
        </h2>

        {phase === 'failed' ? (
          <p className="text-[var(--pg-text-dim)] text-sm">
            {errorReason === 'auth_invalid'
              ? t('sync:sessionInvalid')
              : t('sync:someItemsFailed')}
          </p>
        ) : phase === 'done' ? (
          <p className="text-[var(--pg-text-dim)] text-sm">
            {failed > 0
              ? t('sync:downloadedWithFailures', { completed, total, failed })
              : total === 0
                ? t('sync:libraryUpToDate')
                : t('sync:downloadedItems', { count: completed })}
          </p>
        ) : (
          <>
            <p className="text-[var(--pg-text-dim)] text-sm">
              {currentLabel ?? t('sync:preparingContent')}
            </p>
            <div>
              <div className="h-2 bg-[var(--pg-surface-3)] rounded-full overflow-hidden border border-[var(--pg-line)]">
                <div
                  className="h-full bg-[var(--pg-accent)] transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-[var(--pg-text-dim)] mt-2">
                <span>{t('sync:countOfTotal', { completed, total })}</span>
                {failed > 0 && <span className="text-amber-400">{t('sync:countFailed', { count: failed })}</span>}
              </div>
            </div>
          </>
        )}

        {phase === 'failed' ? (
          <button
            onClick={onDone}
            className="pg-btn pg-btn--primary w-full !py-3"
          >
            {t('sync:continueToApp')}
          </button>
        ) : phase !== 'done' ? (
          <button
            onClick={onSkip}
            className="text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] text-sm underline"
          >
            {t('sync:skipFinishInBackground')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
