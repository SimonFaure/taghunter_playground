// One-time notice on a device upgraded from a hotspot-era build: the mother no
// longer creates the Wi-Fi, every PC must join the same router / network and run
// the same version. Mounted at the App root; fed by legacyHotspotCleanup.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Router, X } from 'lucide-react';
import {
  dismissHotspotRemovedNotice,
  isHotspotRemovedNoticePending,
  runLegacyHotspotCleanup,
} from '../services/legacyHotspotCleanup';
import { useInGame } from '../services/screenState';

export function HotspotRemovedNotice() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const inGame = useInGame();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await runLegacyHotspotCleanup();
      if (!cancelled && (await isHotspotRemovedNoticePending())) setVisible(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    void dismissHotspotRemovedNotice();
  };

  return (
    <div
      className={`fixed ${inGame ? 'top-0' : 'bottom-0'} left-0 right-0 flex items-center justify-center gap-3 px-4 py-2 bg-amber-600/95 text-white shadow-lg`}
      style={{ zIndex: 5900 }}
    >
      <Router size={18} className="shrink-0" />
      <span className="text-sm font-medium">{t('devicesLan:hotspotRemovedNotice')}</span>
      <button
        type="button"
        onClick={dismiss}
        className="ml-1 p-1 rounded hover:bg-white/20 transition-colors"
        title={t('devicesLan:hotspotRemovedDismiss')}
      >
        <X size={16} />
      </button>
    </div>
  );
}
