// "Réglages Windows" on every PC (retours sept. #20; satellites too since help v7): sleep on mains, Wi-Fi card power management, Public network profile. Checked
// when shown; one "Corriger" button fixes all of them under a single UAC prompt.
// `compact` renders only when something needs fixing (the status card uses it).

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { platform } from '@tauri-apps/plugin-os';
import { AlertTriangle, CheckCircle, Loader2, Monitor } from 'lucide-react';
import { checkWindowsHealth, fixWindowsHealth, type WindowsHealth } from '../../services/windowsHealth';
import { ErrorDetails } from '../ErrorDetails';

export function WindowsHealthPanel({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation('devicesLan');
  const [isWindows, setIsWindows] = useState(false);
  const [health, setHealth] = useState<WindowsHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    try { setIsWindows(platform() === 'windows'); } catch { setIsWindows(false); }
  }, []);

  const refresh = useCallback(async () => {
    setHealth(await checkWindowsHealth().catch(() => null));
  }, []);

  useEffect(() => {
    if (isWindows) void refresh();
  }, [isWindows, refresh]);

  const fix = async () => {
    setBusy(true);
    setError(null);
    try {
      setHealth(await fixWindowsHealth());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!isWindows || !health) return null;
  if (compact && !health.needs_fix) return null;

  const issues: string[] = [];
  if (health.sleep_ac_minutes != null && health.sleep_ac_minutes !== 0) {
    issues.push(t('winHealthSleep', { minutes: health.sleep_ac_minutes }));
  }
  if (health.wifi_power_management) issues.push(t('winHealthWifiPower'));
  if (health.public_networks.length > 0) {
    issues.push(t('winHealthPublic', { names: health.public_networks.join(', ') }));
  }

  return (
    <div className={compact ? 'mt-3' : 'pg-panel'}>
      {!compact && (
        <div className="flex items-center gap-2 mb-1">
          <Monitor className="w-5 h-5 text-[var(--pg-accent-bright)]" />
          <h3 className="pg-panel-title">{t('winHealthTitle')}</h3>
        </div>
      )}
      {issues.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-[var(--pg-ok-text)]">
          <CheckCircle className="w-4 h-4" />
          {t('winHealthOk')}
        </p>
      ) : (
        <div className="text-sm text-[var(--pg-warn-text)] bg-[var(--pg-warn-bg)] border border-[var(--pg-warn-line)] rounded-lg p-3">
          <p className="flex items-center gap-2 font-medium mb-1">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {t('winHealthIssuesTitle')}
          </p>
          <ul className="list-disc pl-6 space-y-0.5 text-xs">
            {issues.map((i) => <li key={i}>{i}</li>)}
          </ul>
          <button onClick={() => void fix()} disabled={busy} className="pg-btn pg-btn--primary mt-3">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {t('winHealthFix')}
          </button>
          <p className="text-xs text-[var(--pg-text-dim)] mt-2">{t('winHealthFixHint')}</p>
        </div>
      )}
      {error != null && <ErrorDetails error={error} className="mt-3" />}
    </div>
  );
}
