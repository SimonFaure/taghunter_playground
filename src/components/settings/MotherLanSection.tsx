import { useCallback, useEffect, useState } from 'react';
import {
  Wifi, WifiOff, Copy, Check, Loader2, Trash2, Monitor, Smartphone, Tablet, Router, Crown,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { listActiveLaunchedGames, queueBecomeMotherCommand } from '../../services/launchedGames';
import {
  hotspotStatus, startHotspot, stopHotspot, refreshMdns,
  listPendingPairRequests, approvePairRequest, denyPairRequest,
  listPairedDevices, revokePairedDevice,
  formatLanTime, isRecent, displayDeviceLabel,
  type HotspotStatus, type PendingPairRequest, type PairedDeviceRow,
} from '../../services/lanPairing';
import {
  getNetworkSource, setNetworkSource, getRouterCreds, saveRouterCreds,
  getStudioHotspots, getPreferredHotspotCreds, getPreferredHotspotSsid, setPreferredHotspotSsid,
  type NetworkSource, type HotspotCreds,
} from '../../services/lanCredentials';
import { WifiQr } from './WifiQr';
import { HelpDot } from '../../help';

const POLL_MS = 4000;

export function MotherLanSection() {
  const { t } = useTranslation('devicesLan');

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
  const [hotspotErr, setHotspotErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<'ssid' | 'password' | null>(null);

  const [pending, setPending] = useState<PendingPairRequest[]>([]);
  const [paired, setPaired] = useState<PairedDeviceRow[]>([]);
  const [busyReqId, setBusyReqId] = useState<number | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  // Active launched game (for the per-device "Make mother" handover button) and
  // which device a handover is being queued to.
  const [activeGameId, setActiveGameId] = useState<number | null>(null);
  const [makingMotherId, setMakingMotherId] = useState<number | null>(null);

  // Network source: create the LAN with this device's hotspot, or ride on an
  // external router. Only drives which host UI is shown - the pairing/discovery
  // stack works identically either way.
  const [networkSource, setNetworkSourceState] = useState<NetworkSource>('hotspot');
  const [routerSsid, setRouterSsid] = useState('');
  const [routerPassword, setRouterPassword] = useState('');

  const refresh = useCallback(async () => {
    const [st, pend, dev, games] = await Promise.all([
      hotspotStatus().catch(() => null),
      listPendingPairRequests().catch(() => [] as PendingPairRequest[]),
      listPairedDevices().catch(() => [] as PairedDeviceRow[]),
      listActiveLaunchedGames().catch(() => []),
    ]);
    setStatus(st);
    setPending(pend);
    setPaired(dev);
    // Most-recent active game is the handover target's game.
    setActiveGameId(games[0]?.id ?? null);
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

  async function selectSource(src: NetworkSource) {
    if (src === networkSource) return;
    setNetworkSourceState(src);
    await setNetworkSource(src).catch(() => { /* best-effort */ });
    // Switching to router mode: this device shouldn't be an access point and a
    // router client at once - stop a running hotspot.
    if (src === 'router' && running) {
      setBusyHotspot(true);
      try { await stopHotspot(); await refresh(); }
      catch { /* best-effort */ }
      finally { setBusyHotspot(false); }
    }
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
      } else {
        const creds = await getPreferredHotspotCreds();
        if (!creds) {
          setHotspotErr(t('noStudioHotspot'));
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
      setHotspotErr((e as Error).message);
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

  async function approve(id: number) {
    setBusyReqId(id);
    try { await approvePairRequest(id); await refresh(); }
    finally { setBusyReqId(null); }
  }
  async function deny(id: number) {
    setBusyReqId(id);
    try { await denyPairRequest(id); await refresh(); }
    finally { setBusyReqId(null); }
  }
  async function revoke(d: PairedDeviceRow) {
    if (!window.confirm(t('revokeConfirm'))) return;
    setRevokingId(d.id);
    try { await revokePairedDevice(d.id); await refresh(); }
    finally { setRevokingId(null); }
  }
  // Planned handover: tell a paired device to take over as the mother for the
  // active game. It adopts its cached snapshot and promotes; this device yields.
  async function makeMother(d: PairedDeviceRow) {
    if (activeGameId == null) return;
    if (!window.confirm(t('makeMotherConfirm', {
      defaultValue:
        'Hand the game over to this device? It becomes the mother and the other devices reconnect to it.',
    }))) return;
    setMakingMotherId(d.id);
    try {
      await queueBecomeMotherCommand(d.id, activeGameId);
    } catch (e) {
      window.alert(t('makeMotherError', {
        defaultValue: 'Could not hand over: {{message}}',
        message: (e as Error).message,
      }));
    } finally {
      setMakingMotherId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Network source selector ── */}
      <div className="pg-panel">
        <div className="flex items-center gap-1.5 mb-3">
          <h3 className="pg-panel-title">{t('networkSourceTitle')}</h3>
          <HelpDot topic="devices.router-pairing" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(['hotspot', 'router'] as const).map((src) => {
            const active = networkSource === src;
            const Icon = src === 'hotspot' ? Wifi : Router;
            return (
              <button
                key={src}
                type="button"
                onClick={() => void selectSource(src)}
                disabled={busyHotspot}
                className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium disabled:opacity-50 ${
                  active ? 'bg-[var(--pg-accent-tint)] text-[var(--pg-accent-bright)] border-[var(--pg-accent-line)]'
                         : 'bg-[var(--pg-bg)] text-[var(--pg-text-muted)] border-[var(--pg-line)] hover:bg-[var(--pg-surface-3)]'}`}
              >
                <Icon className="w-4 h-4" />
                {src === 'hotspot' ? t('sourceHotspot') : t('sourceRouter')}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-[var(--pg-text-dim)] mt-3">
          {networkSource === 'router' ? t('sourceRouterHint') : t('sourceHotspotHint')}
        </p>
      </div>

      {networkSource === 'router' ? (
        /* ── External router ── */
        <div className="pg-panel space-y-4">
          <div className="flex items-center gap-2">
            <Router className="w-5 h-5 text-[var(--pg-accent-bright)]" />
            <h3 className="pg-panel-title">{t('routerTitle')}</h3>
          </div>
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

          <div className="text-xs text-amber-200/90 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 space-y-1">
            <p className="font-medium text-amber-200">{t('routerChecklistTitle')}</p>
            <ul className="list-disc pl-4 space-y-0.5">
              <li>{t('routerChecklistIsolation')}</li>
              <li>{t('routerChecklistSameNetwork')}</li>
              <li>{t('routerChecklistBand')}</li>
            </ul>
          </div>
        </div>
      ) : (
      /* ── Hotspot control ── */
      <div className="pg-panel">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            {running ? <Wifi className="w-5 h-5 text-green-400" /> : <WifiOff className="w-5 h-5 text-[var(--pg-text-dim)]" />}
            <h3 className="pg-panel-title">{t('hotspotTitle')}</h3>
            <span className={`text-xs px-2 py-0.5 rounded-full border ${
              running ? 'bg-green-500/20 text-green-300 border-green-500/40'
                      : 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)] border-[var(--pg-line-strong)]'}`}>
              {running ? t('hotspotRunning') : t('hotspotStopped')}
            </span>
          </div>
        </div>

        {studioHotspots.length === 0 ? (
          <div className="text-xs text-[var(--pg-text-dim)] bg-[var(--pg-bg)] border border-[var(--pg-line)] rounded-lg p-3">
            {t('noStudioHotspot')}
          </div>
        ) : (
          <>
            {/* Multi-venue: pick which of the client's hotspots this device raises. */}
            {studioHotspots.length > 1 && (
              <div className="mb-3">
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

            <div className="grid sm:grid-cols-2 gap-3">
              <CredField
                label={t('ssidLabel')} value={ssid} onChange={setSsid}
                disabled
                onCopy={() => copy('ssid', ssid)} copied={copied === 'ssid'}
                copyLabel={t('copy')} copiedLabel={t('copied')}
              />
              <CredField
                label={t('passwordLabel')} value={password} onChange={setPassword}
                disabled
                onCopy={() => copy('password', password)} copied={copied === 'password'}
                copyLabel={t('copy')} copiedLabel={t('copied')}
              />
            </div>
            <p className="text-[11px] text-[var(--pg-text-dim)] mt-2">{t('studioManagedHint')}</p>
          </>
        )}

        {running && status && status.ipv4_addresses.length > 0 && (
          <div className="text-xs text-[var(--pg-text-dim)] mt-3">
            {t('ipAddresses', { addrs: status.ipv4_addresses.join(', ') })}
          </div>
        )}

        {/* The live AP is broadcasting a different SSID than the configured one
            (creds changed in studio since it was raised). Cold-start to apply. */}
        {running && status?.ssid && ssid && status.ssid !== ssid && (
          <div className="mt-3 text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2">
            {t('hotspotBroadcastMismatch', { current: status.ssid })}
          </div>
        )}

        {windowsOnly && (
          <div className="mt-3 text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2">
            {t('hotspotWindowsOnly')}
          </div>
        )}
        {hotspotErr && (
          <div className="mt-3 text-xs text-red-300 bg-red-500/15 border border-red-500/40 rounded-lg p-2">
            {t('hotspotError', { message: hotspotErr })}
          </div>
        )}

        <button
          type="button"
          onClick={toggleHotspot}
          disabled={busyHotspot || windowsOnly}
          className={`mt-4 px-4 py-2 rounded-lg font-medium flex items-center gap-2 disabled:opacity-50 ${
            running ? 'bg-red-500/20 text-red-200 hover:bg-red-500/30'
                    : 'bg-green-600 text-white hover:bg-green-500'}`}
        >
          {busyHotspot ? <Loader2 className="w-4 h-4 animate-spin" />
                       : running ? <WifiOff className="w-4 h-4" /> : <Wifi className="w-4 h-4" />}
          {running ? t('stopHotspot') : t('startHotspot')}
        </button>

        <div className="mt-4 text-xs text-[var(--pg-text-dim)] space-y-1">
          <p className="font-medium text-[var(--pg-text-muted)]">{t('joinHelpTitle')}</p>
          <p>{t('joinHelpBody')}</p>
          <p className="text-[var(--pg-text-dim)]">{t('joinHelpBand')}</p>
        </div>
      </div>
      )}

      {/* ── Pending requests ── */}
      {pending.length > 0 && (
        <div className="pg-panel border-[var(--pg-accent-line)]">
          <h3 className="pg-panel-title mb-3">{t('pendingTitle')}</h3>
          <div className="space-y-2">
            {pending.map((r) => {
              const Icon = osIcon(r.peer_os);
              const busy = busyReqId === r.id;
              return (
                <div key={r.id} className="flex items-center gap-3 p-3 rounded-lg bg-[var(--pg-bg)] border border-[var(--pg-line)]">
                  <Icon className="w-5 h-5 text-[var(--pg-text-muted)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[var(--pg-text)] font-medium truncate">{r.peer_label || t('unknownDevice')}</div>
                    <div className="text-xs text-[var(--pg-text-dim)]">
                      {[r.peer_os, r.peer_app_version && `app ${r.peer_app_version}`].filter(Boolean).join(' · ')}
                      {` · ${t('requestedAt', { time: formatLanTime(r.created_at) })}`}
                    </div>
                  </div>
                  <button onClick={() => approve(r.id)} disabled={busy}
                    className="px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-500 text-sm flex items-center gap-1 disabled:opacity-50">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}{t('approve')}
                  </button>
                  <button onClick={() => deny(r.id)} disabled={busy}
                    className="px-3 py-1.5 rounded-lg text-red-300 hover:bg-red-500/20 text-sm disabled:opacity-50">
                    {t('deny')}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Paired devices ── */}
      <div>
        <h3 className="pg-panel-title mb-3">{t('pairedTitle')}</h3>
        {paired.length === 0 ? (
          <div className="text-[var(--pg-text-dim)] text-sm py-4">{t('pairedEmpty')}</div>
        ) : (
          <div className="space-y-2">
            {paired.map((d) => {
              const Icon = osIcon(d.peer_os);
              const online = d.is_self || isRecent(d.last_seen_at);
              return (
                <div key={d.id} className={`p-4 rounded-xl border flex items-center gap-4 ${
                  d.is_self ? 'bg-[var(--pg-accent-tint)] border-[var(--pg-accent-line)]' : 'bg-[var(--pg-surface)] border-[var(--pg-line)]'}`}>
                  <Icon className="w-6 h-6 text-[var(--pg-text-muted)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[var(--pg-text)] font-medium truncate">
                        {displayDeviceLabel(d.peer_label) || (d.is_self ? t('thisDevice') : t('unknownDevice'))}
                      </span>
                      {d.is_self && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--pg-accent-tint)] text-[var(--pg-accent-bright)] border border-[var(--pg-accent-line)]">
                          {t('thisDevice')}
                        </span>
                      )}
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${
                        online ? 'bg-green-500/20 text-green-300 border-green-500/40'
                               : 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)] border-[var(--pg-line-strong)]'}`}>
                        {online ? t('online') : t('offline')}
                      </span>
                    </div>
                    <div className="text-xs text-[var(--pg-text-dim)] mt-1">
                      {d.peer_os}
                      {d.last_seen_at && ` · ${t('lastSeen', { time: formatLanTime(d.last_seen_at) })}`}
                    </div>
                  </div>
                  {!d.is_self && online && activeGameId != null && (
                    <button onClick={() => makeMother(d)} disabled={makingMotherId === d.id}
                      title={t('makeMother', { defaultValue: 'Make this device the mother' })}
                      className="px-2.5 py-1.5 rounded-lg text-yellow-300 hover:bg-yellow-500/15 disabled:opacity-50 flex items-center gap-1.5 text-sm">
                      {makingMotherId === d.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crown className="w-4 h-4" />}
                      {t('makeMotherBtn', { defaultValue: 'Make mother' })}
                    </button>
                  )}
                  {!d.is_self && (
                    <button onClick={() => revoke(d)} disabled={revokingId === d.id}
                      title={t('revoke')}
                      className="p-2 rounded-lg text-red-300 hover:bg-red-500/20 disabled:opacity-50">
                      {revokingId === d.id ? <Loader2 className="w-5 h-5 animate-spin" /> : <Trash2 className="w-5 h-5" />}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
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
          {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      {copied && <div className="text-[10px] text-green-400 mt-0.5">{copiedLabel}</div>}
    </div>
  );
}

function osIcon(os: string | null) {
  switch ((os ?? '').toLowerCase()) {
    case 'ios':
    case 'android':
      return Smartphone;
    case 'ipados':
      return Tablet;
    default:
      return Monitor;
  }
}
