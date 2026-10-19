import { useCallback, useEffect, useState } from 'react';
import { Copy, Check, Router, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getLocalIpv4s, refreshMdns } from '../../services/lanPairing';
import { getCurrentSsid } from '../../services/wifi';
import { HelpDot } from '../../help';

const POLL_MS = 5000;

/**
 * The mother's network card. The mother no longer creates the Wi-Fi (the
 * hotspot was retired 2026-09-30): every PC joins the same router / venue
 * network through Windows. So this only shows what a satellite needs - the
 * network this PC is on and its IP address(es), for pairing by IP when the
 * network filters mDNS. The router arrives configured from the workshop: the
 * licensee only plugs it in, and the router checklist lives with the
 * diagnostics (LanDiagnostics), for support.
 */
export function MotherLanSection() {
  const { t } = useTranslation('devicesLan');
  const [ssid, setSsid] = useState<string | null>(null);
  const [addrs, setAddrs] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [reannouncing, setReannouncing] = useState(false);
  const [reannounceResult, setReannounceResult] = useState<'ok' | 'no_address' | 'error' | null>(null);

  const refresh = useCallback(async () => {
    const [current, ips] = await Promise.all([
      getCurrentSsid(),
      getLocalIpv4s().catch(() => [] as string[]),
    ]);
    setSsid(current);
    // APIPA (169.254.x) means "no DHCP lease": never reachable across the LAN.
    setAddrs(ips.filter((a) => !a.startsWith('169.254.') && !a.startsWith('127.')));
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // After a Wi-Fi network change the server keeps listening (0.0.0.0) but its
  // mDNS announcement still carries the old IP. The 10 s keepalive in App.tsx
  // catches that on its own; this button does it now, instead of restarting.
  async function reannounce() {
    setReannouncing(true);
    setReannounceResult(null);
    try {
      const advertised = await refreshMdns();
      setReannounceResult(advertised.length > 0 ? 'ok' : 'no_address');
    } catch {
      setReannounceResult('error');
    } finally {
      setReannouncing(false);
      void refresh();
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied((c) => (c === value ? null : c)), 1500);
    } catch { /* clipboard may be unavailable */ }
  }

  return (
    <div className="pg-panel">
      <div className="flex items-center gap-1.5">
        <Router className="w-5 h-5 text-[var(--pg-accent-bright)]" />
        <h3 className="pg-panel-title">{t('networkCardTitle')}</h3>
        <HelpDot topic="devices.router-pairing" />
      </div>
      <p className="text-sm text-[var(--pg-text-dim)] mb-4">{t('networkCardSub')}</p>

      <div className="flex flex-wrap gap-x-10 gap-y-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--pg-text-dim)]">{t('networkCardWifi')}</div>
          <div className="font-mono text-lg text-[var(--pg-text)]">{ssid || t('networkCardWired')}</div>
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--pg-text-dim)]">{t('networkCardAddress')}</div>
          {addrs.length === 0 ? (
            <div className="text-sm text-[var(--pg-warn-text)]">{t('networkCardNoAddress')}</div>
          ) : (
            addrs.map((a) => (
              <div key={a} className="flex items-center gap-1">
                <span className="font-mono text-lg text-[var(--pg-text)]">{a}</span>
                <button type="button" onClick={() => void copy(a)} title={t('copy')}
                  className="p-1.5 rounded-lg text-[var(--pg-text-muted)] hover:bg-[var(--pg-surface-3)]">
                  {copied === a ? <Check className="w-4 h-4 text-[var(--pg-ok-icon)]" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-[var(--pg-text-dim)]">{t('networkCardAddressHint')}</p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="pg-btn" disabled={reannouncing} onClick={() => void reannounce()}>
          <RefreshCw className={`w-4 h-4 ${reannouncing ? 'animate-spin' : ''}`} />
          {t('networkCardReannounce')}
        </button>
        {reannounceResult === 'ok' && (
          <span className="text-sm text-[var(--pg-ok-icon)]">{t('networkCardReannounceOk')}</span>
        )}
        {reannounceResult === 'no_address' && (
          <span className="text-sm text-[var(--pg-warn-text)]">{t('networkCardNoAddress')}</span>
        )}
        {reannounceResult === 'error' && (
          <span className="text-sm text-[var(--pg-warn-text)]">{t('networkCardReannounceError')}</span>
        )}
      </div>
      <p className="mt-1 text-xs text-[var(--pg-text-dim)]">{t('networkCardReannounceHint')}</p>

      <p className="mt-4 text-sm text-[var(--pg-text)]">{t('networkCardRouterLine')}</p>
    </div>
  );
}
