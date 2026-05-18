// Settings → Updates. Shows the current app version, a manual "Check for
// updates" button, and — when an update exists — the download/install flow
// (desktop) or an app-store link (mobile).

import { useEffect, useState } from 'react';
import { Download, RefreshCw, CheckCircle2, AlertOctagon, ExternalLink, Loader2 } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { checkForUpdate, openStoreUpdate, type UpdateStatus } from '../../services/updateService';
import { DesktopUpdateInstaller } from '../update/UpdateProgress';

export function UpdatesScreen() {
  const [currentVersion, setCurrentVersion] = useState('—');
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [openingStore, setOpeningStore] = useState(false);

  const runCheck = async () => {
    setChecking(true);
    try {
      setStatus(await checkForUpdate());
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void getVersion()
      .then(setCurrentVersion)
      .catch(() => setCurrentVersion('unknown'));
    void runCheck();
  }, []);

  const openStore = async () => {
    if (!status?.storeUrl) return;
    setOpeningStore(true);
    try {
      await openStoreUpdate(status.storeUrl);
    } finally {
      setOpeningStore(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-slate-800/50 rounded-lg p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Download className="text-blue-400" size={24} />
            <div>
              <h2 className="text-xl font-semibold">App updates</h2>
              <p className="text-sm text-slate-400">
                Current version <span className="font-mono text-slate-300">{currentVersion}</span>
              </p>
            </div>
          </div>
          <button
            onClick={runCheck}
            disabled={checking}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw size={16} className={checking ? 'animate-spin' : ''} />
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
      </div>

      {status && !checking && (
        <div className="bg-slate-800/50 rounded-lg p-6">
          {status.state === 'up-to-date' && (
            <div className="flex items-center gap-3 text-emerald-300">
              <CheckCircle2 size={20} />
              <span>You're on the latest version.</span>
            </div>
          )}

          {status.state === 'error' && (
            <div className="text-sm text-slate-400">
              Couldn't reach the update server. Check your connection and try again.
            </div>
          )}

          {(status.state === 'optional' || status.state === 'required') && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                {status.state === 'required' ? (
                  <AlertOctagon className="text-red-400" size={20} />
                ) : (
                  <Download className="text-blue-400" size={20} />
                )}
                <div>
                  <div className="font-semibold">
                    Version {status.latestVersion} available
                  </div>
                  {status.state === 'required' && (
                    <div className="text-xs text-red-300">
                      This update is required to keep using the app.
                    </div>
                  )}
                </div>
              </div>

              {status.notes && (
                <div className="rounded-lg bg-slate-900/40 border border-slate-700 px-4 py-3 max-h-48 overflow-y-auto">
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
                  disabled={openingStore}
                  className="w-full flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors disabled:opacity-60"
                >
                  {openingStore ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <ExternalLink size={18} />
                  )}
                  Update from the app store
                </button>
              ) : (
                <p className="text-sm text-amber-300">
                  Please update from your device's app store.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
