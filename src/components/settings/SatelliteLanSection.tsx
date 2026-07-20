import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Loader2, Trash2, Radio, X, Wifi } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  discoverOtherMothers, listPairedMothers, forgetPairedMother, joinMother,
  formatLanTime,
  type DiscoveredMother, type PairedMotherRow, type JoinHandle, type JoinOutcome,
} from '../../services/lanPairing';
import { useMotherConnection } from '../../services/motherConnection';
import { runAutoConnect, resolveConsent } from '../../services/wifiAutoConnect';
import { getStudioHotspots, type HotspotCreds } from '../../services/lanCredentials';
import { WifiAutoConnectPrompt } from '../WifiAutoConnectPrompt';
import { WifiQr } from './WifiQr';
import { HelpDot } from '../../help';

type Msg = { kind: 'ok' | 'err'; text: string };

export function SatelliteLanSection() {
  const { t } = useTranslation('devicesLan');
  const conn = useMotherConnection();

  const [paired, setPaired] = useState<PairedMotherRow[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredMother[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [joiningUuid, setJoiningUuid] = useState<string | null>(null);
  const [forgettingUuid, setForgettingUuid] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const joinRef = useRef<JoinHandle | null>(null);
  // Wi-Fi auto-connect: the first-time consent prompt + a busy flag while we
  // attempt the join. Reflected into `msg` on success/failure.
  const [consentSsid, setConsentSsid] = useState<string | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  // The studio-synced hotspot(s) this device should be ON to reach the mother.
  // Shown read-only here so the operator can see/scan the network to join.
  const [motherWifi, setMotherWifi] = useState<HotspotCreds[]>([]);

  const refreshPaired = useCallback(async () => {
    setPaired(await listPairedMothers().catch(() => []));
  }, []);

  const applyAutoResult = useCallback((r: Awaited<ReturnType<typeof runAutoConnect>>) => {
    if (r.kind === 'connected') setMsg({ kind: 'ok', text: t('autoConnected', { ssid: r.ssid }) });
    else if (r.kind === 'failed') setMsg({ kind: 'err', text: t('autoConnectFailed', { ssid: r.ssid }) });
    else if (r.kind === 'needs_consent') setConsentSsid(r.ssid);
  }, [t]);

  useEffect(() => {
    void refreshPaired();
    void getStudioHotspots().then(setMotherWifi).catch(() => setMotherWifi([]));
    // Join-context auto-connect: allowed to surface the one-time consent prompt.
    void runAutoConnect({ allowPrompt: true }).then(applyAutoResult).catch(() => {});
    return () => joinRef.current?.cancel();
  }, [refreshPaired, applyAutoResult]);

  const answerConsent = useCallback(async (consent: boolean) => {
    if (!consentSsid) return;
    setAutoBusy(true);
    try {
      const r = await resolveConsent(consentSsid, consent);
      if (r.kind === 'connected') { setMsg({ kind: 'ok', text: t('autoConnected', { ssid: r.ssid }) }); await refreshPaired(); }
      else if (r.kind === 'failed') setMsg({ kind: 'err', text: t('autoConnectFailed', { ssid: r.ssid }) });
    } finally {
      setAutoBusy(false);
      setConsentSsid(null);
    }
  }, [consentSsid, refreshPaired, t]);

  async function discover() {
    setDiscovering(true);
    setMsg(null);
    try {
      setDiscovered(await discoverOtherMothers(3000));
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || String(e) });
    } finally {
      setDiscovering(false);
    }
  }

  function labelOf(m: DiscoveredMother): string {
    return m.label || m.mother_uuid.slice(0, 8);
  }

  async function join(m: DiscoveredMother) {
    setJoiningUuid(m.mother_uuid);
    setMsg(null);
    const handle = joinMother(m);
    joinRef.current = handle;
    let outcome: JoinOutcome;
    try {
      outcome = await handle.result;
    } catch (e) {
      const message = (e as Error).message || String(e) || '-';
      setMsg({ kind: 'err', text: t('joinError', { message }) });
      setJoiningUuid(null);
      joinRef.current = null;
      return;
    }
    joinRef.current = null;
    setJoiningUuid(null);
    const label = labelOf(m);
    switch (outcome.kind) {
      case 'approved':
        setMsg({ kind: 'ok', text: t('joinApproved', { label }) });
        await refreshPaired();
        break;
      case 'denied':
        setMsg({ kind: 'err', text: t('joinDenied', { label }) });
        break;
      case 'already_paired':
        setMsg({ kind: 'err', text: t('joinAlreadyPaired', { label }) });
        break;
      case 'timeout':
        setMsg({ kind: 'err', text: t('joinTimeout', { label }) });
        break;
      case 'unreachable':
        setMsg({ kind: 'err', text: t('joinError', { message: outcome.message }) });
        break;
    }
  }

  function cancelJoin() {
    joinRef.current?.cancel();
    joinRef.current = null;
    setJoiningUuid(null);
  }

  async function forget(m: PairedMotherRow) {
    if (!window.confirm(t('forgetConfirm'))) return;
    setForgettingUuid(m.mother_uuid);
    try { await forgetPairedMother(m.mother_uuid); await refreshPaired(); }
    finally { setForgettingUuid(null); }
  }

  const connText =
    conn.kind === 'child_ok' ? t('statusConnected')
    : conn.kind === 'child_nearby' ? t('statusNearby')
    : t('statusOffline');
  const connOk = conn.kind === 'child_ok';

  return (
    <div className="space-y-6">
      {/* ── Mother's Wi-Fi (the network this device must be ON to reach the
          mother). Studio-defined, synced to every device; read-only here so the
          operator can verify/scan it. ── */}
      <div className="pg-panel">
        <div className="flex items-center gap-2 mb-1">
          <Wifi className="w-5 h-5 text-[var(--pg-accent-bright)]" />
          <h3 className="pg-panel-title">{t('motherWifiTitle')}</h3>
        </div>
        <p className="text-sm text-[var(--pg-text-dim)] mb-4">{t('motherWifiHint')}</p>
        {motherWifi.length === 0 ? (
          <div className="text-xs text-[var(--pg-text-dim)] bg-[var(--pg-bg)] border border-[var(--pg-line)] rounded-lg p-3">
            {t('noStudioHotspot')}
          </div>
        ) : (
          <div className="space-y-4">
            {motherWifi.map((h) => (
              <div key={h.ssid} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-xs text-[var(--pg-text-dim)]">{t('ssidLabel')}</div>
                  <div className="font-mono text-[var(--pg-text)] truncate">{h.ssid}</div>
                  <div className="text-xs text-[var(--pg-text-dim)] mt-2">{t('passwordLabel')}</div>
                  <div className="font-mono text-[var(--pg-text)] truncate">{h.password}</div>
                </div>
                <WifiQr ssid={h.ssid} password={h.password} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Currently paired mothers ── */}
      {paired.length > 0 && (
        <div>
          <h3 className="pg-panel-title mb-3">{t('currentMotherTitle')}</h3>
          <div className="space-y-2">
            {paired.map((m) => (
              <div key={m.mother_uuid} className="p-4 rounded-xl border bg-[var(--pg-surface)] border-[var(--pg-line)] flex items-center gap-4">
                <Radio className={`w-6 h-6 shrink-0 ${connOk ? 'text-green-400' : 'text-[var(--pg-text-dim)]'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--pg-text)] font-medium truncate">
                      {m.mother_label || m.mother_uuid.slice(0, 8)}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      connOk ? 'bg-green-500/20 text-green-300 border-green-500/40'
                             : 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)] border-[var(--pg-line-strong)]'}`}>
                      {connText}
                    </span>
                  </div>
                  {m.last_seen_at && (
                    <div className="text-xs text-[var(--pg-text-dim)] mt-1">
                      {t('lastSeen', { time: formatLanTime(m.last_seen_at) })}
                    </div>
                  )}
                </div>
                <button onClick={() => forget(m)} disabled={forgettingUuid === m.mother_uuid}
                  title={t('forget')}
                  className="p-2 rounded-lg text-red-300 hover:bg-red-500/20 disabled:opacity-50">
                  {forgettingUuid === m.mother_uuid ? <Loader2 className="w-5 h-5 animate-spin" /> : <Trash2 className="w-5 h-5" />}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Join a mother ── */}
      <div className="pg-panel">
        <div className="flex items-center gap-1.5">
          <h3 className="pg-panel-title">{t('satelliteTitle')}</h3>
          <HelpDot topic="devices.router-pairing" />
        </div>
        <p className="text-sm text-[var(--pg-text-dim)] mt-1 mb-4">{t('satelliteHint')}</p>

        {msg && (
          <div className={`mb-3 text-sm rounded-lg p-2 border ${
            msg.kind === 'ok' ? 'bg-green-500/15 border-green-500/40 text-green-300'
                              : 'bg-red-500/15 border-red-500/40 text-red-300'}`}>
            {msg.text}
          </div>
        )}

        <button onClick={discover} disabled={discovering || joiningUuid !== null}
          className="pg-btn">
          {discovering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          {discovering ? t('discovering') : t('discover')}
        </button>

        {discovered !== null && (
          <div className="mt-4 space-y-2">
            {discovered.length === 0 ? (
              <div className="text-sm rounded-lg p-3 bg-[var(--pg-bg)] border border-[var(--pg-line)] space-y-2">
                <div className="text-[var(--pg-text-dim)]">{t('discoverEmpty')}</div>
                <div className="text-xs text-[var(--pg-text-dim)] space-y-1">
                  <p className="font-medium text-[var(--pg-text-muted)]">{t('troubleshootTitle')}</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    <li>{t('troubleshootSameNetwork')}</li>
                    <li>{t('troubleshootIsolation')}</li>
                    <li>{t('troubleshootMotherOpen')}</li>
                  </ul>
                </div>
              </div>
            ) : (
              discovered.map((m) => {
                const joining = joiningUuid === m.mother_uuid;
                return (
                  <div key={m.mother_uuid} className="flex items-center gap-3 p-3 rounded-lg bg-[var(--pg-bg)] border border-[var(--pg-line)]">
                    <Radio className="w-5 h-5 text-[var(--pg-text-muted)] shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[var(--pg-text)] font-medium truncate">{labelOf(m)}</div>
                      <div className="text-xs text-[var(--pg-text-dim)] truncate">{m.addresses.join(', ')}:{m.port}</div>
                    </div>
                    {joining ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-[var(--pg-text-muted)] flex items-center gap-1">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          {t('waitingApproval', { label: labelOf(m) })}
                        </span>
                        <button onClick={cancelJoin} title={t('cancel')}
                          className="p-1.5 rounded-lg text-[var(--pg-text-dim)] hover:bg-[var(--pg-surface-3)]">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <button onClick={() => join(m)} disabled={joiningUuid !== null}
                        className="px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-500 text-sm disabled:opacity-50">
                        {t('join')}
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {consentSsid && (
        <WifiAutoConnectPrompt ssid={consentSsid} busy={autoBusy} onAnswer={answerConsent} />
      )}
    </div>
  );
}
