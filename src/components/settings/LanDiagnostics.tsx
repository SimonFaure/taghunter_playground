import { useCallback, useEffect, useState } from 'react';
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
      setMsg(`Adresse IP fixe attribuée : ${ip}. Reconnexion à la mère…`);
      await refreshStatic();
      // Give Windows a moment to apply, then re-diagnose.
      setDiag(await invoke<LanDiag>('lan_diag'));
    } catch (e) {
      setErr((e as Error)?.message || String(e));
    } finally {
      setStaticBusy(false);
    }
  }, [gateway, refreshStatic]);

  const restore = useCallback(async () => {
    setRestoreBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await restoreDhcpFromStatic();
      setMsg('Adresse IP rétablie en DHCP.');
      await refreshStatic();
      setDiag(await invoke<LanDiag>('lan_diag'));
    } catch (e) {
      setErr((e as Error)?.message || String(e));
    } finally {
      setRestoreBusy(false);
    }
  }, [refreshStatic]);

  const anyBusy = busy || renewing || staticBusy || restoreBusy;

  return (
    <div className="pg-panel">
      <div className="flex items-center gap-2 mb-1">
        <Stethoscope className="w-5 h-5 text-[var(--pg-accent-bright)]" />
        <h3 className="pg-panel-title">Diagnostics réseau</h3>
      </div>
      <p className="text-sm text-[var(--pg-text-dim)] mb-3">
        Lance une recherche des mères et affiche l'état mDNS de cet appareil. Faites une
        capture d'écran sur la mère ET sur l'enfant.
      </p>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => void run()} disabled={anyBusy} className="pg-btn">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Stethoscope className="w-4 h-4" />}
          Lancer le diagnostic
        </button>
        {stuckApipa && (
          <button onClick={() => void renew()} disabled={anyBusy} className="pg-btn">
            {renewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Réparer l'adresse IP (DHCP)
          </button>
        )}
        {/* Always visible: the static-IP fallback is the reliable way to reach the
            mother in hotspot mode when Windows ICS DHCP won't lease. */}
        <button onClick={() => void forceStatic()} disabled={anyBusy} className="pg-btn">
          {staticBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Pin className="w-4 h-4" />}
          Forcer une adresse IP fixe
        </button>
        {hasStatic && (
          <button onClick={() => void restore()} disabled={anyBusy} className="pg-btn">
            {restoreBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
            Rétablir le DHCP
          </button>
        )}
      </div>

      {stuckApipa && (
        <div className="mt-3 text-sm rounded-lg p-2 border bg-amber-500/15 border-amber-500/40 text-amber-200">
          Cet appareil est connecté au Wi-Fi mais n'a pas reçu d'adresse de la mère (adresse
          169.254.x). Essayez « Réparer l'adresse IP (DHCP) » ; si l'adresse reste en 169.254.x,
          utilisez « Forcer une adresse IP fixe » (nécessite une confirmation Windows) pour obtenir
          une adresse {gateway ? gateway.split('.').slice(0, 3).join('.') + '.x' : '192.168.137.x'}.
        </div>
      )}

      {hasStatic && !stuckApipa && (
        <div className="mt-3 text-sm rounded-lg p-2 border bg-blue-500/15 border-blue-500/40 text-blue-200">
          Une adresse IP fixe est active sur cet appareil (utilisée quand le point d'accès ne
          distribue pas d'adresse). Le DHCP reste actif : Internet continue de fonctionner
          normalement sur les autres réseaux Wi-Fi. Vous pouvez la retirer via « Rétablir le DHCP ».
        </div>
      )}

      {msg && (
        <div className="mt-3 text-sm rounded-lg p-2 border bg-green-500/15 border-green-500/40 text-green-200">
          {msg}
        </div>
      )}

      {err && (
        <div className="mt-3 text-sm rounded-lg p-2 border bg-red-500/15 border-red-500/40 text-red-300">
          {err}
        </div>
      )}

      {diag && (
        <div className="mt-3 space-y-1 text-xs font-mono bg-[var(--pg-bg)] border border-[var(--pg-line)] rounded-lg p-3 overflow-x-auto">
          <Row label="Serveur mère actif (cet appareil)" value={diag.server_running ? 'OUI' : 'non'} />
          {diag.server_running && <Row label="Port" value={String(diag.port)} />}
          <Row label="Source réseau" value={diag.source} />
          <Row
            label="mDNS annoncé"
            value={diag.server_running ? (inert ? 'INERTE (rien annoncé !)' : diag.mdns_full_name) : '—'}
            bad={!!inert}
          />
          <Row label="IPv4 locales" value={diag.local_ipv4s.join(', ') || '—'} />
          <Row
            label="Adresses annoncées (verrou LAN)"
            value={diag.designated_addrs.join(', ') || 'VIDE (aucune 192.168.137.* !)'}
            bad={!!noDesignated}
          />
          <Row
            label="Pare-feu (règle TagHunter)"
            value={
              diag.firewall_rule_ok === true
                ? 'OK'
                : diag.firewall_rule_ok === false
                  ? 'ABSENTE ou obsolète (autre version de l’app) — utilisez « Autoriser l’accès réseau » ci-dessus'
                  : 'inconnue'
            }
            bad={diag.firewall_rule_ok === false}
          />
          <div className="pt-2 border-t border-[var(--pg-line)] mt-2">
            <span className="text-[var(--pg-text-dim)]">Mères détectées : </span>
            <span className={diag.discovered.length === 0 ? 'text-red-300' : 'text-green-300'}>
              {diag.discovered.length}
            </span>
          </div>
          {diag.discovered.map((m) => (
            <div key={m.mother_uuid} className="pl-2 text-[var(--pg-text-muted)]">
              • {m.label || m.mother_uuid.slice(0, 8)} @ {m.addresses.join(', ') || '(aucune adresse)'}:{m.port}
              {' '}(client {m.client_id ?? '?'}, epoch {m.epoch ?? '?'})
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
      <span className={bad ? 'text-red-300 font-semibold' : 'text-[var(--pg-text)]'}>{value}</span>
    </div>
  );
}
