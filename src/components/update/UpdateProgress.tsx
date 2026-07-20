// Desktop update installer: the shared "Download → Restart" action used by
// both the hard-floor overlay and the Settings → Updates screen.
//
// Fully user-driven (locked decision): nothing downloads or relaunches without
// a click. Before relaunching it checks whether a game / LAN mother session is
// live and, if so, asks the operator to confirm - but still allows it.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RotateCw, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { ConfirmDialog } from '../ConfirmDialog';
import { isGameActive } from '../../services/activeSession';
import {
  downloadUpdate,
  installAndRelaunch,
  type DownloadProgress,
} from '../../services/updateService';

type Phase = 'idle' | 'downloading' | 'downloaded' | 'installing' | 'error';

function formatBytes(n: number): string {
  const mb = n / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

// Returns true if a launched game or a LAN mother session is currently live.
async function aGameIsRunning(): Promise<boolean> {
  if (isGameActive()) return true;
  try {
    const role = await invoke<{ mother_server_running?: boolean }>(
      'client_describe_local_role'
    );
    return !!role?.mother_server_running;
  } catch {
    return false;
  }
}

export function DesktopUpdateInstaller({ version }: { version?: string | null }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<DownloadProgress>({ downloaded: 0, total: null });
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [downloadConfirmOpen, setDownloadConfirmOpen] = useState(false);

  const startDownload = async () => {
    setDownloadConfirmOpen(false);
    setPhase('downloading');
    setError(null);
    setProgress({ downloaded: 0, total: null });
    try {
      await downloadUpdate(setProgress);
      setPhase('downloaded');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  };

  const doInstall = async () => {
    setConfirmOpen(false);
    setPhase('installing');
    try {
      // Relaunches the app; this call does not return on success.
      await installAndRelaunch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  };

  const requestRestart = async () => {
    if (await aGameIsRunning()) {
      setConfirmOpen(true);
    } else {
      void doInstall();
    }
  };

  const pct =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <div className="space-y-3">
      {phase === 'idle' && (
        <button
          onClick={() => setDownloadConfirmOpen(true)}
          className="pg-btn pg-btn--primary w-full !py-3"
        >
          <Download size={18} />
          {t('update:downloadUpdate')}
        </button>
      )}

      {phase === 'downloading' && (
        <div>
          <div className="relative h-2 bg-[var(--pg-surface-3)] rounded-full overflow-hidden border border-[var(--pg-line)]">
            {pct === null ? (
              <div className="animate-indeterminate bg-[var(--pg-accent)] rounded-full" />
            ) : (
              <div
                className="h-full bg-[var(--pg-accent)] transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            )}
          </div>
          <div className="flex items-center justify-between text-xs text-[var(--pg-text-dim)] mt-2">
            <span className="flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" />
              {t('update:downloading')}
            </span>
            <span>
              {pct !== null && <span className="text-[var(--pg-text)] font-medium">{pct}% · </span>}
              {formatBytes(progress.downloaded)}
              {progress.total ? ` / ${formatBytes(progress.total)}` : ''}
            </span>
          </div>
        </div>
      )}

      {phase === 'downloaded' && (
        <div className="space-y-2">
          <div className="flex items-center justify-center gap-2 text-emerald-300 text-sm">
            <CheckCircle2 size={16} />
            {t('update:ready')}
          </div>
          <button
            onClick={requestRestart}
            className="w-full flex items-center justify-center gap-2 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium transition-colors"
          >
            <RotateCw size={18} />
            {t('update:restartToApply')}
          </button>
        </div>
      )}

      {phase === 'installing' && (
        <div className="flex items-center justify-center gap-2 py-3 text-[var(--pg-text-muted)] text-sm">
          <Loader2 size={16} className="animate-spin" />
          {t('update:installing')}
        </div>
      )}

      {phase === 'error' && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/15 border border-red-500/30 text-red-300 text-sm">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{error || t('update:updateFailed')}</span>
          </div>
          <button
            onClick={startDownload}
            className="pg-btn pg-btn--primary w-full"
          >
            <Download size={16} />
            {t('update:tryAgain')}
          </button>
        </div>
      )}

      <ConfirmDialog
        isOpen={downloadConfirmOpen}
        onConfirm={startDownload}
        onCancel={() => setDownloadConfirmOpen(false)}
        title={t('update:downloadConfirmTitle')}
        message={t('update:downloadConfirmMessage', {
          version: version ?? '',
        })}
        confirmText={t('update:downloadUpdate')}
        cancelText={t('update:cancel')}
        variant="info"
      />

      <ConfirmDialog
        isOpen={confirmOpen}
        onConfirm={doInstall}
        onCancel={() => setConfirmOpen(false)}
        title={t('update:gameRunningTitle')}
        message={t('update:gameRunningMessage')}
        confirmText={t('update:restartAnyway')}
        cancelText={t('update:notNow')}
        variant="warning"
      />
    </div>
  );
}
