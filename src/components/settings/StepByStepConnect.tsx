import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2, Wifi, Search, Radio, CheckCircle2, AlertTriangle, Circle,
  Copy, Check, Pin, PlugZap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { connectWifi, getCurrentSsid, localIpv4s, assignStaticIp } from '../../services/wifi';
import { listConnectable, markConnected, type WifiNetworkRow } from '../../services/wifiNetworksStore';
import {
  discoverOtherMothers, probeMother, joinMother,
  type DiscoveredMother, type MotherProbe, type JoinHandle, type JoinOutcome,
} from '../../services/lanPairing';
import { useLocalRole } from '../../services/motherConnection';

// Manual, hand-driven "connect to the mother" flow for a child device. NOTHING
// happens automatically: the operator runs each step and gets a detailed message
// on failure. The three steps mirror the three things that can independently go
// wrong: (1) joining the Wi-Fi, (2) discovering the mother over mDNS, and (3) the
// actual TCP reachability (the "sees it but can't connect" firewall case).

type Phase = 'idle' | 'busy' | 'ok' | 'warn' | 'err';
type StepMsg = { phase: Phase; detail?: string; ip?: string };
type ProbeMsg = { phase: Phase; probe?: MotherProbe };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Poll for association + a real (non-APIPA) lease after issuing a connect. netsh
// `connect` returns as soon as the request is queued, so we confirm the outcome
// ourselves rather than trusting the exit code.
//
// The SUCCESS signal is IP-based, not SSID-based: a 192.168.137.x lease proves
// we're on the mother's hotspot subnet regardless of what `netsh wlan show
// interfaces` reports (its SSID line lags/misses for a second right after a
// fresh association, which used to make a genuinely-connected device read as
// "not connected"). The SSID string is only a secondary confirmation (router
// mode, where the subnet isn't 192.168.137.x).
async function waitForLease(
  ssid: string,
): Promise<{ kind: 'ok' | 'apipa' | 'wrong_ssid' | 'no_assoc'; ip?: string; current?: string | null }> {
  const deadline = Date.now() + 20000; // ICS DHCP on a first association can be slow
  const hotspotIp = (ips: string[]) => ips.find((ip) => ip.startsWith('192.168.137.'));
  const goodIp = (ips: string[]) => ips.find((ip) => !ip.startsWith('169.254.') && !ip.startsWith('127.'));
  let current: string | null = null;
  let ips: string[] = [];
  while (Date.now() < deadline) {
    await sleep(900);
    current = await getCurrentSsid().catch(() => null);
    ips = await localIpv4s().catch(() => []);
    if (hotspotIp(ips)) return { kind: 'ok', ip: hotspotIp(ips) };
    if (current === ssid && goodIp(ips)) return { kind: 'ok', ip: goodIp(ips) };
  }
  // Window elapsed - classify what we ended up with.
  if (hotspotIp(ips)) return { kind: 'ok', ip: hotspotIp(ips) };
  if (current === ssid && goodIp(ips)) return { kind: 'ok', ip: goodIp(ips) };
  const apipa = ips.find((ip) => ip.startsWith('169.254.'));
  // Associated to the target but no usable lease yet (APIPA or still negotiating):
  // actionable warning (force a fixed IP / retry), not a hard failure.
  if (current === ssid) return { kind: 'apipa', ip: apipa };
  if (current && current !== ssid) return { kind: 'wrong_ssid', current };
  // SSID unreadable but we DID pick up an APIPA address, so we associated to *a*
  // network (almost certainly the hotspot) and just never got a lease.
  if (apipa) return { kind: 'apipa', ip: apipa };
  return { kind: 'no_assoc' };
}

