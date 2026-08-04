import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, X, ExternalLink } from 'lucide-react';
import { on } from '../../services/syncEvents';
import { runCycleNow } from '../../services/syncOrchestrator';
import { isOnline, probeStudioReachable } from '../../services/connectivity';

interface SyncFailureBannerProps {
  onAuthInvalid?: () => void;
  // Deep-link to the sync settings tab. The banner stays concise (one
  // sentence + Retry); the full collapsible diagnostic lives on the sync
  // tab via a "View details" affordance here.
  onViewDetails?: () => void;
}

// Dismissible top banner shown when a cycle finishes with at least one failed
// asset, or fails altogether for a recoverable reason. Hidden until the next
// failed cycle. Auth-invalid failures bubble to onAuthInvalid (AuthProvider).
export function SyncFailureBanner({ onAuthInvalid, onViewDetails }: SyncFailureBannerProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ kind: 'hidden' } | { kind: 'failed'; reason: string } | { kind: 'partial'; failed: number }>(
    { kind: 'hidden' }
  );
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let disposed = false;

    // Being offline is not a sync failure - it's the normal state of a
    // playground running on a field hotspot with no internet, and the footer
    // already shows it. Only raise the banner when studio is genuinely
    // reachable: navigator.onLine lies on captive portals / LAN-only networks,
    // so confirm with the same active probe the footer indicator uses.
    const showIfReachable = async (next: Exclude<typeof state, { kind: 'hidden' }>) => {
      if (!isOnline()) return;
      const reachable = await probeStudioReachable(4000);
      if (disposed || !reachable) return;
      setState(next);
    };

    const offFinished = on('cycle:finished', (p) => {
      if (p.failed > 0) {
        void showIfReachable({ kind: 'partial', failed: p.failed });
      } else {
        setState((prev) => (prev.kind === 'hidden' ? prev : { kind: 'hidden' }));
      }
    });
    const offFailed = on('cycle:failed', (p) => {
      if (p.reason === 'auth_invalid') {
        if (onAuthInvalid) onAuthInvalid();
        return;
      }
      void showIfReachable({ kind: 'failed', reason: p.reason });
    });
    return () => {
      disposed = true;
      offFinished();
      offFailed();
    };
  }, [onAuthInvalid]);

  if (state.kind === 'hidden') return null;

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await runCycleNow('manual');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 flex items-center justify-between text-sm">
      <div className="flex items-center gap-2 text-amber-300">
        <AlertTriangle className="w-4 h-4" />
        <span>
          {state.kind === 'partial'
            ? t('sync:itemsFailedToDownload', { count: state.failed })
            : t('sync:syncFailedReason', { reason: state.reason })}
        </span>
      </div>
      <div className="flex items-center gap-3">
        {onViewDetails && (
          <button
            onClick={onViewDetails}
            className="text-amber-200 hover:text-white inline-flex items-center gap-1 underline"
          >
            {t('sync:viewDetails')}
            <ExternalLink className="w-3 h-3" />
          </button>
        )}
        <button
          onClick={handleRetry}
          disabled={retrying}
          className="text-amber-200 hover:text-white underline disabled:opacity-50"
        >
          {retrying ? t('sync:retrying') : t('sync:retry')}
        </button>
        <button onClick={() => setState({ kind: 'hidden' })} aria-label={t('sync:dismiss')} className="text-amber-300/70 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
