// Hard-floor blocking overlay. Rendered as an early return from App when the
// running version is below the server's min_supported_version. No dismiss:
// the app cannot be used until the user updates.
//
// Desktop downloads + installs in place. Mobile deep-links to the app store.

import { useState } from 'react';
import { AlertOctagon, ExternalLink, Loader2 } from 'lucide-react';
import type { UpdateStatus } from '../../services/updateService';
import { openStoreUpdate } from '../../services/updateService';
import { DesktopUpdateInstaller } from './UpdateProgress';

interface UpdateRequiredOverlayProps {
  status: UpdateStatus;
}

export function UpdateRequiredOverlay({ status }: UpdateRequiredOverlayProps) {
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
    <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <div className="max-w-md w-full bg-slate-800 border border-slate-700 rounded-2xl p-8 space-y-5">
        <div className="flex justify-center">
          <div className="bg-red-500/20 border border-red-500/40 rounded-full p-3 inline-flex">
            <AlertOctagon className="w-6 h-6 text-red-400" />
          </div>
        </div>

        <h2 className="text-2xl font-semibold text-white text-center">Update required</h2>

        <p className="text-slate-400 text-sm text-center">
          This version of Tag Hunter Playground is no longer supported and must
          be updated before you can continue.
        </p>

        <div className="rounded-lg bg-slate-900/60 border border-slate-700 px-4 py-3 text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-slate-500">Your version</span>
            <span className="font-mono text-slate-300">{status.currentVersion}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Latest version</span>
            <span className="font-mono text-emerald-300">{status.latestVersion ?? '—'}</span>
          </div>
        </div>

        {status.notes && (
          <div className="rounded-lg bg-slate-900/40 border border-slate-700 px-4 py-3 max-h-40 overflow-y-auto">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">
              What's new
            </div>
            <p className="text-sm text-slate-300 whitespace-pre-wrap">{status.notes}</p>
          </div>
        )}

        {status.isDesktop ? (
          <DesktopUpdateInstaller />
        ) : status.storeUrl ? (
          <button
            onClick={openStore}
            disabled={opening}
            className="w-full flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors disabled:opacity-60"
          >
            {opening ? <Loader2 size={18} className="animate-spin" /> : <ExternalLink size={18} />}
            Update from the app store
          </button>
        ) : (
          <p className="text-sm text-amber-300 text-center">
            Please update Tag Hunter Playground from your device's app store.
          </p>
        )}
      </div>
    </div>
  );
}
