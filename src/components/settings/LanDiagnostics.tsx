import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Stethoscope } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { LAN_PROTO } from '../../services/lanPairing';

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
  lan_proto: number;
}

interface LanDiag {
  server_running: boolean;
  port: number;
  mdns_full_name: string;
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
  const [err, setErr] = useState<string | null>(null);

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

  const inert = diag?.server_running && diag.mdns_full_name === '';
  const noDesignated = diag?.server_running && diag.designated_addrs.length === 0;
  // "Connected but no lease": only APIPA addresses - the router's DHCP didn't
  // answer (or the PC isn't really on the venue network).
  const stuckApipa =
    !!diag &&
    diag.local_ipv4s.length > 0 &&
    diag.local_ipv4s.every((ip) => ip.startsWith('169.254.'));
  const anyBusy = busy;

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
      </div>

      {stuckApipa && (
        <div className="mt-3 text-sm rounded-lg p-2 border bg-[var(--pg-warn-bg)] border-[var(--pg-warn-line)] text-[var(--pg-warn-text)]">
          {t('diagApipaWarning')}
        </div>
      )}

      {/* Router settings to check when devices can't see each other. The
          supplied router ships configured; this is for support, not for the
          licensee's everyday screen. */}
      <div className="mt-3 text-xs text-[var(--pg-text-muted)] border border-[var(--pg-line)] rounded-lg p-3 space-y-1">
        <p className="font-medium text-[var(--pg-text)]">{t('routerChecklistTitle')}</p>
        <ul className="list-disc pl-4 space-y-0.5">
          <li>{t('routerChecklistSameNetwork')}</li>
          <li>{t('routerChecklistIsolation')}</li>
          <li>{t('routerChecklistMulticast')}</li>
          <li>{t('routerChecklistBand')}</li>
        </ul>
      </div>

      {err && (
        <div className="mt-3 text-sm rounded-lg p-2 border bg-[var(--pg-danger-bg)] border-[var(--pg-danger-line)] text-[var(--pg-danger-text)]">
          {err}
        </div>
      )}

      {diag && (
        <div className="mt-3 space-y-1 text-xs font-mono bg-[var(--pg-bg)] border border-[var(--pg-line)] rounded-lg p-3 overflow-x-auto">
          <Row label={t('diagRowServer')} value={diag.server_running ? t('diagYes') : t('diagNo')} />
          {diag.server_running && <Row label={t('diagRowPort')} value={String(diag.port)} />}
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
              {(m.lan_proto ?? 1) !== LAN_PROTO && (
                <span className="text-[var(--pg-danger-text)]"> {t('diagMotherOtherProto', { proto: m.lan_proto ?? 1 })}</span>
              )}
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