export function StepByStepConnect() {
  const { t } = useTranslation('devicesLan');
  // A child that is ALSO hosting its own Wi-Fi hotspot owns 192.168.137.1 on its
  // hosted adapter - the exact subnet the mother's hotspot uses. That collision
  // breaks the child's DHCP lease (→ APIPA) and its route to the mother (packets
  // to 192.168.137.1 go to its own adapter). Surface it before Step 1.
  const role = useLocalRole();

  const [creds, setCreds] = useState<WifiNetworkRow[]>([]);
  const [sel, setSel] = useState(0);
  const [copied, setCopied] = useState(false);

  const [step1, setStep1] = useState<StepMsg>({ phase: 'idle' });
  const [staticBusy, setStaticBusy] = useState(false);

  const [step2, setStep2] = useState<StepMsg>({ phase: 'idle' });
  const [discovered, setDiscovered] = useState<DiscoveredMother[] | null>(null);

  const [probes, setProbes] = useState<Record<string, ProbeMsg>>({});
  const [joiningUuid, setJoiningUuid] = useState<string | null>(null);
  const [joinMsg, setJoinMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const joinRef = useRef<JoinHandle | null>(null);

  useEffect(() => {
    void listConnectable().then((rows) => setCreds(rows)).catch(() => setCreds([]));
    return () => joinRef.current?.cancel();
  }, []);

  const target = creds[sel] ?? null;

  const copyPw = useCallback(async () => {
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }, [target]);

  // ── Step 1: connect to the hotspot ──────────────────────────────────────────
  const doConnect = useCallback(async () => {
    if (!target) return;
    setStep1({ phase: 'busy' });
    // Reset everything downstream so a stale "found"/"reachable" can't linger.
    setStep2({ phase: 'idle' });
    setDiscovered(null);
    setProbes({});
    setJoinMsg(null);
    try {
      await connectWifi(target.ssid, target.password);
    } catch (e) {
      setStep1({ phase: 'err', detail: t('stepConnectFailed', { message: (e as Error).message || String(e) }) });
      return;
    }
    const res = await waitForLease(target.ssid);
    if (res.kind === 'ok') {
      await markConnected(target.ssid).catch(() => {});
      setStep1({ phase: 'ok', ip: res.ip });
    } else if (res.kind === 'apipa') {
      setStep1({ phase: 'warn', ip: res.ip });
    } else if (res.kind === 'wrong_ssid') {
      setStep1({ phase: 'err', detail: t('stepConnectWrongSsid', { current: res.current ?? '—', target: target.ssid }) });
    } else {
      setStep1({ phase: 'err', detail: t('stepConnectNoAssoc', { ssid: target.ssid }) });
    }
  }, [target, t]);

  const forceStaticIp = useCallback(async () => {
    setStaticBusy(true);
    try {
      const ip = await assignStaticIp('192.168.137.1');
      setStep1({ phase: 'ok', ip });
    } catch (e) {
      setStep1((s) => ({ ...s, detail: t('stepForceIpFailed', { message: (e as Error).message || String(e) }) }));
    } finally {
      setStaticBusy(false);
    }
  }, [t]);

  // ── Step 2: find the mother ─────────────────────────────────────────────────
  const doSearch = useCallback(async () => {
    setStep2({ phase: 'busy' });
    setDiscovered(null);
    setProbes({});
    setJoinMsg(null);
    try {
      const found = await discoverOtherMothers(3500);
      setDiscovered(found);
      setStep2({ phase: found.length > 0 ? 'ok' : 'err' });
    } catch (e) {
      setDiscovered([]);
      setStep2({ phase: 'err', detail: (e as Error).message || String(e) });
    }
  }, []);

  // ── Step 3: ping (reachability probe) ───────────────────────────────────────
  const doPing = useCallback(async (m: DiscoveredMother) => {
    setProbes((p) => ({ ...p, [m.mother_uuid]: { phase: 'busy' } }));
    const r = await probeMother(m.addresses, m.port).catch(() => null);
    setProbes((p) => ({
      ...p,
      [m.mother_uuid]: r?.ok ? { phase: 'ok', probe: r } : { phase: 'err', probe: r ?? undefined },
    }));
  }, []);

  const labelOf = (m: DiscoveredMother) => m.label || m.mother_uuid.slice(0, 8);

  const doJoin = useCallback(async (m: DiscoveredMother) => {
    setJoiningUuid(m.mother_uuid);
    setJoinMsg(null);
    const handle = joinMother(m);
    joinRef.current = handle;
    let outcome: JoinOutcome;
    try {
      outcome = await handle.result;
    } catch (e) {
      setJoinMsg({ kind: 'err', text: t('joinError', { message: (e as Error).message || String(e) }) });
      setJoiningUuid(null);
      joinRef.current = null;
      return;
    }
    joinRef.current = null;
    setJoiningUuid(null);
    const label = labelOf(m);
    switch (outcome.kind) {
      case 'approved': setJoinMsg({ kind: 'ok', text: t('joinApproved', { label }) }); break;
      case 'denied': setJoinMsg({ kind: 'err', text: t('joinDenied', { label }) }); break;
      case 'already_paired': setJoinMsg({ kind: 'ok', text: t('joinAlreadyPaired', { label }) }); break;
      case 'timeout': setJoinMsg({ kind: 'err', text: t('joinTimeout', { label }) }); break;
      case 'unreachable': setJoinMsg({ kind: 'err', text: t('joinUnreachableFirewall', { label }) }); break;
    }
  }, [t]);

  const step1Done = step1.phase === 'ok' || step1.phase === 'warn';

  const stepIcon = (phase: Phase) => {
    if (phase === 'busy') return <Loader2 className="w-5 h-5 animate-spin text-[var(--pg-accent-bright)]" />;
    if (phase === 'ok') return <CheckCircle2 className="w-5 h-5 text-green-400" />;
    if (phase === 'warn') return <AlertTriangle className="w-5 h-5 text-amber-400" />;
    if (phase === 'err') return <AlertTriangle className="w-5 h-5 text-red-400" />;
    return <Circle className="w-5 h-5 text-[var(--pg-text-dim)]" />;
  };

  const noteBox = (phase: 'ok' | 'warn' | 'err', node: React.ReactNode) => {
    const cls =
      phase === 'ok' ? 'bg-green-500/15 border-green-500/40 text-green-200'
      : phase === 'warn' ? 'bg-amber-500/15 border-amber-500/40 text-amber-200'
      : 'bg-red-500/15 border-red-500/40 text-red-300';
    return <div className={`mt-3 text-sm rounded-lg p-2 border ${cls}`}>{node}</div>;
  };

  const discoveredList = useMemo(() => discovered ?? [], [discovered]);

  return (
    <div className="pg-panel">
      <div className="flex items-center gap-2 mb-1">
        <PlugZap className="w-5 h-5 text-[var(--pg-accent-bright)]" />
        <h3 className="pg-panel-title">{t('stepTitle')}</h3>
      </div>
      <p className="text-sm text-[var(--pg-text-dim)] mb-4">{t('stepIntro')}</p>

      {role?.isHotspot && (
        <div className="mb-4 text-sm rounded-lg p-3 border bg-amber-500/15 border-amber-500/40 text-amber-200 flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <span>{t('stepSelfHotspotWarn')}</span>
        </div>
      )}

      {/* ── Step 1 ── */}
      <div className="rounded-xl border border-[var(--pg-line)] bg-[var(--pg-bg)] p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5">{stepIcon(step1.phase)}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 font-medium text-[var(--pg-text)]">
              <Wifi className="w-4 h-4 text-[var(--pg-text-muted)]" /> {t('step1Title')}
            </div>
            <p className="text-xs text-[var(--pg-text-dim)] mt-0.5">{t('step1Body')}</p>

            {creds.length === 0 ? (
              <div className="mt-3 text-sm rounded-lg p-2 border bg-[var(--pg-surface)] border-[var(--pg-line)] text-[var(--pg-text-dim)]">
                {t('stepNoCreds')}
              </div>
            ) : (
              <>
                {creds.length > 1 && (
                  <select
                    value={sel}
                    onChange={(e) => setSel(Number(e.target.value))}
                    className="pg-input mt-3 w-full"
                  >
                    {creds.map((c, i) => (
                      <option key={c.ssid} value={i}>{c.ssid}</option>
                    ))}
                  </select>
                )}
                <button onClick={() => void doConnect()} disabled={step1.phase === 'busy' || !target} className="pg-btn mt-3">
                  {step1.phase === 'busy' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
                  {step1Done ? t('stepReconnectBtn') : t('stepConnectBtn')}
                </button>

                {/* Credentials from the database, shown under the button. */}
                {target && (
                  <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm bg-[var(--pg-surface)] border border-[var(--pg-line)] rounded-lg p-2">
                    <span className="text-[var(--pg-text-dim)]">{t('ssidLabel')}</span>
                    <span className="font-mono text-[var(--pg-text)] truncate">{target.ssid}</span>
                    <span className="text-[var(--pg-text-dim)]">{t('passwordLabel')}</span>
                    <span className="font-mono text-[var(--pg-text)] truncate flex items-center gap-2">
                      {target.password}
                      <button onClick={() => void copyPw()} title={t('copy')}
                        className="p-1 rounded text-[var(--pg-text-dim)] hover:bg-[var(--pg-surface-3)]">
                        {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </span>
                  </div>
                )}
              </>
            )}

            {step1.phase === 'ok' && noteBox('ok', t('stepConnectedOk', { ssid: target?.ssid ?? '', ip: step1.ip ?? '' }))}
            {step1.phase === 'warn' && noteBox('warn', (
              <div className="space-y-2">
                <div>{t('stepConnectApipa', { ssid: target?.ssid ?? '', ip: step1.ip ?? '—' })}</div>
                <button onClick={() => void forceStaticIp()} disabled={staticBusy} className="pg-btn">
                  {staticBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Pin className="w-4 h-4" />}
                  {t('stepForceIpBtn')}
                </button>
                {step1.detail && <div className="text-red-300">{step1.detail}</div>}
              </div>
            ))}
            {step1.phase === 'err' && noteBox('err', step1.detail)}
          </div>
        </div>
      </div>

      {/* ── Step 2 ── */}
      <div className={`rounded-xl border border-[var(--pg-line)] bg-[var(--pg-bg)] p-4 mt-3 ${step1Done ? '' : 'opacity-50'}`}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5">{stepIcon(step2.phase)}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 font-medium text-[var(--pg-text)]">
              <Search className="w-4 h-4 text-[var(--pg-text-muted)]" /> {t('step2Title')}
            </div>
            <p className="text-xs text-[var(--pg-text-dim)] mt-0.5">{t('step2Body')}</p>

            <button onClick={() => void doSearch()} disabled={!step1Done || step2.phase === 'busy'} className="pg-btn mt-3">
              {step2.phase === 'busy' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              {discovered !== null ? t('stepSearchAgainBtn') : t('stepSearchBtn')}
            </button>
            {!step1Done && <p className="text-xs text-[var(--pg-text-dim)] mt-2">{t('step2Locked')}</p>}

            {step2.phase === 'ok' && discoveredList.length > 0 &&
              noteBox('ok', t('stepSearchFound', { count: discoveredList.length }))}
            {step2.phase === 'err' && discovered !== null && discoveredList.length === 0 && noteBox('err', (
              <div className="space-y-1">
                <div className="font-medium">{t('stepSearchNone')}</div>
                <ul className="list-disc pl-4 space-y-0.5 text-red-200/90">
                  <li>{t('stepSearchNoneHint1')}</li>
                  <li>{t('stepSearchNoneHint2')}</li>
                  <li>{t('stepSearchNoneHint3')}</li>
                </ul>
              </div>
            ))}
            {step2.phase === 'err' && step2.detail && noteBox('err', step2.detail)}
          </div>
        </div>
      </div>

      {/* ── Step 3 ── */}
      <div className={`rounded-xl border border-[var(--pg-line)] bg-[var(--pg-bg)] p-4 mt-3 ${discoveredList.length > 0 ? '' : 'opacity-50'}`}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5">{stepIcon(
            discoveredList.some((m) => probes[m.mother_uuid]?.phase === 'ok') ? 'ok'
            : discoveredList.some((m) => probes[m.mother_uuid]?.phase === 'err') ? 'err'
            : discoveredList.some((m) => probes[m.mother_uuid]?.phase === 'busy') ? 'busy'
            : 'idle',
          )}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 font-medium text-[var(--pg-text)]">
              <Radio className="w-4 h-4 text-[var(--pg-text-muted)]" /> {t('step3Title')}
            </div>
            <p className="text-xs text-[var(--pg-text-dim)] mt-0.5">{t('step3Body')}</p>

            {discoveredList.length === 0 ? (
              <p className="text-xs text-[var(--pg-text-dim)] mt-3">{t('step3Locked')}</p>
            ) : (
              <div className="mt-3 space-y-2">
                {discoveredList.map((m) => {
                  const pr = probes[m.mother_uuid];
                  const joining = joiningUuid === m.mother_uuid;
                  return (
                    <div key={m.mother_uuid} className="rounded-lg border border-[var(--pg-line)] bg-[var(--pg-surface)] p-3">
                      <div className="flex items-center gap-3">
                        <Radio className="w-5 h-5 text-[var(--pg-text-muted)] shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-[var(--pg-text)] font-medium truncate">{labelOf(m)}</div>
                          <div className="text-xs text-[var(--pg-text-dim)] truncate">{m.addresses.join(', ')}:{m.port}</div>
                        </div>
                        <button onClick={() => void doPing(m)} disabled={pr?.phase === 'busy' || joining}
                          className="pg-btn shrink-0">
                          {pr?.phase === 'busy' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radio className="w-4 h-4" />}
                          {t('stepPingBtn')}
                        </button>
                      </div>

                      {pr?.phase === 'ok' && (
                        <div className="mt-2 text-sm rounded-lg p-2 border bg-green-500/15 border-green-500/40 text-green-200 space-y-2">
                          <div>{t('stepPingOk', { addr: pr.probe?.reached_addr ?? '', ms: pr.probe?.latency_ms ?? '?' })}</div>
                          {joining ? (
                            <span className="text-xs text-green-200/80 flex items-center gap-1">
                              <Loader2 className="w-4 h-4 animate-spin" /> {t('waitingApproval', { label: labelOf(m) })}
                            </span>
                          ) : (
                            <button onClick={() => void doJoin(m)} disabled={joiningUuid !== null}
                              className="px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-500 text-sm disabled:opacity-50">
                              {t('stepJoinBtn')}
                            </button>
                          )}
                        </div>
                      )}
                      {pr?.phase === 'err' && (
                        <div className="mt-2 text-sm rounded-lg p-2 border bg-red-500/15 border-red-500/40 text-red-300 space-y-1">
                          <div>{t(
                            pr.probe?.category === 'refused' ? 'stepPingFailRefused'
                            : pr.probe?.category === 'unreachable' ? 'stepPingFailUnreachable'
                            : pr.probe?.category === 'timeout' ? 'stepPingFailFirewall'
                            : 'stepPingFailGeneric',
                          )}</div>
                          {pr.probe && pr.probe.errors.length > 0 && (
                            <div className="text-xs font-mono text-red-200/80">
                              {t('stepPingFailDetail', { detail: pr.probe.errors.join(' · ') })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {joinMsg && (
              <div className={`mt-3 text-sm rounded-lg p-2 border ${
                joinMsg.kind === 'ok' ? 'bg-green-500/15 border-green-500/40 text-green-300'
                                      : 'bg-red-500/15 border-red-500/40 text-red-300'}`}>
                {joinMsg.text}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
