import { useEffect, useState } from 'react';
import { Loader2, Wifi, Radio, Database } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { describeLocalRole } from '../../services/lanPairing';
import { loadConfig } from '../../utils/config';
import { MotherLanSection } from './MotherLanSection';
import { SatelliteLanSection } from './SatelliteLanSection';
import { LanDiagnostics } from './LanDiagnostics';
import { FirewallPanel } from './FirewallPanel';
import { ForceMotherPanel } from './ForceMotherPanel';
import { RejoinMotherPanel } from './RejoinMotherPanel';
import { NotMotherPanel } from './NotMotherPanel';
import { DefaultRolesPanel } from './DefaultRolesPanel';

type Mode = 'host' | 'join';

export function LanDevicesPanel() {
  const { t } = useTranslation('devicesLan');
  const [mode, setMode] = useState<Mode | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [r, cfg] = await Promise.all([
        describeLocalRole().catch(() => null),
        loadConfig().catch(() => null),
      ]);
      if (cancelled) return;
      // Default to "host" only when this device IS the mother (running the
      // server / raising the hotspot) or is configured to be one. Every other
      // device is a satellite and defaults to "join" - that's the tab a
      // non-mother operator wants (and where the mother's Wi-Fi creds live).
      const isMotherish =
        (!!r && (r.mother_server_running || r.is_mother_hosting)) ||
        !!cfg?.beMotherWhenAvailable;
      setMode((m) => m ?? (isMotherish ? 'host' : 'join'));
    })();
    return () => { cancelled = true; };
  }, []);

  if (mode === null) {
    return (
      <div className="flex items-center gap-2 text-[var(--pg-text-dim)] py-6">
        <Loader2 className="w-5 h-5 animate-spin" />
        {t('roleLoading')}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="pg-pill-group inline-flex">
        <TabButton active={mode === 'host'} onClick={() => setMode('host')} icon={<Wifi className="w-4 h-4" />}>
          {t('tabHost')}
        </TabButton>
        <TabButton active={mode === 'join'} onClick={() => setMode('join')} icon={<Radio className="w-4 h-4" />}>
          {t('tabJoin')}
        </TabButton>
      </div>

      {mode === 'host' ? <MotherLanSection /> : <SatelliteLanSection />}

      {/* Explain the two independent roles a device can play, since operators
          routinely confuse "provides the Wi-Fi" with "runs the game". Sits at
          the bottom with the toggles it explains, out of the everyday flow. */}
      <div className="pg-panel">
        <p className="text-sm text-[var(--pg-text-muted)] mb-4">{t('rolesExplainIntro')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-start gap-3">
            <Wifi className="w-5 h-5 mt-0.5 shrink-0 text-[var(--pg-accent-bright)]" />
            <div>
              <div className="text-sm font-semibold text-[var(--pg-text)] mb-0.5">{t('roleHotspotLabel')}</div>
              <p className="text-xs text-[var(--pg-text-dim)] leading-relaxed">{t('roleHotspotDesc')}</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Database className="w-5 h-5 mt-0.5 shrink-0 text-[var(--pg-accent-bright)]" />
            <div>
              <div className="text-sm font-semibold text-[var(--pg-text)] mb-0.5">{t('roleMotherLabel')}</div>
              <p className="text-xs text-[var(--pg-text-dim)] leading-relaxed">{t('roleMotherDesc')}</p>
            </div>
          </div>
        </div>
        <p className="text-xs text-[var(--pg-text-dim)] mt-4 pt-3 border-t border-[var(--pg-line)]">
          {t('rolesExplainNote')}{' '}
          <strong className="font-semibold text-[var(--pg-text-muted)]">{t('rolesExplainRecommend')}</strong>
        </p>
      </div>

      {/* Default-role designations (relayed to studio so sibling devices can
          auto-discover this hotspot; mother is inventory only). Shares the
          wizard's code paths. */}
      <DefaultRolesPanel />

      {/* Rarely-needed repair & role-override tools, tucked behind one
          collapsible so the everyday flow stays uncluttered: firewall repair,
          discovery diagnostics, and the manual mother promote/demote buttons. */}
      <div className="space-y-4 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-sm text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] transition"
        >
          {showAdvanced ? '▾' : '▸'} {t('advancedTitle')}
        </button>
        {showAdvanced && (
          <div className="space-y-5">
            <FirewallPanel hintKey={mode === 'host' ? 'firewallHint' : 'firewallHintChild'} />
            <LanDiagnostics />
            {/* Rejoin before promote: reconnecting to the mother that already
                exists is the safe repair, taking control is the heavy one. */}
            <RejoinMotherPanel />
            <ForceMotherPanel />
            <NotMotherPanel />
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active, onClick, icon, children,
}: {
  active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pg-pill flex items-center gap-2${active ? ' is-active' : ''}`}
    >
      {icon}
      {children}
    </button>
  );
}
