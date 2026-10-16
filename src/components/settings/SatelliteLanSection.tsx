import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Loader2, Radio, X, Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  discoverOtherMothers, listPairedMothers, joinMother, pairByAddress, speaksOurLanProto, LAN_PROTO,
  type DiscoveredMother, type PairedMotherRow, type JoinHandle, type JoinOutcome,
} from '../../services/lanPairing';
import { HelpDot } from '../../help';
import { checkForUpdateFromMother, type UpdateStatus } from '../../services/updateService';
import { DesktopUpdateInstaller } from '../update/UpdateProgress';

// Pairing by address probes these ports (lan_server.rs PREFERRED_PORTS).
const MOTHER_PORTS = [47800, 47801, 47802, 47803];

/** Base URLs to try for a mother typed as "a.b.c.d" or "a.b.c.d:port". */
function motherBasesFor(address: string): string[] {
  const a = address.trim();
  return /:\d+$/.test(a) ? [`http://${a}`] : MOTHER_PORTS.map((p) => `http://${a}:${p}`);
}

type Msg = { kind: 'ok' | 'err'; text: string };

export type SatellitePart = 'join' | 'byIp';

/** `parts`: which blocks to render (the Network page places them in separate
 *  rows of its Advanced section). Default: all. The "current mother" row lives
 *  in NetworkScreen's "Mon poste mère" card. The app no longer manages Wi-Fi:
 *  the PC joins the venue network through Windows, this only finds and pairs. */
