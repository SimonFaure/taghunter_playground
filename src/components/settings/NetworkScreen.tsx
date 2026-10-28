// Settings → Réseau, rebuilt around the device's ROLE (retours sept. #10).
//
// The old page showed everything at once (host/join tabs, roles explainer,
// hotspot button on satellites, a "connected mothers" history...), and it was
// where every mistake of the 25 Sept failover morning happened. Now:
//   1. one status card: what this device is, whether it works, ONE action;
//   2. satellite → "Mon poste mère"; mother → "Wi-Fi Tag Hunter" + "Mes satellites";
//   3. everything else folded under "Avancé" (collapsed by default), with the
//      role-changing actions grouped at the bottom, in red, behind confirmations.
// Second pass (retours sept. #10 follow-up): "Reprendre" is first-click-wins.
// Hotspot removal (2026-09-30): the app no longer manages Wi-Fi - every PC joins
// the same router / venue network through Windows. The mother's card shows its
// network + IP address(es); satellites can pair by typing that IP.
// Role split (2026-10-02): the status card says ONE thing, from the device's
// role (services/deviceRole.ts) - the mother, a substitute hosting in its
// absence, or a satellite. It used to read "poste mère" on a substitute exactly
// as on the real mother, and "Reconnexion au poste mère" on a mother that was
// about to host. "Confier le rôle" and "Je ne suis pas un poste mère" are gone:
// the role changes in "Rôle de ce poste" only.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, CheckCircle, ChevronDown, ChevronRight, Crown, Loader2, Monitor, Search,
} from 'lucide-react';
import { useLocalRole, useMotherConnection } from '../../services/motherConnection';
import { onMotherReachState, onMotherTakeover, type ReachState, type TakeoverMother } from '../../services/motherFailover';
import { rejoinCurrentMother, refreshLaunchedGamesRoute } from '../../services/childControlLink';
import {
  onHostingNotice, takeBackNow, resolveTwoMothers, canHostAsSubstitute, type HostingNotice,
} from '../../services/hostingRole';
import { forceBecomeMother } from '../../services/lanMotherBoot';
import { wasRoleResetByUpdate } from '../../services/deviceRole';
import { useAuth } from '../auth/AuthProvider';
import { ErrorDetails } from '../ErrorDetails';
import {
  listPairedDevices, listPairedMothers, isRecent, formatLanTime, displayDeviceLabel,
  type PairedMotherRow,
} from '../../services/lanPairing';
import { getCurrentSsid } from '../../services/wifi';
import { parseDbTs } from '../../utils/dbTime';
import { MotherLanSection } from './MotherLanSection';
import { SatelliteLanSection } from './SatelliteLanSection';
import { MotherSatellitesPanel } from './MotherSatellitesPanel';
import { PairedDevicesPanel } from './PairedDevicesPanel';
import { LanDiagnostics } from './LanDiagnostics';
import { FirewallPanel } from './FirewallPanel';
import { ForceMotherPanel } from './ForceMotherPanel';
import { RejoinMotherPanel } from './RejoinMotherPanel';
import { DefaultRolesPanel } from './DefaultRolesPanel';
import { WindowsHealthPanel } from './WindowsHealthPanel';

