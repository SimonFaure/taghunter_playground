import { Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LanDevicesPanel } from './LanDevicesPanel';
import { PairedDevicesPanel } from './PairedDevicesPanel';

/**
 * The Settings "devices" tab (offline-capable): hotspot + mother/satellite
 * pairing, all from the local SQLite / in-process axum mother - no internet
 * needed. Paired devices first (the everyday glance), then host/join; the
 * roles explainer, default-role toggles and repair/diagnostic tools sit at
 * the bottom (see LanDevicesPanel).
 */
export function DevicesScreen() {
  const { t } = useTranslation('devicesLan');

  return (
    <div className="container mx-auto px-6 py-8 max-w-3xl">
      <section>
        <div className="flex items-center gap-2 mb-1">
          <Network className="w-6 h-6 text-[var(--pg-accent-bright)]" />
          <h1 className="text-2xl font-bold text-[var(--pg-text)]">{t('lanSectionTitle')}</h1>
        </div>
        <p className="text-sm text-[var(--pg-text-dim)] mb-5">{t('lanSectionHint')}</p>

        {/* The fleet at a glance - always first. */}
        <PairedDevicesPanel />

        {/* Host/Join sections, then roles explainer + default-role toggles +
            the Advanced fold (firewall, diagnostics, take-control / not-a-mother). */}
        <LanDevicesPanel />
      </section>
    </div>
  );
}
