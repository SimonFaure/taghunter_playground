// Settings → Réseau, rebuilt around the device's ROLE (retours sept. #10).
//
// The old page showed everything at once (host/join tabs, roles explainer,
// hotspot button on satellites, a "connected mothers" history...), and it was
// where every mistake of the 25 Sept failover morning happened. Now:
//   1. one status card: what this device is, whether it works, ONE action;
//   2. satellite → "Mon poste mère"; mother → "Wi-Fi Tag Hunter" + "Mes satellites";
//   3. everything else folded under "Avancé" (collapsed by default), with the
//      role-changing actions grouped at the bottom, in red, behind confirmations.
// The panels inside Avancé are the existing ones - only the layout changed.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, CheckCircle, ChevronDown, ChevronRight, Loader2, Monitor, Search, Wifi,
} from 'lucide-react';
import { useLocalRole, useMotherConnection } from '../../services/motherConnection';
import { onMotherReachState, type ReachState } from '../../services/motherFailover';
import { rejoinCurrentMother } from '../../services/childControlLink';
import { raiseMotherHotspotIfConfigured } from '../../services/lanMotherBoot';
import {
  hotspotStatus, listPairedDevices, listPairedMothers, isRecent, formatLanTime, displayDeviceLabel,
  type PairedMotherRow,
} from '../../services/lanPairing';
import { getNetworkSource, getRouterCreds, type NetworkSource } from '../../services/lanCredentials';
import { getCurrentSsid } from '../../services/wifi';
import { parseDbTs } from '../../utils/dbTime';
import { MotherLanSection } from './MotherLanSection';
import { SatelliteLanSection } from './SatelliteLanSection';
import { PairedDevicesPanel } from './PairedDevicesPanel';
import { LanDiagnostics } from './LanDiagnostics';
import { FirewallPanel } from './FirewallPanel';
import { ForceMotherPanel } from './ForceMotherPanel';
import { RejoinMotherPanel } from './RejoinMotherPanel';
import { NotMotherPanel } from './NotMotherPanel';
import { DefaultRolesPanel } from './DefaultRolesPanel';
import { WindowsHealthPanel } from './WindowsHealthPanel';

type RowKey =
  | 'role' | 'mode' | 'wifi' | 'join' | 'firewall' | 'windows' | 'diagnostic'
  | 'rejoin' | 'resume' | 'notMother';

const POLL_MS = 5000;

/** The mother this satellite talks to: the most recently heard-from paired row. */
function useCurrentMother(): PairedMotherRow | null {
  const [row, setRow] = useState<PairedMotherRow | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const rows = await listPairedMothers().catch(() => [] as PairedMotherRow[]);
      if (cancelled) return;
      const best = [...rows].sort(
        (a, b) => (parseDbTs(b.last_seen_at) || 0) - (parseDbTs(a.last_seen_at) || 0),
      )[0];
      setRow(best ?? null);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return row;
}

function secondsSince(ts: string | null | undefined): number | null {
  const t = parseDbTs(ts);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 1000));
}

