// Settings → Updates. Shows the current app version, a manual "Check for
// updates" button, and - when an update exists - the download/install flow
// (desktop) or an app-store link (mobile).

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw, CheckCircle2, AlertOctagon, ExternalLink, Loader2, Trash2, WifiOff } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { checkForUpdate, openStoreUpdate, isDesktopPlatform, type UpdateStatus } from '../../services/updateService';
import { DesktopUpdateInstaller } from '../update/UpdateProgress';
import { ConfirmDialog } from '../ConfirmDialog';

export function UpdatesScreen() {
  const { t } = useTranslation();
  const [currentVersion, setCurrentVersion] = useState('-');
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [openingStore, setOpeningStore] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallError, setUninstallError] = useState<string | null>(null);
  const canUninstall = isDesktopPlatform();

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

  const runUninstall = async () => {
    setConfirmUninstall(false);
    setUninstalling(true);
    setUninstallError(null);
    try {
      // On success the app quits and the NSIS uninstaller takes over, so this
      // call does not return. Any rejection means we never launched it.
      await invoke('uninstall_app');
    } catch (e) {
      setUninstallError(e instanceof Error ? e.message : String(e));
      setUninstalling(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="pg-panel">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/taghunter-logo.png" alt="Tag Hunter" className="h-8 w-auto" />
            <div>
              <h2 className="text-xl font-semibold text-[var(--pg-text)]">{t('update:appUpdatesTitle')}</h2>
              <p className="text-sm text-[var(--pg-text-dim)]">
                {t('update:currentVersionLabel')}{' '}
                <span className="font-mono text-[var(--pg-text-muted)]">{currentVersion}</span>
              </p>
            </div>
          </div>
          <button
            onClick={runCheck}
            disabled={checking}
            className="pg-btn pg-btn--primary"
          >
            <RefreshCw size={16} className={checking ? 'animate-spin' : ''} />
            {checking ? t('update:checking') : t('update:checkForUpdates')}
          </button>
        </div>
      </div>

      {status && !checking && (
        <div className="pg-panel">
          {status.state === 'up-to-date' && (
            <div className="flex items-center gap-3 text-emerald-300">
              <CheckCircle2 size={20} />
              <span>{t('update:upToDate')}</span>
            </div>
          )}

          {status.state === 'error' && (
            <div className="flex items-center gap-3 text-sm text-[var(--pg-text-dim)]">
              <WifiOff size={18} className="flex-shrink-0 text-[var(--pg-text-dim)]" />
              <span>{t('update:serverUnreachable')}</span>
            </div>
          )}

          {(status.state === 'optional' || status.state === 'required') && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                {status.state === 'required' ? (
                  <AlertOctagon className="text-red-400" size={20} />
                ) : (
                  <Download className="text-[var(--pg-accent-bright)]" size={20} />
                )}
                <div>
                  <div className="font-semibold text-[var(--pg-text)]">
                    {t('update:versionAvailable', { version: status.latestVersion })}
                  </div>
                  {status.state === 'required' && (
                    <div className="text-xs text-red-300">
                      {t('update:updateRequiredHint')}
                    </div>
                  )}
                  {status.source === 'mother' && (
                    <div className="text-xs text-[var(--pg-text-dim)]">{t('update:fromMotherHint')}</div>
                  )}
                </div>
              </div>

              {status.notes && (
                <div className="rounded-lg bg-[var(--pg-bg)] border border-[var(--pg-line)] px-4 py-3 max-h-48 overflow-y-auto">
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
                  disabled={openingStore}
                  className="pg-btn pg-btn--primary w-full !py-3"
                >
                  {openingStore ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <ExternalLink size={18} />
                  )}
                  {t('update:updateFromStore')}
                </button>
              ) : (
                <p className="text-sm text-amber-300">
                  {t('update:updateFromDeviceStore')}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {canUninstall && (
        <div className="pg-panel border-red-500/20">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Trash2 className="text-red-400 flex-shrink-0" size={24} />
              <div>
                <h2 className="text-xl font-semibold text-[var(--pg-text)]">{t('update:uninstallTitle')}</h2>
                <p className="text-sm text-[var(--pg-text-dim)]">
                  {t('update:uninstallBody')}
                </p>
              </div>
            </div>
            <button
              onClick={() => setConfirmUninstall(true)}
              disabled={uninstalling}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
            >
              {uninstalling ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
              {uninstalling ? t('update:uninstalling') : t('update:uninstallButton')}
            </button>
          </div>

          {uninstallError && (
            <div className="mt-4 text-sm text-red-300">
              {t('update:uninstallStartError', { error: uninstallError })}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmUninstall}
        onConfirm={runUninstall}
        onCancel={() => setConfirmUninstall(false)}
        title={t('update:uninstallConfirmTitle')}
        message={t('update:uninstallConfirmMessage')}
        confirmText={t('update:uninstallButton')}
        cancelText={t('update:cancel')}
        variant="danger"
      />
    </div>
  );
}
