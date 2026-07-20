import { useEffect, useState } from 'react';
import { Loader2, Wifi, Radio } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { describeLocalRole } from '../../services/lanPairing';
import { loadConfig } from '../../utils/config';
import { MotherLanSection } from './MotherLanSection';
import { SatelliteLanSection } from './SatelliteLanSection';

type Mode = 'host' | 'join';

export function LanDevicesPanel() {
  const { t } = useTranslation('devicesLan');
  const [mode, setMode] = useState<Mode | null>(null);

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
