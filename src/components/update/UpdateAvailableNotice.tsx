// Dismissable top banner shown when an optional update is available (running
// version is above the hard floor but below the latest). Dismiss hides it for
// the session only; the next launch re-checks.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpCircle, X, ExternalLink } from 'lucide-react';
import type { UpdateStatus } from '../../services/updateService';
import { openStoreUpdate } from '../../services/updateService';

interface UpdateAvailableNoticeProps {
  status: UpdateStatus;
  onDismiss: () => void;
  // Deep-link to Settings → Updates, where the desktop download/install lives.
  onOpenUpdates: () => void;
}

export function UpdateAvailableNotice({
  status,
  onDismiss,
  onOpenUpdates,
}: UpdateAvailableNoticeProps) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);

  const handleUpdate = async () => {
    if (status.canSelfUpdate) {
      onOpenUpdates();
      return;
    }
    if (!status.storeUrl) return;
    setOpening(true);
    try {
      await openStoreUpdate(status.storeUrl);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="animate-drop-in bg-[var(--pg-accent-tint)] border-b border-[var(--pg-accent-line)] px-4 py-2 flex items-center justify-between text-sm">
      <div className="flex items-center gap-2 text-[var(--pg-accent-bright)]">
        <ArrowUpCircle className="w-4 h-4" />
        <span>
          {status.canSelfUpdate
            ? t(status.source === 'mother' ? 'update:availableFromMother' : 'update:availableDesktop', {
                version: status.latestVersion,
              })
            : t('update:availableStore', { version: status.latestVersion })}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={handleUpdate}
          disabled={opening}
          className="text-[var(--pg-accent-bright)] hover:text-[var(--pg-text)] underline inline-flex items-center gap-1 disabled:opacity-50"
        >
          {status.canSelfUpdate ? t('update:updateButton') : t('update:openStoreButton')}
          {!status.canSelfUpdate && <ExternalLink className="w-3 h-3" />}
        </button>
        <button
          onClick={onDismiss}
          className="text-[var(--pg-text-dim)] hover:text-[var(--pg-text)]"
          aria-label={t('update:dismiss')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
