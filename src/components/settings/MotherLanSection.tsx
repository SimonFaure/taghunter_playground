import { useCallback, useEffect, useState } from 'react';
import {
  Wifi, WifiOff, Copy, Check, Loader2, Router,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  hotspotStatus, startHotspot, stopHotspot, refreshMdns,
  type HotspotStatus,
} from '../../services/lanPairing';
import {
  getNetworkSource, setNetworkSource, getRouterCreds, saveRouterCreds,
  getStudioHotspots, getPreferredHotspotCreds, getPreferredHotspotSsid, setPreferredHotspotSsid,
  type NetworkSource, type HotspotCreds,
} from '../../services/lanCredentials';
import { WifiQr } from './WifiQr';
import { HelpDot } from '../../help';
import { relaunchToApply } from '../../services/appRelaunch';
import { applyHotspotBandPreference } from '../../services/lanMotherBoot';
import { loadConfig, saveConfig } from '../../utils/config';
import { ErrorDetails } from '../ErrorDetails';

const POLL_MS = 4000;

/**
 * The mother's Wi-Fi, in three views (retours sept. #10):
 *  - `summary`: mother main page - mode tiles + network name/password, nothing else;
 *  - `details`: mother, under Avancé - band, venue, IPs, router editor/QR/checklist,
 *    start/stop (stop is red and confirmed);
 *  - `mode`: satellite, under Avancé - the mode tiles only, no hotspot control.
 */
export type MotherLanView = 'summary' | 'details' | 'mode';

