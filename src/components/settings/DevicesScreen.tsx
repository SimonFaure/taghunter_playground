import { useEffect, useState } from 'react';
import { Network, Wifi, Database } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isOnline, onConnectivityChange } from '../../services/connectivity';
import { LanDevicesPanel } from './LanDevicesPanel';
import { MyDevicesScreen } from './MyDevicesScreen';
import { DefaultRolesPanel } from './DefaultRolesPanel';
import { ForceMotherPanel } from './ForceMotherPanel';

interface DevicesScreenProps {
  onLoggedOut?: () => void;
}

/**
 * The Settings "devices" tab. Two sub-sections:
 *  - LAN devices (offline-capable): hotspot + mother/satellite pairing, all from
 *    the local SQLite / in-process axum mother - no internet needed.
 *  - Account devices (online-only): the cloud studio account device list, gated
 *    on connectivity so it shows a calm notice instead of a network error.
 */
export function DevicesScreen({ onLoggedOut }: DevicesScreenProps) {
  const { t } = useTranslation('devicesLan');
  const [online, setOnline] = useState(isOnline());

  useEffect(() => onConnectivityChange(setOnline), []);

  return (
    <div className="container mx-auto px-6 py-8 max-w-3xl">
      <section className="mb-10">
        <div className="flex items-center gap-2 mb-1">
          <Network className="w-6 h-6 text-[var(--pg-accent-bright)]" />
          <h1 className="text-2xl font-bold text-[var(--pg-text)]">{t('lanSectionTitle')}</h1>
        </div>
        <p className="text-sm text-[var(--pg-text-dim)] mb-5">{t('lanSectionHint')}</p>

        {/* Explain the two independent roles a device can play, since operators
            routinely confuse "provides the Wi-Fi" with "runs the game". */}
        <div className="pg-panel mb-6">
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

        <LanDevicesPanel />

        {/* Manual failover recovery: force this device to become the mother. */}
        <ForceMotherPanel />
      </section>

      <section>
        <h2 className="text-xl font-semibold text-[var(--pg-text)] mb-3">{t('accountSectionTitle')}</h2>
        {online ? (
          <MyDevicesScreen onLoggedOut={onLoggedOut} embedded />
        ) : (
          <div className="text-sm text-[var(--pg-text-dim)] pg-panel p-4">
            {t('offlineAccountNotice')}
          </div>
        )}
      </section>
    </div>
  );
}
