import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Loader2, Trash2, Radio, X, Wifi, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  discoverOtherMothers, listPairedMothers, joinMother,
  type DiscoveredMother, type PairedMotherRow, type JoinHandle, type JoinOutcome,
} from '../../services/lanPairing';
import { runAutoConnect, resolveConsent } from '../../services/wifiAutoConnect';
import { isStuckOnApipa } from '../../services/wifi';
import {
  listJoinable, addManual, remove as removeNetwork,
  type WifiNetworkRow,
} from '../../services/wifiNetworksStore';
import { WifiAutoConnectPrompt } from '../WifiAutoConnectPrompt';
import { WifiQr } from './WifiQr';
import { StepByStepConnect } from './StepByStepConnect';
import { HelpDot } from '../../help';

type Msg = { kind: 'ok' | 'err'; text: string };

export type SatellitePart = 'wizard' | 'wifi' | 'join';

/** `parts`: which blocks to render (the rebuilt Network page places them in
 *  separate rows of its Advanced section). Default: all. The "current mother"
 *  row moved to MyMotherCard (retours sept. #7/#10). */
export function SatelliteLanSection({ parts }: { parts?: SatellitePart[] } = {}) {
  const show = (p: SatellitePart) => !parts || parts.includes(p);
  const { t } = useTranslation('devicesLan');

  const [, setPaired] = useState<PairedMotherRow[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredMother[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [joiningUuid, setJoiningUuid] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const joinRef = useRef<JoinHandle | null>(null);
  // Wi-Fi auto-connect: the first-time consent prompt + a busy flag while we
  // attempt the join. Reflected into `msg` on success/failure.
  const [consentSsid, setConsentSsid] = useState<string | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  // The network(s) this device can join to reach the mother: studio-synced
  // hotspots plus any the operator typed in by hand. Studio rows are read-only;
  // manual rows can be deleted.
  const [motherWifi, setMotherWifi] = useState<WifiNetworkRow[]>([]);
  // "Add a network" form (shown so a device whose creds never synced can still
  // be told which Wi-Fi to join).
  const [addSsid, setAddSsid] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  const refreshWifi = useCallback(async () => {
    setMotherWifi(await listJoinable().catch(() => []));
  }, []);

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
    void refreshWifi();
    // No auto-connect on open: the Step-by-step section drives connection by hand
    // (the operator runs each step). applyAutoResult is still used by the manual
    // "add a network" action below, which joins the network the operator just typed.
    return () => joinRef.current?.cancel();
  }, [refreshPaired, refreshWifi]);

  const addNetwork = useCallback(async () => {
    const ssid = addSsid.trim();
    const password = addPassword;
    if (!ssid || password.length < 8) return;
    setAddBusy(true);
    setMsg(null);
    try {
      await addManual(ssid, password);
      setAddSsid('');
      setAddPassword('');
      await refreshWifi();
      // Try to join it right away so the operator doesn't have to hunt for it in
      // the OS Wi-Fi list; the auto-connect engine picks up the freshly-added row.
      const r = await runAutoConnect({ allowPrompt: true });
      applyAutoResult(r);
    } finally {
      setAddBusy(false);
    }
  }, [addSsid, addPassword, refreshWifi, applyAutoResult]);

  const deleteNetwork = useCallback(async (ssid: string) => {
    await removeNetwork(ssid);
    await refreshWifi();
  }, [refreshWifi]);

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
    const handle = joinMother(m, { manual: true });
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
      case 'unreachable': {
        // Discovery worked (we tapped a mother we could see) but the TCP connect
        // was refused/timed out. Diagnose the usual cause instead of dumping the
        // raw "error sending request" string: a child stuck on APIPA can't route
        // to the mother's subnet; otherwise it's almost always the MOTHER's
        // firewall blocking inbound connections.
        const apipa = await isStuckOnApipa().catch(() => false);
        setMsg({
          kind: 'err',
          text: apipa
            ? t('joinUnreachableSubnet', { label })
            : t('joinUnreachableFirewall', { label }),
        });
        break;
      }
    }
  }

  function cancelJoin() {
    joinRef.current?.cancel();
    joinRef.current = null;
    setJoiningUuid(null);
  }

  return (
    <div className="space-y-6">
      {/* ── Step-by-step manual connection (connect → search → ping). The primary,
          hand-driven path to reach a mother; nothing here fires automatically. ── */}
      {show('wizard') && <StepByStepConnect />}

      {/* ── Mother's Wi-Fi (the network this device must be ON to reach the
          mother). Studio-defined, synced to every device; read-only here so the
          operator can verify/scan it. ── */}
      {show('wifi') && (
      <div className="pg-panel">
        <div className="flex items-center gap-2 mb-1">
          <Wifi className="w-5 h-5 text-[var(--pg-accent-bright)]" />
          <h3 className="pg-panel-title">{t('motherWifiTitle')}</h3>
        </div>
        <p className="text-sm text-[var(--pg-text-dim)] mb-4">{t('motherWifiHint')}</p>
        {motherWifi.length === 0 ? (
          <div className="text-xs text-[var(--pg-text-dim)] bg-[var(--pg-bg)] border border-[var(--pg-line)] rounded-lg p-3">
            {t('noStudioHotspotAdd')}
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
                  {h.origin === 'manual' && (
                    <div className="text-[10px] uppercase tracking-wide text-[var(--pg-text-dim)] mt-1">
                      {t('manualBadge')}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <WifiQr ssid={h.ssid} password={h.password} />
                  {h.origin === 'manual' && (
                    <button onClick={() => void deleteNetwork(h.ssid)} title={t('removeNetwork')}
                      className="p-2 rounded-lg text-[var(--pg-danger-text)] hover:bg-red-500/20">
                      <Trash2 className="w-5 h-5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Add a network by hand (studio creds not synced, or a different
            venue Wi-Fi). Saved locally, auto-consented so the device joins it. ── */}
        <div className="mt-4 pt-4 border-t border-[var(--pg-line)]">
          <div className="text-xs text-[var(--pg-text-dim)] mb-2">{t('addNetworkTitle')}</div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={addSsid}
              onChange={(e) => setAddSsid(e.target.value)}
              placeholder={t('ssidLabel')}
              className="pg-input flex-1"
            />
            <input
              type="text"
              value={addPassword}
              onChange={(e) => setAddPassword(e.target.value)}
              placeholder={t('passwordLabel')}
              className="pg-input flex-1"
            />
            <button
              onClick={() => void addNetwork()}
              disabled={addBusy || !addSsid.trim() || addPassword.length < 8}
              className="pg-btn"
            >
              {addBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {t('addNetwork')}
            </button>
          </div>
          <div className="text-[11px] text-[var(--pg-text-dim)] mt-1">{t('addNetworkHint')}</div>
        </div>
      </div>
      )}

      {/* ── Join a mother ── */}
      {show('join') && (
      <div className="pg-panel">
        <div className="flex items-center gap-1.5">
          <h3 className="pg-panel-title">{t('satelliteTitle')}</h3>
          <HelpDot topic="devices.router-pairing" />
        </div>
        <p className="text-sm text-[var(--pg-text-dim)] mt-1 mb-4">{t('satelliteHint')}</p>

        {msg && (
          <div className={`mb-3 text-sm rounded-lg p-2 border ${
            msg.kind === 'ok' ? 'bg-[var(--pg-ok-bg)] border-[var(--pg-ok-line)] text-[var(--pg-ok-text)]'
                              : 'bg-[var(--pg-danger-bg)] border-[var(--pg-danger-line)] text-[var(--pg-danger-text)]'}`}>
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

      )}

      {/* Firewall panel lives in the Network page Advanced section (NetworkScreen). */}

      {consentSsid && (
        <WifiAutoConnectPrompt ssid={consentSsid} busy={autoBusy} onAnswer={answerConsent} />
      )}
    </div>
  );
}