export function MotherLanSection({ view }: { view: MotherLanView }) {
  const { t } = useTranslation('devicesLan');
  const [confirmStop, setConfirmStop] = useState(false);

  // Hotspot creds are now authored in studio and pushed down on sync (the local
  // mirror). This section is READ-ONLY: it shows the active hotspot + a picker
  // when several are synced (multi-venue). The operator can no longer type or
  // regenerate creds here - that's done in studio.
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [studioHotspots, setStudioHotspots] = useState<HotspotCreds[]>([]);
  const [preferredSsid, setPreferredSsidState] = useState('');
  const [status, setStatus] = useState<HotspotStatus | null>(null);
  const [busyHotspot, setBusyHotspot] = useState(false);
  const [hotspotErr, setHotspotErr] = useState<unknown>(null);
  const [copied, setCopied] = useState<'ssid' | 'password' | null>(null);

  // Network source: create the LAN with this device's hotspot, or ride on an
  // external router. Only drives which host UI is shown - the pairing/discovery
  // stack works identically either way.
  const [networkSource, setNetworkSourceState] = useState<NetworkSource>('hotspot');
  // A source switch is applied through a relaunch (retours sept. #5: it used to
  // silently wait for the next manual restart - an hour lost on the field).
  const [pendingSource, setPendingSource] = useState<NetworkSource | null>(null);
  const [relaunching, setRelaunching] = useState(false);
  const [band24, setBand24] = useState(true);
  useEffect(() => {
    void loadConfig().then((c) => setBand24((c.hotspotBand ?? '2.4') === '2.4')).catch(() => {});
  }, []);
  async function toggleBand(on: boolean) {
    setBand24(on);
    const band = on ? '2.4' : 'auto';
    const cfg = await loadConfig().catch(() => null);
    if (cfg) await saveConfig({ ...cfg, hotspotBand: band }).catch(() => {});
    await applyHotspotBandPreference(band);
  }
  const [routerSsid, setRouterSsid] = useState('');
  const [routerPassword, setRouterPassword] = useState('');

  const refresh = useCallback(async () => {
    setStatus(await hotspotStatus().catch(() => null));
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Load the studio-synced hotspots + this device's preferred choice, and show
  // the resolved active creds (preferred, else first). Studio is the sole author,
  // so the display is ALWAYS the authoritative synced creds - never the SSID of a
  // hotspot that happens to be broadcasting (which may be stale until the next
  // cold start). A live mismatch is surfaced as a "restart to apply" note below.
  const reloadHotspots = useCallback(async () => {
    const [hotspots, preferred, resolved] = await Promise.all([
      getStudioHotspots(),
      getPreferredHotspotSsid(),
      getPreferredHotspotCreds(),
    ]);
    setStudioHotspots(hotspots);
    setPreferredSsidState(preferred);
    setSsid(resolved?.ssid ?? '');
    setPassword(resolved?.password ?? '');
  }, []);

  useEffect(() => {
    void reloadHotspots();
    const id = setInterval(() => void reloadHotspots(), POLL_MS);
    return () => clearInterval(id);
  }, [reloadHotspots]);

  async function selectPreferred(nextSsid: string) {
    setPreferredSsidState(nextSsid);
    await setPreferredHotspotSsid(nextSsid).catch(() => { /* best-effort */ });
    const match = studioHotspots.find((h) => h.ssid === nextSsid);
    if (match) {
      setSsid(match.ssid);
      setPassword(match.password);
    }
  }

  // Load the persisted network source + router credentials once.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([getNetworkSource(), getRouterCreds()]).then(([src, creds]) => {
      if (cancelled) return;
      setNetworkSourceState(src);
      setRouterSsid(creds.ssid);
      setRouterPassword(creds.password);
    });
    return () => { cancelled = true; };
  }, []);

  const windowsOnly = status != null && status.platform !== 'windows';
  const running = status?.running ?? false;

  // Addresses to advertise as the mother's reachable IP. Prefer real LAN
  // addresses over link-local/APIPA (169.254.x), which are unreachable.
  const allAddrs = status?.ipv4_addresses ?? [];
  const routableAddrs = allAddrs.filter((a) => !a.startsWith('169.254.'));
  const motherAddrs = routableAddrs.length > 0 ? routableAddrs : allAddrs;

  function selectSource(src: NetworkSource) {
    setPendingSource(src === networkSource ? null : src);
  }

  async function applySource(src: NetworkSource) {
    setRelaunching(true);
    setNetworkSourceState(src);
    await setNetworkSource(src).catch(() => { /* best-effort */ });
    // Switching to router mode: this device shouldn't be an access point and a
    // router client at once - stop a running hotspot.
    if (src === 'router' && running) {
      try { await stopHotspot(); } catch { /* best-effort */ }
    }
    await relaunchToApply(800);
  }

  function onRouterSsidChange(v: string) {
    setRouterSsid(v);
    void saveRouterCreds(v, routerPassword);
  }
  function onRouterPasswordChange(v: string) {
    setRouterPassword(v);
    void saveRouterCreds(routerSsid, v);
  }

  async function toggleHotspot() {
    setBusyHotspot(true);
    setHotspotErr(null);
    try {
      if (running) {
        await stopHotspot();
        setConfirmStop(false);
      } else {
        const creds = await getPreferredHotspotCreds();
        if (!creds) {
          setHotspotErr({ message: t('noStudioHotspot'), detail: null });
          setBusyHotspot(false);
          return;
        }
        setSsid(creds.ssid);
        setPassword(creds.password);
        const info = await startHotspot(creds.ssid, creds.password);
        // Re-announce over mDNS with the hotspot's AP-subnet IPv4 so satellites
        // resolve a reachable address (not the stale link-local/APIPA ones).
        if (info.ipv4_addresses.length > 0) {
          await refreshMdns(info.ipv4_addresses).catch(() => { /* best-effort */ });
        }
      }
      await refresh();
    } catch (e) {
      setHotspotErr(e);
    } finally {
      setBusyHotspot(false);
    }
  }

  async function copy(which: 'ssid' | 'password', value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
    } catch { /* clipboard may be unavailable */ }
  }

  const modeTiles = (
    <>
      <div className="grid sm:grid-cols-2 gap-3">
        {(['hotspot', 'router'] as const).map((src) => {
          const active = (pendingSource ?? networkSource) === src;
          const Icon = src === 'hotspot' ? Wifi : Router;
          return (
            <button
              key={src}
              type="button"
              onClick={() => selectSource(src)}
              disabled={busyHotspot || relaunching}
              className={`flex items-start gap-3 p-4 rounded-lg border-2 text-left disabled:opacity-50 ${
                active ? 'border-[var(--pg-accent)] bg-[var(--pg-surface)]'
                       : 'border-[var(--pg-line)] bg-[var(--pg-surface)] hover:bg-[var(--pg-surface-3)]'}`}
            >
              <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${active ? 'text-[var(--pg-accent-bright)]' : 'text-[var(--pg-text-dim)]'}`} />
              <span className="min-w-0">
                <span className={`block font-semibold ${active ? 'text-[var(--pg-text)]' : 'text-[var(--pg-text-muted)]'}`}>
                  {src === 'hotspot' ? t('tileHotspotTitle') : t('tileRouterTitle')}
                </span>
                <span className="block text-sm text-[var(--pg-text-dim)]">
                  {src === 'hotspot' ? t('tileHotspotSub') : t('tileRouterSub')}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {pendingSource && (
        <div className="mt-3 p-3 rounded-lg border border-[var(--pg-warn-line,var(--pg-line))] bg-[var(--pg-surface-2)]">
          <p className="text-xs text-[var(--pg-text)] mb-2">{t('relaunchNote')}</p>
          <div className="flex gap-2">
            <button className="pg-btn" disabled={relaunching} onClick={() => setPendingSource(null)}>
              {t('notMotherCancel')}
            </button>
            <button
              className="pg-btn pg-btn--primary"
              disabled={relaunching}
              onClick={() => void applySource(pendingSource)}
            >
              {relaunching ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {relaunching ? t('relaunchingToApply') : t('relaunchConfirm')}
            </button>
          </div>
        </div>
      )}
    </>
  );

  // Satellite, Avancé → Mode réseau: the choice only. No hotspot control at all
  // (retours sept. #10: a satellite must never be one click away from raising a
  // second Tag Hunter Wi-Fi).
  if (view === 'mode') return <div>{modeTiles}</div>;

  // Mother, main page (mockup 3): the mode, the network name and password.
  // Everything technical lives in view="details" under Avancé.
  if (view === 'summary') {
    const shownSsid = networkSource === 'router' ? routerSsid : ssid;
    const shownPassword = networkSource === 'router' ? routerPassword : password;
    const missing = networkSource === 'hotspot' ? studioHotspots.length === 0 : !routerSsid;
    return (
      <div className="pg-panel">
        <div className="flex items-center gap-1.5">
          <h3 className="pg-panel-title">{t('wifiCardTitle')}</h3>
          <HelpDot topic="devices.router-pairing" />
        </div>
        <p className="text-sm text-[var(--pg-text-dim)] mb-4">{t('wifiCardSub')}</p>
        {modeTiles}
        {missing ? (
          <p className="mt-4 text-xs text-[var(--pg-text-dim)]">
            {networkSource === 'hotspot' ? t('noStudioHotspot') : t('wifiCardRouterMissing')}
          </p>
        ) : (
          <div className="mt-5 flex flex-wrap gap-x-10 gap-y-3">
            <ReadOnlyCred
              label={t('wifiCardName')} value={shownSsid}
              onCopy={() => copy('ssid', shownSsid)} copied={copied === 'ssid'} copyLabel={t('copy')}
            />
            <ReadOnlyCred
              label={t('wifiCardPassword')} value={shownPassword}
              onCopy={() => copy('password', shownPassword)} copied={copied === 'password'} copyLabel={t('copy')}
            />
          </div>
        )}
      </div>
    );
  }

  // Mother, Avancé → "Wi-Fi : réglages avancés".
  return (
    <div className="space-y-5">
      {networkSource === 'router' ? (
        /* ── External router ── */
        <div className="space-y-4">
          <p className="text-sm text-[var(--pg-text-muted)]">{t('routerIntro')}</p>

          {motherAddrs.length > 0 && (
            <div className="text-xs text-[var(--pg-text-dim)]">
              {t('routerMotherAddress', { addrs: motherAddrs.join(', ') })}
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-3">
            <CredField
              label={t('routerSsidLabel')} value={routerSsid} onChange={onRouterSsidChange}
              disabled={false}
              onCopy={() => copy('ssid', routerSsid)} copied={copied === 'ssid'}
              copyLabel={t('copy')} copiedLabel={t('copied')}
            />
            <CredField
              label={t('routerPasswordLabel')} value={routerPassword} onChange={onRouterPasswordChange}
              disabled={false}
              onCopy={() => copy('password', routerPassword)} copied={copied === 'password'}
              copyLabel={t('copy')} copiedLabel={t('copied')}
            />
          </div>
          <p className="text-xs text-[var(--pg-text-dim)]">{t('routerCredsHint')}</p>

          <WifiQr ssid={routerSsid} password={routerPassword} caption={t('routerQrCaption')} />

          <div className="text-xs text-[var(--pg-warn-text)] bg-[var(--pg-warn-bg)] border border-[var(--pg-warn-line)] rounded-lg p-3 space-y-1">
            <p className="font-medium text-[var(--pg-warn-text)]">{t('routerChecklistTitle')}</p>
            <ul className="list-disc pl-4 space-y-0.5">
              <li>{t('routerChecklistIsolation')}</li>
              <li>{t('routerChecklistSameNetwork')}</li>
              <li>{t('routerChecklistBand')}</li>
            </ul>
          </div>
        </div>
      ) : (
      /* ── Hotspot details ── */
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          {running ? <Wifi className="w-5 h-5 text-[var(--pg-ok-icon)]" /> : <WifiOff className="w-5 h-5 text-[var(--pg-text-dim)]" />}
          <span className="font-semibold text-[var(--pg-text)]">{t('hotspotTitle')}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full border ${
            running ? 'bg-[var(--pg-ok-bg)] text-[var(--pg-ok-text)] border-[var(--pg-ok-line)]'
                    : 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)] border-[var(--pg-line-strong)]'}`}>
            {running ? t('hotspotRunning') : t('hotspotStopped')}
          </span>
        </div>

        <label className="flex items-start gap-2 text-sm text-[var(--pg-text-muted)] cursor-pointer">
          <input
            type="checkbox"
            className="mt-1"
            checked={band24}
            onChange={(e) => void toggleBand(e.target.checked)}
          />
          <span>
            {t('hotspotBand24')}
            <span className="block text-xs text-[var(--pg-text-dim)]">{t('hotspotBand24Hint')}</span>
          </span>
        </label>

        {/* Multi-venue: pick which of the client's hotspots this device raises. */}
        {studioHotspots.length > 1 && (
          <div>
            <label className="pg-label">{t('preferredHotspotLabel')}</label>
            <select
              value={preferredSsid || (studioHotspots[0]?.ssid ?? '')}
              onChange={(e) => void selectPreferred(e.target.value)}
              disabled={running || busyHotspot}
              className="pg-input w-full font-mono disabled:opacity-70"
            >
              {studioHotspots.map((h) => (
                <option key={h.ssid} value={h.ssid}>{h.ssid}</option>
              ))}
            </select>
          </div>
        )}
        {studioHotspots.length > 0 && (
          <p className="text-[11px] text-[var(--pg-text-dim)]">{t('studioManagedHint')}</p>
        )}

        {running && status && status.ipv4_addresses.length > 0 && (
          <div className="text-xs text-[var(--pg-text-dim)]">
            {t('ipAddresses', { addrs: status.ipv4_addresses.join(', ') })}
          </div>
        )}

        {/* The live AP is broadcasting a different SSID than the configured one
            (creds changed in studio since it was raised). Cold-start to apply. */}
        {running && status?.ssid && ssid && status.ssid !== ssid && (
          <div className="text-xs text-[var(--pg-warn-text)] bg-[var(--pg-warn-bg)] border border-[var(--pg-warn-line)] rounded-lg p-2">
            {t('hotspotBroadcastMismatch', { current: status.ssid })}
          </div>
        )}

        {windowsOnly && (
          <div className="text-xs text-[var(--pg-warn-text)] bg-[var(--pg-warn-bg)] border border-[var(--pg-warn-line)] rounded-lg p-2">
            {t('hotspotWindowsOnly')}
          </div>
        )}
        {hotspotErr != null && <ErrorDetails error={hotspotErr} />}

        {/* Stopping the AP drops every satellite: red, and confirmed. */}
        {running && confirmStop ? (
          <div className="p-3 rounded-lg border border-[var(--pg-line)] bg-[var(--pg-surface-2)] space-y-2">
            <p className="text-sm text-[var(--pg-text)]">{t('stopHotspotConfirm')}</p>
            <div className="flex gap-2">
              <button className="pg-btn" disabled={busyHotspot} onClick={() => setConfirmStop(false)}>
                {t('notMotherCancel')}
              </button>
              <button className="pg-btn pg-btn--danger" disabled={busyHotspot} onClick={() => void toggleHotspot()}>
                {busyHotspot ? <Loader2 className="w-4 h-4 animate-spin" /> : <WifiOff className="w-4 h-4" />}
                {t('stopHotspot')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => (running ? setConfirmStop(true) : void toggleHotspot())}
            disabled={busyHotspot || windowsOnly}
            className={`pg-btn ${running ? 'pg-btn--danger' : 'pg-btn--primary'}`}
          >
            {busyHotspot ? <Loader2 className="w-4 h-4 animate-spin" />
                         : running ? <WifiOff className="w-4 h-4" /> : <Wifi className="w-4 h-4" />}
            {running ? t('stopHotspot') : t('startHotspot')}
          </button>
        )}
      </div>
      )}
    </div>
  );
}

