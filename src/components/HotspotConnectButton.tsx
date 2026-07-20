import { useCallback, useEffect, useRef, useState } from 'react';
import { Wifi, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { platform } from '@tauri-apps/plugin-os';
import { useLocalRole, useMotherConnection } from '../services/motherConnection';
import { runAutoConnect, resolveConsent } from '../services/wifiAutoConnect';
import { WifiAutoConnectPrompt } from './WifiAutoConnectPrompt';

type Toast = { kind: 'ok' | 'err'; text: string };

// Top-bar quick action: when THIS device is neither the mother nor connected to
// one, surface a one-tap "join the mother's Wi-Fi" button so the operator
// doesn't have to dig into Settings → Devices → Join. It runs the same
// `runAutoConnect` engine the Join tab uses (scan remembered/studio-synced
// hotspot creds, join the one in range), including the first-time consent
// prompt. Windows-only - the Wi-Fi scan/join primitives only exist there, which
// mirrors the footer Wi-Fi/Mother/Hotspot pills.
export function HotspotConnectButton() {
  const { t } = useTranslation('devicesLan');
  const localRole = useLocalRole();
  const conn = useMotherConnection();

  const [isWindows, setIsWindows] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [consentSsid, setConsentSsid] = useState<string | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      setIsWindows(platform() === 'windows');
    } catch {
      setIsWindows(false);
    }
  }, []);

  const flash = useCallback((next: Toast) => {
    setToast(next);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const connect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setToast(null);
    try {
      const r = await runAutoConnect({ allowPrompt: true });
      switch (r.kind) {
        case 'connected':
          flash({ kind: 'ok', text: t('autoConnected', { ssid: r.ssid }) });
          break;
        case 'failed':
          flash({ kind: 'err', text: t('autoConnectFailed', { ssid: r.ssid }) });
          break;
        case 'needs_consent':
          setConsentSsid(r.ssid);
          break;
        case 'noop':
          flash({
            kind: 'err',
            text:
              r.reason === 'no-networks'
                ? t('noStudioHotspot')
                : r.reason === 'already-on-known'
                  ? t('connectAlready')
                  : t('connectNotFound'),
          });
          break;
      }
    } catch (e) {
      flash({ kind: 'err', text: (e as Error)?.message || String(e) });
    } finally {
      setBusy(false);
    }
  }, [busy, flash, t]);

  const answerConsent = useCallback(async (consent: boolean) => {
    if (!consentSsid) return;
    setConsentBusy(true);
    try {
      const r = await resolveConsent(consentSsid, consent);
      if (r.kind === 'connected') flash({ kind: 'ok', text: t('autoConnected', { ssid: r.ssid }) });
      else if (r.kind === 'failed') flash({ kind: 'err', text: t('autoConnectFailed', { ssid: r.ssid }) });
    } finally {
      setConsentBusy(false);
      setConsentSsid(null);
    }
  }, [consentSsid, flash, t]);

  // Show only when this device is neither the mother (no local server, no
  // hotspot broadcasting) nor currently connected to a mother. `checking` is
  // excluded so a connected satellite doesn't flash the button on first load.
  const show =
    isWindows === true &&
    localRole !== null &&
    !localRole.isMother &&
    !localRole.isHotspot &&
    conn.kind !== 'child_ok' &&
    conn.kind !== 'checking';

  if (!show) return null;

  return (
    <>
      <button
        onClick={() => void connect()}
        disabled={busy}
        className="pg-icon-btn text-amber-400"
        aria-label={t('connectTooltip')}
        title={busy ? t('connectSearching') : t('connectTooltip')}
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Wifi size={16} />}
      </button>

      {toast && (
        <div
          className={`fixed top-16 right-4 z-50 max-w-xs text-sm rounded-lg px-3 py-2 border shadow-lg ${
            toast.kind === 'ok'
              ? 'bg-green-500/15 border-green-500/40 text-green-200'
              : 'bg-red-500/15 border-red-500/40 text-red-200'
          }`}
          role="status"
        >
          {toast.text}
        </div>
      )}

      {consentSsid && (
        <WifiAutoConnectPrompt ssid={consentSsid} busy={consentBusy} onAnswer={answerConsent} />
      )}
    </>
  );
}
