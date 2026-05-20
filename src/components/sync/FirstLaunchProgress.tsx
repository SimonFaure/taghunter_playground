import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { on } from '../../services/syncEvents';

interface FirstLaunchProgressProps {
  onSkip: () => void;
  onDone: () => void;
}

// Full-screen "Setting up your library" overlay shown on first launch (no row
// has local_version IS NOT NULL) while the initial cycle is downloading
// content. Dismissible — user can skip into the app and let downloads finish
// in the background (the SyncStatusPill takes over).
export function FirstLaunchProgress({ onSkip, onDone }: FirstLaunchProgressProps) {
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
    <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <div className="max-w-md w-full bg-slate-800 border border-slate-700 rounded-2xl p-8 text-center space-y-5">
        {phase === 'failed' ? (
          <div className="bg-red-500/20 border border-red-500/40 rounded-full p-3 inline-flex">
            <AlertTriangle className="w-6 h-6 text-red-400" />
          </div>
        ) : phase === 'done' ? (
          <div className="bg-emerald-500/20 border border-emerald-500/40 rounded-full p-3 inline-flex">
            <CheckCircle2 className="w-6 h-6 text-emerald-400" />
          </div>
        ) : (
          <div className="bg-blue-500/20 border border-blue-500/40 rounded-full p-3 inline-flex">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        )}

        <h2 className="text-2xl font-semibold text-white">
          {phase === 'done'
            ? 'All set'
            : phase === 'failed'
              ? "Couldn't finish setup"
              : 'Setting up your library'}
        </h2>

        {phase === 'failed' ? (
          <p className="text-slate-400 text-sm">
            {errorReason === 'auth_invalid'
              ? 'Your session is no longer valid. Please sign in again.'
              : 'Some items failed to download. You can keep using the app and try again later.'}
          </p>
        ) : phase === 'done' ? (
          <p className="text-slate-400 text-sm">
            {failed > 0
              ? `${completed} of ${total} downloaded. ${failed} failed — you can retry from settings.`
              : total === 0
                ? 'Library is up to date.'
                : `Downloaded ${completed} item${completed === 1 ? '' : 's'}.`}
          </p>
        ) : (
          <>
            <p className="text-slate-400 text-sm">
              {currentLabel ?? 'Preparing scenarios, patterns and layouts…'}
            </p>
            <div>
              <div className="h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-700">
                <div
                  className="h-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-slate-500 mt-2">
                <span>{completed} of {total}</span>
                {failed > 0 && <span className="text-amber-400">{failed} failed</span>}
              </div>
            </div>
          </>
        )}

        {phase === 'failed' ? (
          <button
            onClick={onDone}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium"
          >
            Continue to app
          </button>
        ) : phase !== 'done' ? (
          <button
            onClick={onSkip}
            className="text-slate-400 hover:text-white text-sm underline"
          >
            Skip — finish in background
          </button>
        ) : null}
      </div>
    </div>
  );
}