function ReadOnlyCred({
  label, value, onCopy, copied, copyLabel,
}: {
  label: string; value: string; onCopy: () => void; copied: boolean; copyLabel: string;
}) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--pg-text-dim)]">{label}</div>
      <div className="flex items-center gap-1">
        <span className="font-mono text-lg text-[var(--pg-text)]">{value || '-'}</span>
        {value && (
          <button type="button" onClick={onCopy} title={copyLabel}
            className="p-1.5 rounded-lg text-[var(--pg-text-muted)] hover:bg-[var(--pg-surface-3)]">
            {copied ? <Check className="w-4 h-4 text-[var(--pg-ok-icon)]" /> : <Copy className="w-4 h-4" />}
          </button>
        )}
      </div>
    </div>
  );
}

function CredField({
  label, value, onChange, disabled, onCopy, copied, copyLabel, copiedLabel,
}: {
  label: string; value: string; onChange: (v: string) => void; disabled: boolean;
  onCopy: () => void; copied: boolean; copyLabel: string; copiedLabel: string;
}) {
  return (
    <div>
      <label className="pg-label">{label}</label>
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="pg-input flex-1 font-mono disabled:opacity-70"
        />
        <button type="button" onClick={onCopy} title={copyLabel}
          className="p-2 rounded-lg text-[var(--pg-text-muted)] hover:bg-[var(--pg-surface-3)]">
          {copied ? <Check className="w-4 h-4 text-[var(--pg-ok-icon)]" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      {copied && <div className="text-[10px] text-[var(--pg-ok-icon)] mt-0.5">{copiedLabel}</div>}
    </div>
  );
}