export function SatelliteLanSection({ parts }: { parts?: SatellitePart[] } = {}) {
  const show = (p: SatellitePart) => !parts || parts.includes(p);
  const { t } = useTranslation('devicesLan');

  const [, setPaired] = useState<PairedMotherRow[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredMother[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [joiningUuid, setJoiningUuid] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const joinRef = useRef<JoinHandle | null>(null);
  const [ipAddr, setIpAddr] = useState('');
  const [ipBusy, setIpBusy] = useState(false);
  const [ipMsg, setIpMsg] = useState<Msg | null>(null);
  // A mother on a NEWER LAN protocol refused us: this device must be updated.
  // Its /update.php still answers (any protocol) - offer the update from it.
  const [outdatedBases, setOutdatedBases] = useState<{ part: SatellitePart; bases: string[] } | null>(null);
  const [motherUpdate, setMotherUpdate] = useState<UpdateStatus | null>(null);
  const [motherUpdateBusy, setMotherUpdateBusy] = useState(false);
  const [motherUpdateMsg, setMotherUpdateMsg] = useState<Msg | null>(null);

  const noteOutcome = (outcome: JoinOutcome, part: SatellitePart, bases: string[]) => {
    const selfOutdated = outcome.kind === 'proto_mismatch' && outcome.theirs > LAN_PROTO;
    setOutdatedBases(selfOutdated ? { part, bases } : null);
    setMotherUpdate(null);
    setMotherUpdateMsg(null);
  };

  async function checkMotherUpdate() {
    if (!outdatedBases) return;
    setMotherUpdateBusy(true);
    setMotherUpdateMsg(null);
    try {
      for (const base of outdatedBases.bases) {
        const status = await checkForUpdateFromMother(base);
        if (status.state === 'error') continue;
        if (status.state === 'up-to-date' || !status.canSelfUpdate) {
          setMotherUpdateMsg({ kind: 'err', text: t('updateFromMotherNone') });
        } else {
          setMotherUpdate(status);
        }
        return;
      }
      setMotherUpdateMsg({ kind: 'err', text: t('updateFromMotherUnreachable') });
    } finally {
      setMotherUpdateBusy(false);
    }
  }

  const refreshPaired = useCallback(async () => {
    setPaired(await listPairedMothers().catch(() => []));
  }, []);

  useEffect(() => {
    void refreshPaired();
    return () => joinRef.current?.cancel();
  }, [refreshPaired]);

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

  /** The operator-facing text for a pairing outcome. */
  function describeOutcome(outcome: JoinOutcome, label: string): Msg {
    switch (outcome.kind) {
      case 'approved':
        return { kind: 'ok', text: t('joinApproved', { label }) };
      case 'denied':
        return { kind: 'err', text: t('joinDenied', { label }) };
      case 'already_paired':
        return { kind: 'err', text: t('joinAlreadyPaired', { label }) };
      case 'timeout':
        return { kind: 'err', text: t('joinTimeout', { label }) };
      case 'proto_mismatch':
        return {
          kind: 'err',
          text:
            outcome.theirs < LAN_PROTO
              ? t('protoMotherOutdated', { label, version: outcome.their_app_version ?? '?' })
              : t('protoSelfOutdated', { version: outcome.their_app_version ?? '?' }),
        };
      case 'unreachable':
        // Discovery worked (we tapped a mother we could see) but the TCP connect
        // was refused/timed out: almost always the MOTHER's firewall.
        return { kind: 'err', text: t('joinUnreachableFirewall', { label }) };
    }
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
    setMsg(describeOutcome(outcome, labelOf(m)));
    noteOutcome(outcome, 'join', m.addresses.map((a) => `http://${a}:${m.port}`));
    if (outcome.kind === 'approved') await refreshPaired();
  }

  function cancelJoin() {
    joinRef.current?.cancel();
    joinRef.current = null;
    setJoiningUuid(null);
  }

  async function joinByIp() {
    const address = ipAddr.trim();
    if (!address) return;
    setIpBusy(true);
    setIpMsg(null);
    try {
      const outcome = await pairByAddress(address);
      noteOutcome(outcome, 'byIp', motherBasesFor(address));
      setIpMsg(
        outcome.kind === 'unreachable'
          ? { kind: 'err', text: t('byIpUnreachable', { address }) }
          : describeOutcome(outcome, address),
      );
      if (outcome.kind === 'approved' || outcome.kind === 'already_paired') await refreshPaired();
    } finally {
      setIpBusy(false);
    }
  }

  // Below a "update this device" refusal: fetch the update from that mother.
  const motherUpdateBlock = (part: SatellitePart) => outdatedBases?.part === part && (
    <div className="mb-3 space-y-3">
      {motherUpdate ? (
        <DesktopUpdateInstaller version={motherUpdate.latestVersion} source="mother" />
      ) : (
        <button onClick={checkMotherUpdate} disabled={motherUpdateBusy} className="pg-btn pg-btn--primary">
          {motherUpdateBusy && <Loader2 size={14} className="animate-spin" />}
          {t('updateFromMother')}
        </button>
      )}
      {motherUpdateMsg && (
        <div className="text-sm text-[var(--pg-danger-text)]">{motherUpdateMsg.text}</div>
      )}
    </div>
  );

  const msgBox = (m: Msg) => (
    <div className={`mb-3 text-sm rounded-lg p-2 border ${
      m.kind === 'ok' ? 'bg-[var(--pg-ok-bg)] border-[var(--pg-ok-line)] text-[var(--pg-ok-text)]'
                      : 'bg-[var(--pg-danger-bg)] border-[var(--pg-danger-line)] text-[var(--pg-danger-text)]'}`}>
      {m.text}
    </div>
  );

  return (
    <div className="space-y-6">
      {/* ── Join a mother found over mDNS ── */}
      {show('join') && (
      <div className="pg-panel">
        <div className="flex items-center gap-1.5">
          <h3 className="pg-panel-title">{t('satelliteTitle')}</h3>
          <HelpDot topic="devices.router-pairing" />
        </div>
        <p className="text-sm text-[var(--pg-text-dim)] mt-1 mb-4">{t('satelliteHint')}</p>

        {msg && msgBox(msg)}
        {motherUpdateBlock('join')}

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
                    <li>{t('troubleshootByIp')}</li>
                  </ul>
                </div>
              </div>
            ) : (
              discovered.map((m) => {
                const joining = joiningUuid === m.mother_uuid;
                const compatible = speaksOurLanProto(m);
                return (
                  <div key={m.mother_uuid} className="flex items-center gap-3 p-3 rounded-lg bg-[var(--pg-bg)] border border-[var(--pg-line)]">
                    <Radio className="w-5 h-5 text-[var(--pg-text-muted)] shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[var(--pg-text)] font-medium truncate">{labelOf(m)}</div>
                      <div className="text-xs text-[var(--pg-text-dim)] truncate">{m.addresses.join(', ')}:{m.port}</div>
                      {!compatible && (
                        <div className="text-xs text-[var(--pg-warn-text)] mt-0.5">
                          {m.lan_proto < LAN_PROTO ? t('protoBadgeMotherOutdated') : t('protoBadgeSelfOutdated')}
                        </div>
                      )}
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
                      <button onClick={() => join(m)} disabled={joiningUuid !== null || !compatible}
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

      {/* ── Pair by typed IP: the fallback when the network filters mDNS. ── */}
      {show('byIp') && (
      <div className="pg-panel">
        <div className="flex items-center gap-1.5">
          <h3 className="pg-panel-title">{t('byIpTitle')}</h3>
          <HelpDot topic="devices.router-pairing" />
        </div>
        <p className="text-sm text-[var(--pg-text-dim)] mt-1 mb-4">{t('byIpHint')}</p>
        {ipMsg && msgBox(ipMsg)}
        {motherUpdateBlock('byIp')}
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            inputMode="decimal"
            value={ipAddr}
            onChange={(e) => setIpAddr(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void joinByIp(); }}
            placeholder={t('byIpPlaceholder')}
            className="pg-input flex-1 font-mono"
          />
          <button onClick={() => void joinByIp()} disabled={ipBusy || !ipAddr.trim()} className="pg-btn pg-btn--primary">
            {ipBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
            {t('byIpConnect')}
          </button>
        </div>
      </div>
      )}
    </div>
  );
}
