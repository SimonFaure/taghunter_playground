// Desktop update installer: the shared "Download → Restart" action used by
// both the hard-floor overlay and the Settings → Updates screen.
//
// Fully user-driven (locked decision): nothing downloads or relaunches without
// a click. Before relaunching it checks whether a game / LAN mother session is
// live and, if so, asks the operator to confirm — but still allows it.

import { useState } from 'react';
import { Download, RotateCw, Loader2, AlertTriangle } from 'lucide-react';
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

export function DesktopUpdateInstaller() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<DownloadProgress>({ downloaded: 0, total: null });
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const startDownload = async () => {
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
          onClick={startDownload}
          className="w-full flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors"
        >
          <Download size={18} />
          Download update
        </button>
      )}

      {phase === 'downloading' && (
        <div>
          <div className="h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-700">
            <div
              className={`h-full bg-blue-500 ${pct === null ? 'animate-pulse w-1/3' : 'transition-all duration-300'}`}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-slate-400 mt-2">
            <span className="flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" />
              Downloading…
            </span>
            <span>
              {formatBytes(progress.downloaded)}
              {progress.total ? ` / ${formatBytes(progress.total)}` : ''}
            </span>
          </div>
        </div>
      )}

      {phase === 'downloaded' && (
        <button
          onClick={requestRestart}
          className="w-full flex items-center justify-center gap-2 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium transition-colors"
        >
          <RotateCw size={18} />
          Restart to apply update
        </button>
      )}

      {phase === 'installing' && (
        <div className="flex items-center justify-center gap-2 py-3 text-slate-300 text-sm">
          <Loader2 size={16} className="animate-spin" />
          Installing — the app will restart…
        </div>
      )}

      {phase === 'error' && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/15 border border-red-500/30 text-red-300 text-sm">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{error || 'The update failed.'}</span>
          </div>
          <button
            onClick={startDownload}
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors"
          >
            <Download size={16} />
            Try again
          </button>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmOpen}
        onConfirm={doInstall}
        onCancel={() => setConfirmOpen(false)}
        title="A game is running"
        message="Restarting now to install the update will interrupt the game in progress. Continue?"
        confirmText="Restart anyway"
        cancelText="Not now"
        variant="warning"
      />
    </div>
  );
}