type RowKey =
  | 'role' | 'join' | 'byIp' | 'firewall' | 'windows' | 'diagnostic'
  | 'rejoin' | 'resume';

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
  const [ssid, setSsid] = useState<string | null>(null);
  const [satellitesOnline, setSatellitesOnline] = useState(0);
  const [busy, setBusy] = useState(false);
  const [searchResult, setSearchResult] = useState<'not_found' | null>(null);

  const [taker, setTaker] = useState<TakeoverMother | null>(null);
  const auth = useAuth();
  const [notice, setNotice] = useState<HostingNotice>({ kind: 'none' });
  // "Héberger en remplacement" / "Reprendre maintenant", run from the status card.
  const [acting, setActing] = useState(false);
  const [actError, setActError] = useState<unknown>(null);
  // "Héberger les parties en remplacement" worked, but no running game came
  // with it: say so instead of letting an empty games list pass for success.
  const [hostedEmpty, setHostedEmpty] = useState(false);
  const [roleReset, setRoleReset] = useState(false);

  useEffect(() => onMotherReachState(setReach), []);
  useEffect(() => onMotherTakeover(setTaker), []);
  useEffect(() => onHostingNotice(setNotice), []);
  useEffect(() => {
    void wasRoleResetByUpdate().then(setRoleReset);
  }, []);

  // `isMother`: this device is HOSTING (its LAN server runs) - as the mother or
  // as a substitute. `deviceRole` says which.
  const isMother = !!role && role.isMother;
  const deviceRole = role?.role ?? 'satellite';

  const refresh = useCallback(async () => {
    setSsid(await getCurrentSsid());
    if (isMother) {
      const devices = await listPairedDevices().catch(() => []);
      setSatellitesOnline(devices.filter((d) => !d.is_self && isRecent(d.last_seen_at)).length);
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

  const act = async (action: (clientId: number) => Promise<unknown>) => {
    const clientId = auth.user?.client_id;
    if (clientId == null) return;
    setActing(true);
    setActError(null);
    setHostedEmpty(false);
    try {
      if ((await action(clientId)) === 'empty') setHostedEmpty(true);
      await refreshLaunchedGamesRoute().catch(() => {});
    } catch (e) {
      setActError(e);
    } finally {
      setActing(false);
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
  // 'info': a settled state that is not the normal one (a substitute hosting,
  // the mother waiting for a game to finish elsewhere) - amber, no spinner.
  let tone: 'ok' | 'warn' | 'busy' | 'info';
  let title: string;
  let body: ReactNode;
  let action: ReactNode = null;
  if (isMother && deviceRole === 'mother') {
    tone = 'ok';
    title = t('statusAllGood');
    body = t('statusMotherRouterBody', { ssid: ssid ?? t('networkCardWired'), count: satellitesOnline });
  } else if (isMother) {
    // Hosting without being set as the mother: a substitute.
    const stoodInFor = displayDeviceLabel(role.substituteFor);
    tone = 'info';
    title = t('statusSubstituteTitle');
    body = stoodInFor
      ? t('statusSubstituteBody', { mother: stoodInFor, count: satellitesOnline })
      : t('statusSubstituteBodyUnknown', { count: satellitesOnline });
  } else if (deviceRole === 'mother' && notice.kind === 'substitute_busy') {
    // The mother, back while a game still runs on its substitute.
    const name = displayDeviceLabel(notice.substitute.label) || t('failover:anotherDevice');
    tone = 'info';
    title = t('statusMotherWaitingTitle', { name });
    body = t('statusMotherWaitingBody', { name });
    action = (
      <button className="pg-btn pg-btn--primary" disabled={acting} onClick={() => void act(takeBackNow)}>
        {acting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crown className="w-4 h-4" />}
        {t('statusTakeBackNow')}
      </button>
    );
  } else if (deviceRole === 'mother' && notice.kind === 'two_mothers') {
    // Either answer restarts Playground to apply it.
    const name = displayDeviceLabel(notice.other.label) || t('failover:anotherDevice');
    tone = 'warn';
    title = t('statusTwoMothersTitle');
    body = t('statusTwoMothersBody', { name });
    action = (
      <div className="flex flex-wrap items-center gap-3">
        <button className="pg-btn pg-btn--primary" disabled={acting} onClick={() => void act(() => resolveTwoMothers(true))}>
          <Crown className="w-4 h-4" />
          {t('failover:twoMothersKeepThis')}
        </button>
        <button className="pg-btn" disabled={acting} onClick={() => void act(() => resolveTwoMothers(false))}>
          {name}
        </button>
      </div>
    );
  } else if (deviceRole === 'mother') {
    // Set as the mother and about to host: it never looks for a mother.
    tone = 'busy';
    title = t('statusMotherStartingTitle');
    body = t('statusMotherStartingBody');
  } else if (taker && reach !== 'ok') {
    // Another satellite took over (first click wins): this one is joining it.
    tone = 'busy';
    title = t('failover:takingOverBy', { name: taker.label || t('failover:anotherDevice') });
    body = t('statusReconnectingBody');
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
    body = (
      <>
        {ssid ? t('statusNoMotherOnWifi', { ssid }) : t('statusNoMotherNoWifi')}
        {roleReset && <span className="block mt-1">{t('statusRoleResetNote')}</span>}
      </>
    );
    action = (
      <div className="flex flex-wrap items-center gap-3">
        <button className="pg-btn pg-btn--primary" disabled={busy} onClick={() => void searchMother()}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          {t('statusSearchMother')}
        </button>
        {/* Nothing hosts by itself except the mother: with none on the network,
            the operator decides that this PC stands in for it. */}
        {canHostAsSubstitute() && (
          <button
            className="pg-btn"
            disabled={acting}
            title={t('statusHostAsSubstituteHint')}
            onClick={() => void act((clientId) => forceBecomeMother(clientId, { allowIdle: true }))}
          >
            {acting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crown className="w-4 h-4" />}
            {t('statusHostAsSubstitute')}
          </button>
        )}
        <button className="text-sm font-semibold text-[var(--pg-accent-bright)] hover:underline" onClick={() => openAdvanced('byIp')}>
          {t('byIpTitle')}
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
      : tone === 'busy' || tone === 'info'
        ? 'border-amber-500/40 bg-amber-500/10'
        : 'border-[var(--pg-warn-line)] bg-[var(--pg-warn-bg)]';
  const icon =
    tone === 'ok' ? <CheckCircle className="w-7 h-7 text-[var(--pg-ok-icon)]" />
    : tone === 'busy' ? <Loader2 className="w-7 h-7 text-amber-400 animate-spin" />
    : tone === 'info' ? <Crown className="w-7 h-7 text-amber-400" />
    : <AlertTriangle className="w-7 h-7 text-[var(--pg-warn-icon)]" />;

  // Taking over a game is offered only once the mother has been gone a while
  // (the #22 "lost" state) - never while reconnecting, never on a satellite that
  // simply isn't connected yet, and not once another satellite took over.
  const offerResume =
    !isMother && deviceRole !== 'mother' && reach === 'lost' && !taker && canHostAsSubstitute();

  const rows: Array<{ key: RowKey; title: string; hint: string; body: ReactNode; danger?: boolean; hidden?: boolean }> = [
    { key: 'join', title: t('advJoinTitle'), hint: t('advJoinHint'), body: <SatelliteLanSection parts={['join']} />, hidden: isMother },
    { key: 'byIp', title: t('byIpTitle'), hint: t('advByIpHint'), body: <SatelliteLanSection parts={['byIp']} />, hidden: isMother },
    { key: 'firewall', title: t('advFirewallTitle'), hint: t('advFirewallHint'), body: <FirewallPanel hintKey={isMother ? 'firewallHint' : 'firewallHintChild'} /> },
    { key: 'windows', title: t('winHealthTitle'), hint: t('advWindowsHint'), body: <WindowsHealthPanel /> },
    {
      key: 'diagnostic', title: t('advDiagTitle'), hint: t('advDiagHint'),
      body: <LanDiagnostics />,
    },
    { key: 'rejoin', title: t('advRejoinTitle'), hint: t('advRejoinHint'), body: <RejoinMotherPanel />, hidden: isMother },
    { key: 'role', title: t('advRoleTitle'), hint: deviceRole === 'mother' ? t('advRoleHintMother') : t('advRoleHintSatellite'), body: <DefaultRolesPanel />, danger: true },
    { key: 'resume', title: t('advResumeTitle'), hint: t('advResumeHint'), body: <ForceMotherPanel firstClickWins />, danger: true, hidden: !offerResume },
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
          {actError != null && <ErrorDetails error={actError} />}
          {hostedEmpty && (
            <p className="text-xs text-amber-400">{t('failover:hostedEmpty')}</p>
          )}
          {searchResult === 'not_found' && (
            <p className="text-xs text-[var(--pg-text-dim)]">{t('statusSearchNotFound')}</p>
          )}
          <WindowsHealthPanel compact />
        </div>
      </div>

      {/* 2. Role-specific cards. A device set as the mother has no "Mon poste
          mère" card, even while it is not hosting yet: it is the mother. */}
      {isMother ? (
        <>
          <MotherLanSection />
          <PairedDevicesPanel />
        </>
      ) : deviceRole === 'mother' ? null : (
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
      {!isMother && deviceRole !== 'mother' && mother && <MotherSatellitesPanel />}

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
