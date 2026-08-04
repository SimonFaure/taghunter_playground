import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { platform } from '@tauri-apps/plugin-os';
import { repairFirewallRule } from '../../services/firewall';

// "Network access (firewall)" repair panel - re-opens the app's inbound
// firewall rule with a UAC prompt. Windows-only; renders nothing elsewhere.
// The hint differs per role: mother = "others can't connect to me",
// child = "I can't discover the mother".
export function FirewallPanel({ hintKey }: { hintKey: 'firewallHint' | 'firewallHintChild' }) {
  const { t } = useTranslation('devicesLan');
  const [isWindows, setIsWindows] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'ok' | 'err' | null>(null);

  useEffect(() => {
    try { setIsWindows(platform() === 'windows'); } catch { setIsWindows(false); }
  }, []);

  const repair = useCallback(async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult((await repairFirewallRule()) ? 'ok' : 'err');
    } finally {
      setBusy(false);
    }
  }, []);

  if (!isWindows) return null;

  return (
    <div className="pg-panel">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck className="w-5 h-5 text-[var(--pg-accent-bright)]" />
        <h3 className="pg-panel-title">{t('firewallTitle')}</h3>
      </div>
      <p className="text-sm text-[var(--pg-text-dim)] mb-3">{t(hintKey)}</p>
      <button onClick={() => void repair()} disabled={busy} className="pg-btn">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
        {t('firewallRepair')}
      </button>
      {result && (
        <div className={`mt-3 text-sm rounded-lg p-2 border ${
          result === 'ok' ? 'bg-green-500/15 border-green-500/40 text-green-300'
                          : 'bg-red-500/15 border-red-500/40 text-red-300'}`}>
          {result === 'ok' ? t('firewallOk') : t('firewallErr')}
        </div>
      )}
    </div>
  );
}
