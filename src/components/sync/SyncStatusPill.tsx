import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { on } from '../../services/syncEvents';

interface SyncStatusPillProps {
  // Deep-link handler: clicking the pill should take the user to the sync
  // settings page so they can see exactly what's being downloaded. Wired in
  // App.tsx (the single place that owns currentPage + pendingSettingsTab).
  onNavigate?: () => void;
}

// Small unobtrusive corner pill shown while a content sync cycle is in flight
// on subsequent launches (not first launch — that uses FirstLaunchProgress).
// Hides 800ms after the cycle finishes. The pill stays clickable during the
// fade-out window so a click that lands right at the end of a cycle still
// navigates instead of silently dropping.
export function SyncStatusPill({ onNavigate }: SyncStatusPillProps) {
  const [visible, setVisible] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const offStarted = on('cycle:started', () => {
      setVisible(true);
      setCompleted(0);
      setTotal(0);
    });
    const offProgress = on('cycle:progress', (p) => {
      setTotal(p.total);
      setCompleted(p.completed);
    });
    const offFinished = on('cycle:finished', () => {
      // Brief settle before hiding so users see it complete.
      setTimeout(() => setVisible(false), 800);
    });
    const offFailed = on('cycle:failed', () => {
      setTimeout(() => setVisible(false), 800);
    });
    return () => {
      offStarted();
      offProgress();
      offFinished();
      offFailed();
    };
  }, []);

  if (!visible) return null;

  const label = total > 0 ? `Syncing ${completed} / ${total}` : 'Syncing…';

  return (
    <button
      type="button"
      onClick={onNavigate}
      title="Click for details"
      aria-label={`${label}. Click for details.`}
      className="fixed bottom-4 right-4 z-40 bg-slate-800/95 hover:bg-slate-700/95 border border-slate-700 hover:border-slate-600 rounded-full px-3 py-1.5 flex items-center gap-2 shadow-lg backdrop-blur cursor-pointer transition-colors"
    >
      <RefreshCw className="w-3.5 h-3.5 text-blue-400 animate-spin" />
      <span className="text-xs text-slate-300">{label}</span>
    </button>
  );
}
