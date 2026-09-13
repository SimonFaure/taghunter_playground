import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Stethoscope, RefreshCw, Pin, Undo2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { renewDhcp, assignStaticIp, restoreDhcpFromStatic, staticIpSsid } from '../../services/wifi';

// One-shot LAN discovery diagnostics. Surfaces exactly why a child can't see the
// mother (inert mDNS / empty designated addresses / raw browse result) so we don't
// have to guess from device logs. Shown at the bottom of the Network tab on both
// the Host and Join sides; the operator can screenshot it from each device.

interface DiscoveredMother {
  mother_uuid: string;
  addresses: string[];
  port: number;
  label: string | null;
  client_id: number | null;
  epoch: number | null;
}

interface LanDiag {
  server_running: boolean;
  port: number;
  mdns_full_name: string;
  source: string;
  local_ipv4s: string[];
  designated_addrs: string[];
  discovered: DiscoveredMother[];
  /** true = rule present, false = DEFINITIVELY absent, null = couldn't check. */
  firewall_rule_ok: boolean | null;
}

export function LanDiagnostics() {
  const { t } = useTranslation('devicesLan');
  const [diag, setDiag] = useState<LanDiag | null>(null);
  const [busy, setBusy] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [staticBusy, setStaticBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [hasStatic, setHasStatic] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refreshStatic = useCallback(async () => {
    setHasStatic(!!(await staticIpSsid().catch(() => null)));
  }, []);
  useEffect(() => { void refreshStatic(); }, [refreshStatic]);

  const run = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      setDiag(await invoke<LanDiag>('lan_diag'));
    } catch (e) {
      setErr((e as Error)?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const renew = useCallback(async () => {
    setRenewing(true);
    setErr(null);
    try {
      await renewDhcp();
      setDiag(await invoke<LanDiag>('lan_diag'));
    } catch (e) {
      setErr((e as Error)?.message || String(e));
    } finally {
      setRenewing(false);
    }
  }, []);

  const inert = diag?.server_running && diag.mdns_full_name === '';
  const noDesignated = diag?.server_running && diag.designated_addrs.length === 0;
  // "Connected but wrong subnet": has an APIPA address and no 192.168.137.x lease.
  const stuckApipa =
    !!diag &&
    diag.local_ipv4s.some((ip) => ip.startsWith('169.254.')) &&
    !diag.local_ipv4s.some((ip) => ip.startsWith('192.168.137.'));
  // The mother's advertised 192.168.x address → the /24 for the static-IP fallback.
  const gateway =
    diag?.discovered
      .flatMap((m) => m.addresses)
      .find((a) => a.startsWith('192.168.')) ?? null;

  const forceStatic = useCallback(async () => {
    setStaticBusy(true);
    setErr(null);
    setMsg(null);
    try {
      // Prefer a discovered mother's 192.168.x address; otherwise fall back to the
      // hotspot's ICS gateway (always 192.168.137.1) so the button works even when
      // no mother address was captured. The /24 is derived from this.
      const gw = gateway ?? '192.168.137.1';
      const ip = await assignStaticIp(gw);
      setMsg(t('diagStaticAssigned', { ip }));
      await refreshStatic();
      // Give Windows a moment to apply, then re-diagnose.
      setDiag(await invoke<LanDiag>('lan_diag'));
    } catch (e) {
      setErr((e as Error)?.message || String(e));
    } finally {
      setStaticBusy(false);
    }
  }, [gateway, refreshStatic, t]);

  const restore = useCallback(async () => {
    setRestoreBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await restoreDhcpFromStatic();
      setMsg(t('diagDhcpRestored'));
      await refreshStatic();
      setDiag(await invoke<LanDiag>('lan_diag'));
    } catch (e) {
      setErr((e as Error)?.message || String(e));
    } finally {
      setRestoreBusy(false);
    }
  }, [refreshStatic, t]);

  const anyBusy = busy || renewing || staticBusy || restoreBusy;

  return (
    <div className="pg-panel">
      <div className="flex items-center gap-2 mb-1">
        <Stethoscope className="w-5 h-5 text-[var(--pg-accent-bright)]" />
        <h3 className="pg-panel-title">{t('diagTitle')}</h3>
      </div>
      <p className="text-sm text-[var(--pg-text-dim)] mb-3">{t('diagIntro')}</p>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => void run()} disabled={anyBusy} className="pg-btn">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Stethoscope className="w-4 h-4" />}
          {t('diagRun')}
        </button>
        {stuckApipa && (
          <button onClick={() => void renew()} disabled={anyBusy} className="pg-btn">
            {renewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {t('diagRepairIp')}
          </button>
        )}
        {/* Always visible: the static-IP fallback is the reliable way to reach the
            mother in hotspot mode when Windows ICS DHCP won't lease. */}
        <button onClick={() => void forceStatic()} disabled={anyBusy} className="pg-btn">
          {staticBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Pin className="w-4 h-4" />}
          {t('diagForceStatic')}
        </button>
        {hasStatic && (
          <button onClick={() => void restore()} disabled={anyBusy} className="pg-btn">
            {restoreBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
            {t('diagRestoreDhcp')}
          </button>
        )}
      </div>

      {stuckApipa && (
        <div className="mt-3 text-sm rounded-lg p-2 border bg-[var(--pg-warn-bg)] border-[var(--pg-warn-line)] text-[var(--pg-warn-text)]">
          {t('diagApipaWarning', {
            range: gateway ? gateway.split('.').slice(0, 3).join('.') + '.x' : '192.168.137.x',
          })}
        </div>
      )}

      {hasStatic && !stuckApipa && (
        <div className="mt-3 text-sm rounded-lg p-2 border bg-blue-500/15 border-blue-500/40 text-blue-200">
          {t('diagStaticActive')}
        </div>
      )}

      {msg && (
        <div className="mt-3 text-sm rounded-lg p-2 border bg-[var(--pg-ok-bg)] border-[var(--pg-ok-line)] text-[var(--pg-ok-text)]">
          {msg}
        </div>
      )}

      {err && (
        <div className="mt-3 text-sm rounded-lg p-2 border bg-[var(--pg-danger-bg)] border-[var(--pg-danger-line)] text-[var(--pg-danger-text)]">
          {err}
        </div>
      )}

      {diag && (
        <div className="mt-3 space-y-1 text-xs font-mono bg-[var(--pg-bg)] border border-[var(--pg-line)] rounded-lg p-3 overflow-x-auto">
          <Row label={t('diagRowServer')} value={diag.server_running ? t('diagYes') : t('diagNo')} />
          {diag.server_running && <Row label={t('diagRowPort')} value={String(diag.port)} />}
          <Row label={t('diagRowSource')} value={diag.source} />
          <Row
            label={t('diagRowMdns')}
            value={diag.server_running ? (inert ? t('diagInert') : diag.mdns_full_name) : '—'}
            bad={!!inert}
          />
          <Row label={t('diagRowLocalIps')} value={diag.local_ipv4s.join(', ') || '—'} />
          <Row
            label={t('diagRowDesignated')}
            value={diag.designated_addrs.join(', ') || t('diagEmptyDesignated')}
            bad={!!noDesignated}
          />
          <Row
            label={t('diagRowFirewall')}
            value={
              diag.firewall_rule_ok === true
                ? t('diagFirewallOk')
                : diag.firewall_rule_ok === false
                  ? t('diagFirewallMissing')
                  : t('diagFirewallUnknown')
            }
            bad={diag.firewall_rule_ok === false}
          />
          <div className="pt-2 border-t border-[var(--pg-line)] mt-2">
            <span className="text-[var(--pg-text-dim)]">{t('diagMothersFound')} </span>
            <span className={diag.discovered.length === 0 ? 'text-[var(--pg-danger-text)]' : 'text-[var(--pg-ok-text)]'}>
              {diag.discovered.length}
            </span>
          </div>
          {diag.discovered.map((m) => (
            <div key={m.mother_uuid} className="pl-2 text-[var(--pg-text-muted)]">
              • {m.label || m.mother_uuid.slice(0, 8)} @ {m.addresses.join(', ') || t('diagNoAddress')}:{m.port}
              {' '}{t('diagMotherLine', { client: m.client_id ?? '?', epoch: m.epoch ?? '?' })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-[var(--pg-text-dim)] shrink-0">{label}:</span>
      <span className={bad ? 'text-[var(--pg-danger-text)] font-semibold' : 'text-[var(--pg-text)]'}>{value}</span>
    </div>
  );
}
