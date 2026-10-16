import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { on } from '../../services/syncEvents';
import type { UpdatesAvailablePayload } from '../../services/syncEvents';
import { answerPendingUpdates, getPendingUpdates } from '../../services/syncOrchestrator';

// Scenario titles listed by name before collapsing into "+N".
const MAX_TITLES = 5;

// Launch question: the orchestrator's launch check found content to download
// and holds every download until the operator answers. "Later" keeps
// automatic sync off for this session; Settings → Sync still syncs on demand.
// Reads getPendingUpdates() on mount because the check can finish while the
// logo screen is still up, before this component exists.
export function PendingUpdatesPrompt() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<UpdatesAvailablePayload | null>(() => getPendingUpdates());

  useEffect(() => {
    const offAvailable = on('updates:available', (p) => setSummary(p));
    const offResolved = on('updates:resolved', () => setSummary(null));
    // Covers an event that fired between the initial render and this effect.
    setSummary(getPendingUpdates());
    return () => {
      offAvailable();
      offResolved();
    };
  }, []);

  if (!summary) return null;

  const titles = (list: string[]) => {
    const shown = list.slice(0, MAX_TITLES).join(', ');
    const rest = list.length - MAX_TITLES;
    return rest > 0 ? `${shown} ${t('sync:pendingMore', { count: rest })}` : shown;
  };

  const lines: Array<{ label: string; detail?: string }> = [];
  if (summary.newScenarios.length > 0) {
    lines.push({
      label: t('sync:pendingNewScenarios', { count: summary.newScenarios.length }),
      detail: titles(summary.newScenarios),
    });
  }
  if (summary.updatedScenarios.length > 0) {
    lines.push({
      label: t('sync:pendingUpdatedScenarios', { count: summary.updatedScenarios.length }),
      detail: titles(summary.updatedScenarios),
    });
  }
  if (summary.patterns > 0) {
    lines.push({ label: t('sync:pendingPatterns', { count: summary.patterns }) });
  }
  if (summary.videos > 0) {
    lines.push({ label: t('sync:pendingVideos', { count: summary.videos }) });
  }
  if (summary.other > 0) {
    lines.push({ label: t('sync:pendingOther', { count: summary.other }) });
  }

  return (
    <div className="pg-overlay">
      <div className="pg-modal max-w-md animate-in zoom-in-95 duration-200">
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 w-12 h-12 rounded-full bg-[var(--pg-accent-tint)] flex items-center justify-center">
              <Download className="text-[var(--pg-accent-bright)]" size={24} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-[var(--pg-text)] mb-2">
                {t('sync:pendingTitle')}
              </h3>
              <p className="text-sm text-[var(--pg-text-muted)] leading-relaxed mb-3">
                {t('sync:pendingBody')}
              </p>
              <ul className="space-y-2 text-sm text-[var(--pg-text)]">
                {lines.map((l) => (
                  <li key={l.label}>
                    <span className="font-medium">{l.label}</span>
                    {l.detail && (
                      <span className="block text-xs text-[var(--pg-text-muted)] break-words">{l.detail}</span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-[var(--pg-text-muted)] leading-relaxed mt-3">
                {t('sync:pendingLaterHint')}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--pg-line)] bg-[var(--pg-surface)]">
          <button onClick={() => answerPendingUpdates(false)} className="pg-btn">
            {t('sync:pendingLater')}
          </button>
          <button onClick={() => answerPendingUpdates(true)} className="pg-btn pg-btn--primary">
            {t('sync:syncNow')}
          </button>
        </div>
      </div>
    </div>
  );
}
