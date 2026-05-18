// Dismissable top banner shown when an optional update is available (running
// version is above the hard floor but below the latest). Dismiss hides it for
// the session only; the next launch re-checks.

import { useState } from 'react';
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
  const [opening, setOpening] = useState(false);

  const handleUpdate = async () => {
    if (status.isDesktop) {
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
    <div className="bg-blue-500/15 border-b border-blue-500/30 px-4 py-2 flex items-center justify-between text-sm">
      <div className="flex items-center gap-2 text-blue-200">
        <ArrowUpCircle className="w-4 h-4" />
        <span>
          Version {status.latestVersion} is available
          {status.isDesktop ? '' : ' on the app store'}.
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={handleUpdate}
          disabled={opening}
          className="text-blue-100 hover:text-white underline inline-flex items-center gap-1 disabled:opacity-50"
        >
          {status.isDesktop ? 'Update' : 'Open store'}
          {!status.isDesktop && <ExternalLink className="w-3 h-3" />}
        </button>
        <button
          onClick={onDismiss}
          className="text-blue-300/70 hover:text-white"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
