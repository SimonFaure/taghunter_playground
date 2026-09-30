// Persistent surface for "this mother should be broadcasting an AP but isn't".
// Mounted at the App root (like MotherFailoverBanner) so it shows everywhere.
// Fed by lanMotherBoot's hotspot-issue pub/sub: `no_creds` means the raise was
// skipped because neither studio-synced nor manually-typed creds exist (the
// silent day-one-offline failure), `raise_failed` means WinRT refused to start
// the AP. Amber, not red - the LAN server itself may still be fine.
// Coded Windows failures (hotspotErrors.ts) are shown in plain language, the raw
// WinRT text stays in the tooltip for support.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RotateCw, Settings, WifiOff, X } from 'lucide-react';
import {
  onHotspotIssue,
  raiseMotherHotspotIfConfigured,
  type HotspotIssue,
} from '../services/lanMotherBoot';
import { describeHotspotError, openWindowsHotspotSettings } from '../services/hotspotErrors';

export function HotspotIssueBanner() {
  const { t } = useTranslation();
  const [issue, setIssue] = useState<HotspotIssue | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(
    () =>
      onHotspotIssue((i) => {
        setIssue(i);
        if (!i) setDismissed(false); // healthy again → re-arm for the next issue
      }),
    []
  );

  if (!issue || dismissed) return null;

  const coded = issue.kind === 'raise_failed' ? describeHotspotError(issue.message, t) : null;

  const retry = async () => {
    setRetrying(true);
    try {
      await raiseMotherHotspotIfConfigured();
    } finally {
      setRetrying(false);
    }
  };

  const btn =
    'shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold bg-white/15 hover:bg-white/25 transition-colors disabled:opacity-60';

  return (
    <div
      className="fixed top-0 left-0 right-0 flex items-center justify-center gap-3 px-4 py-2 bg-amber-600/95 text-white shadow-lg"
      style={{ zIndex: 5900 }}
    >
      <WifiOff size={18} className="shrink-0" />
      <span className="text-sm font-medium" title={coded?.detail}>
        {issue.kind === 'no_creds'
          ? t('devicesLan:hotspotIssueNoCreds', {
              defaultValue:
                'No Wi-Fi hotspot credentials on this device - the hotspot was NOT started. Sync once with internet, or add a network by hand in Settings → Network → Advanced.',
            })
          : coded
            ? coded.message
            : t('devicesLan:hotspotIssueRaiseFailed', {
                defaultValue: 'The Wi-Fi hotspot could not be started: {{message}}',
                message: issue.message,
              })}
      </span>
      {coded && (
        <>
          <button type="button" className={btn} onClick={() => void openWindowsHotspotSettings().catch(() => {})}>
            <Settings size={14} />
            {t('devicesLan:hotspotErrOpenWindows')}
          </button>
          <button type="button" className={btn} disabled={retrying} onClick={() => void retry()}>
            {retrying ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}
            {t('devicesLan:hotspotErrRetry')}
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="ml-1 p-1 rounded hover:bg-white/20 transition-colors"
        title={t('devicesLan:hotspotIssueDismiss', { defaultValue: 'Dismiss' })}
      >
        <X size={16} />
      </button>
    </div>
  );
}
