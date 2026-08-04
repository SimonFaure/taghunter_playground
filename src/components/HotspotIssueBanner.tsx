// Persistent surface for "this mother should be broadcasting an AP but isn't".
// Mounted at the App root (like MotherFailoverBanner) so it shows everywhere.
// Fed by lanMotherBoot's hotspot-issue pub/sub: `no_creds` means the raise was
// skipped because neither studio-synced nor manually-typed creds exist (the
// silent day-one-offline failure), `raise_failed` means WinRT refused to start
// the AP. Amber, not red - the LAN server itself may still be fine.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WifiOff, X } from 'lucide-react';
import { onHotspotIssue, type HotspotIssue } from '../services/lanMotherBoot';

export function HotspotIssueBanner() {
  const { t } = useTranslation();
  const [issue, setIssue] = useState<HotspotIssue | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(
    () =>
      onHotspotIssue((i) => {
        setIssue(i);
        if (!i) setDismissed(false); // healthy again → re-arm for the next issue
      }),
    []
  );

  if (!issue || dismissed) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 flex items-center justify-center gap-3 px-4 py-2 bg-amber-600/95 text-white shadow-lg"
      style={{ zIndex: 5900 }}
    >
      <WifiOff size={18} className="shrink-0" />
      <span className="text-sm font-medium">
        {issue.kind === 'no_creds'
          ? t('devicesLan:hotspotIssueNoCreds', {
              defaultValue:
                'No Wi-Fi hotspot credentials on this device - the hotspot was NOT started. Sync once with internet, or add a network by hand in Settings → Devices → Network.',
            })
          : t('devicesLan:hotspotIssueRaiseFailed', {
              defaultValue: 'The Wi-Fi hotspot could not be started: {{message}}',
              message: issue.message,
            })}
      </span>
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