export function NetworkScreen() {
  const { t } = useTranslation('devicesLan');
  const role = useLocalRole();
  const conn = useMotherConnection();
  const mother = useCurrentMother();
  const [reach, setReach] = useState<ReachState>('ok');
  const [advOpen, setAdvOpen] = useState(false);
  const [openRow, setOpenRow] = useState<RowKey | null>(null);
  const [source, setSource] = useState<NetworkSource>('hotspot');
  const [ssid, setSsid] = useState<string | null>(null);
  const [apRunning, setApRunning] = useState<boolean | null>(null);
  const [satellitesOnline, setSatellitesOnline] = useState(0);
  const [busy, setBusy] = useState(false);
  const [searchResult, setSearchResult] = useState<'not_found' | null>(null);

  useEffect(() => onMotherReachState(setReach), []);

  const isMother = !!role && (role.isMother || role.isHotspot);

  const refresh = useCallback(async () => {
    const src = await getNetworkSource().catch(() => 'hotspot' as NetworkSource);
    setSource(src);
    if (isMother) {
      const [st, devices, router] = await Promise.all([
        hotspotStatus().catch(() => null),
        listPairedDevices().catch(() => []),
        getRouterCreds().catch(() => null),
      ]);
      setApRunning(st?.running ?? null);
      setSsid(src === 'router' ? router?.ssid ?? null : st?.ssid ?? null);
      setSatellitesOnline(devices.filter((d) => !d.is_self && isRecent(d.last_seen_at)).length);
    } else {
      setSsid(await getCurrentSsid());
    }
  }, [isMother]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const openAdvanced = (row: RowKey) => {
    setAdvOpen(true);
    setOpenRow(row);
    setTimeout(() => document.getElementById(`net-row-${row}`)?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  const searchMother = async () => {
    setBusy(true);
    setSearchResult(null);
    try {
      const outcome = await rejoinCurrentMother();
      if (outcome === 'not_found') setSearchResult('not_found');
    } finally {
      setBusy(false);
    }
  };

  const startAp = async () => {
    setBusy(true);
    try {
      await raiseMotherHotspotIfConfigured();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (role === null) {
    return (
      <div className="container mx-auto px-6 py-8 max-w-3xl flex items-center gap-2 text-[var(--pg-text-dim)]">
        <Loader2 className="w-5 h-5 animate-spin" />
        {t('roleLoading')}
      </div>
    );
  }

  // ── status card content ──
  const motherName = mother?.mother_label || (conn.kind === 'child_ok' ? conn.motherLabel : null) || t('statusUnnamedMother');
  const motherLastSec = secondsSince(mother?.last_seen_at);
  let tone: 'ok' | 'warn' | 'busy';
  let title: string;
  let body: ReactNode;
  let action: ReactNode = null;
  if (isMother) {
    const apDown = source === 'hotspot' && apRunning === false;
    tone = apDown ? 'warn' : 'ok';
    title = apDown ? t('statusMotherApDownTitle') : t('statusAllGood');
    body = apDown
      ? t('statusMotherApDownBody')
      : t(source === 'router' ? 'statusMotherRouterBody' : 'statusMotherBody', {
          ssid: ssid ?? '-',
          count: satellitesOnline,
        });
    if (apDown) {
      action = (
        <button className="pg-btn pg-btn--primary" disabled={busy} onClick={() => void startAp()}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
          {t('statusStartAp')}
        </button>
      );
    }
  } else if (reach === 'reconnecting') {
    tone = 'busy';
    title = t('statusReconnectingTitle');
    body = t('statusReconnectingBody');
  } else if (conn.kind === 'child_ok') {
    tone = 'ok';
    title = t('statusAllGood');
    body = (
      <>
        {t('statusSatelliteBody', { mother: motherName, ssid: ssid ?? conn.ssid ?? '-' })}
        {motherLastSec != null && (
          <span className="block text-xs text-[var(--pg-text-dim)] mt-1">
            {t('statusLastExchange', { seconds: motherLastSec })}
          </span>
        )}
      </>
    );
  } else {
    tone = 'warn';
    title = t('statusNoMotherTitle');
    body = ssid ? t('statusNoMotherOnWifi', { ssid }) : t('statusNoMotherNoWifi');
    action = (
      <div className="flex flex-wrap items-center gap-3">
        <button className="pg-btn pg-btn--primary" disabled={busy} onClick={() => void searchMother()}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          {t('statusSearchMother')}
        </button>
        <button className="text-sm font-semibold text-[var(--pg-accent-bright)] hover:underline" onClick={() => openAdvanced('diagnostic')}>
          {t('statusDiagnosticLink')}
        </button>
      </div>
    );
  }

  const toneCls =
    tone === 'ok'
      ? 'border-[var(--pg-ok-line)] bg-[var(--pg-ok-bg)]'
      : tone === 'busy'
        ? 'border-amber-500/40 bg-amber-500/10'
        : 'border-[var(--pg-warn-line)] bg-[var(--pg-warn-bg)]';
  const icon =
    tone === 'ok' ? <CheckCircle className="w-7 h-7 text-[var(--pg-ok-icon)]" />
    : tone === 'busy' ? <Loader2 className="w-7 h-7 text-amber-400 animate-spin" />
    : <AlertTriangle className="w-7 h-7 text-[var(--pg-warn-icon)]" />;

  // Taking over a game is offered only once the mother has been gone a while
  // (the #22 "lost" state) - not during the first minute of a reconnection.
  const offerResume = !isMother && (reach === 'lost' || (conn.kind !== 'child_ok' && reach !== 'reconnecting'));

  const rows: Array<{ key: RowKey; title: string; hint: string; body: ReactNode; danger?: boolean; hidden?: boolean }> = [
    { key: 'role', title: t('advRoleTitle'), hint: isMother ? t('advRoleHintMother') : t('advRoleHintSatellite'), body: <DefaultRolesPanel /> },
    { key: 'mode', title: t('advModeTitle'), hint: t('advModeHint'), body: <MotherLanSection />, hidden: isMother },
    { key: 'wifi', title: t('advWifiTitle'), hint: t('advWifiHint'), body: <SatelliteLanSection parts={['wifi']} />, hidden: isMother },
    { key: 'join', title: t('advJoinTitle'), hint: t('advJoinHint'), body: <SatelliteLanSection parts={['join']} />, hidden: isMother },
    { key: 'firewall', title: t('advFirewallTitle'), hint: t('advFirewallHint'), body: <FirewallPanel hintKey={isMother ? 'firewallHint' : 'firewallHintChild'} /> },
    { key: 'windows', title: t('winHealthTitle'), hint: t('advWindowsHint'), body: <WindowsHealthPanel />, hidden: !isMother },
    {
      key: 'diagnostic', title: t('advDiagTitle'), hint: t('advDiagHint'),
      body: (
        <div className="space-y-5">
          {!isMother && <SatelliteLanSection parts={['wizard']} />}
          <LanDiagnostics />
        </div>
      ),
    },
    { key: 'rejoin', title: t('advRejoinTitle'), hint: t('advRejoinHint'), body: <RejoinMotherPanel />, hidden: isMother },
    { key: 'resume', title: t('advResumeTitle'), hint: t('advResumeHint'), body: <ForceMotherPanel />, danger: true, hidden: !offerResume },
    { key: 'notMother', title: t('notMotherTitle'), hint: t('advNotMotherHint'), body: <NotMotherPanel />, danger: true, hidden: !isMother },
  ];
  const visible = rows.filter((r) => !r.hidden);
  const safeRows = visible.filter((r) => !r.danger);
  const dangerRows = visible.filter((r) => r.danger);

  const renderRow = (r: (typeof rows)[number]) => {
    const open = openRow === r.key;
    return (
      <div key={r.key} id={`net-row-${r.key}`} className="border-t border-[var(--pg-line)]">
        <button
          type="button"
          onClick={() => setOpenRow(open ? null : r.key)}
          className="w-full flex items-center justify-between gap-4 py-4 text-left"
        >
          <span className="min-w-0">
            <span className={`block font-semibold ${r.danger ? 'text-[var(--pg-danger-text)]' : 'text-[var(--pg-text)]'}`}>
              {r.title}
            </span>
            <span className="block text-sm text-[var(--pg-text-dim)]">{r.hint}</span>
          </span>
          {open ? <ChevronDown className="w-5 h-5 shrink-0 text-[var(--pg-text-dim)]" /> : <ChevronRight className="w-5 h-5 shrink-0 text-[var(--pg-text-dim)]" />}
        </button>
        {open && <div className="pb-5">{r.body}</div>}
      </div>
    );
  };

  return (
    <div className="container mx-auto px-6 py-8 max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold text-[var(--pg-text)]">{t('networkPageTitle')}</h1>

      {/* 1. Status: one sentence, one action. */}
      <div className={`rounded-xl border p-5 flex items-start gap-4 ${toneCls}`}>
        <div className="shrink-0 mt-0.5">{icon}</div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <div className="text-lg font-bold text-[var(--pg-text)]">{title}</div>
            <div className="text-sm text-[var(--pg-text)]">{body}</div>
          </div>
          {action}
          {searchResult === 'not_found' && (
            <p className="text-xs text-[var(--pg-text-dim)]">{t('statusSearchNotFound')}</p>
          )}
          {isMother && <WindowsHealthPanel compact />}
        </div>
      </div>

      {/* 2. Role-specific cards. */}
      {isMother ? (
        <>
          <MotherLanSection />
          <PairedDevicesPanel />
        </>
      ) : (
        <div className="pg-panel">
          <h3 className="pg-panel-title mb-3">{t('myMotherTitle')}</h3>
          {mother ? (
            <div className="flex items-center gap-4">
              <Monitor className="w-6 h-6 shrink-0 text-[var(--pg-text-muted)]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[var(--pg-text)] truncate">
                    {displayDeviceLabel(mother.mother_label) || t('statusUnnamedMother')}
                  </span>
                  {isRecent(mother.last_seen_at, 30) ? (
                    <span className="text-xs px-2 py-0.5 rounded-full border bg-[var(--pg-ok-bg)] text-[var(--pg-ok-text)] border-[var(--pg-ok-line)]">
                      {t('online')}
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded-full border bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)] border-[var(--pg-line-strong)]">
                      {t('offline')}
                    </span>
                  )}
                </div>
                {mother.last_seen_at && (
                  <div className="text-xs text-[var(--pg-text-dim)] mt-1">
                    {t('lastSeen', { time: formatLanTime(mother.last_seen_at) })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-[var(--pg-text-dim)]">{t('myMotherNone')}</p>
          )}
          <button
            type="button"
            onClick={() => openAdvanced('join')}
            className="mt-4 text-sm font-semibold text-[var(--pg-accent-bright)] hover:underline"
          >
            {t('myMotherChange')}
          </button>
        </div>
      )}

      {/* 3. Everything else, folded. */}
      <div className="pg-panel">
        <button
          type="button"
          onClick={() => setAdvOpen((v) => !v)}
          className="w-full flex items-center justify-between gap-4"
        >
          <span className="text-lg font-bold text-[var(--pg-text-muted)]">{t('advancedTitle')}</span>
          <span className="text-sm text-[var(--pg-text-dim)]">{advOpen ? t('advancedHide') : t('advancedShow')}</span>
        </button>
        {advOpen && (
          <div className="mt-3">
            {safeRows.map(renderRow)}
            {dangerRows.length > 0 && (
              <>
                <div className="mt-6 mb-1 text-xs font-bold uppercase tracking-wide text-[var(--pg-danger-text)]">
                  {t('advDangerTitle')}
                </div>
                {dangerRows.map(renderRow)}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
