import { useEffect, useState } from 'react';
import { AlertTriangle, X, ExternalLink } from 'lucide-react';
import { on } from '../../services/syncEvents';
import { runCycleNow } from '../../services/syncOrchestrator';

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
  const [state, setState] = useState<{ kind: 'hidden' } | { kind: 'failed'; reason: string } | { kind: 'partial'; failed: number }>(
    { kind: 'hidden' }
  );
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const offFinished = on('cycle:finished', (p) => {
      if (p.failed > 0) {
        setState({ kind: 'partial', failed: p.failed });
      } else {
        setState((prev) => (prev.kind === 'hidden' ? prev : { kind: 'hidden' }));
      }
    });
    const offFailed = on('cycle:failed', (p) => {
      if (p.reason === 'auth_invalid') {
        if (onAuthInvalid) onAuthInvalid();
        return;
      }
      setState({ kind: 'failed', reason: p.reason });
    });
    return () => {
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
            ? `${state.failed} item${state.failed === 1 ? '' : 's'} failed to download.`
            : `Sync failed: ${state.reason}.`}
        </span>
      </div>
      <div className="flex items-center gap-3">
        {onViewDetails && (
          <button
            onClick={onViewDetails}
            className="text-amber-200 hover:text-white inline-flex items-center gap-1 underline"
          >
            View details
            <ExternalLink className="w-3 h-3" />
          </button>
        )}
        <button
          onClick={handleRetry}
          disabled={retrying}
          className="text-amber-200 hover:text-white underline disabled:opacity-50"
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
        <button onClick={() => setState({ kind: 'hidden' })} className="text-amber-300/70 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
