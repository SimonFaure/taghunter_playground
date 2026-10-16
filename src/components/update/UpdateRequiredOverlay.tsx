// Hard-floor blocking overlay. Rendered as an early return from App when the
// running version is below the server's min_supported_version. No dismiss:
// the app cannot be used until the user updates.
//
// Desktop downloads + installs in place. Mobile deep-links to the app store.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertOctagon, ExternalLink, Loader2, ArrowRight } from 'lucide-react';
import type { UpdateStatus } from '../../services/updateService';
import { openStoreUpdate } from '../../services/updateService';
import { DesktopUpdateInstaller } from './UpdateProgress';

interface UpdateRequiredOverlayProps {
  status: UpdateStatus;
}

export function UpdateRequiredOverlay({ status }: UpdateRequiredOverlayProps) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);

  const openStore = async () => {
    if (!status.storeUrl) return;
    setOpening(true);
    try {
      await openStoreUpdate(status.storeUrl);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 pg-app-bg">
      <div className="animate-fade-up max-w-md w-full bg-[var(--pg-surface)] border border-[var(--pg-line)] rounded-2xl p-8 space-y-5 shadow-2xl shadow-black/40">
        <div className="flex flex-col items-center gap-3">
          <img src="/taghunter-logo.png" alt="Tag Hunter" className="h-12 w-auto" />
          <div className="bg-red-500/20 border border-red-500/40 rounded-full p-2 inline-flex">
            <AlertOctagon className="w-5 h-5 text-red-400" />
          </div>
        </div>

        <h2 className="text-2xl font-semibold text-[var(--pg-text)] text-center">{t('update:requiredTitle')}</h2>

        <p className="text-[var(--pg-text-dim)] text-sm text-center">
          {t('update:requiredBody')}
        </p>

        <div className="rounded-lg bg-[var(--pg-bg)] border border-[var(--pg-line)] px-4 py-3">
          <div className="flex items-center justify-center gap-3 text-sm">
            <div className="text-center">
              <div className="text-xs text-[var(--pg-text-dim)]">{t('update:yourVersion')}</div>
              <div className="font-mono text-[var(--pg-text-muted)]">{status.currentVersion}</div>
            </div>
            <ArrowRight className="w-4 h-4 text-[var(--pg-text-dim)] flex-shrink-0" />
            <div className="text-center">
              <div className="text-xs text-[var(--pg-text-dim)]">{t('update:latestVersion')}</div>
              <div className="font-mono text-emerald-300">{status.latestVersion ?? '-'}</div>
            </div>
          </div>
        </div>

        {status.notes && (
          <div className="rounded-lg bg-[var(--pg-bg)] border border-[var(--pg-line)] px-4 py-3 max-h-40 overflow-y-auto">
            <div className="text-xs uppercase tracking-wider text-[var(--pg-text-dim)] mb-1">
              {t('update:whatsNew')}
            </div>
            <p className="text-sm text-[var(--pg-text-muted)] whitespace-pre-wrap">{status.notes}</p>
          </div>
        )}

        {status.canSelfUpdate ? (
          <DesktopUpdateInstaller version={status.latestVersion} source={status.source} />
        ) : status.storeUrl ? (
          <button
            onClick={openStore}
            disabled={opening}
            className="pg-btn pg-btn--primary w-full !py-3"
          >
            {opening ? <Loader2 size={18} className="animate-spin" /> : <ExternalLink size={18} />}
            {t('update:updateFromStore')}
          </button>
        ) : (
          <p className="text-sm text-amber-300 text-center">
            {t('update:updateFromDeviceStore')}
          </p>
        )}
      </div>
    </div>
  );
}
