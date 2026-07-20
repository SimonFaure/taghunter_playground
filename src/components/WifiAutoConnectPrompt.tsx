import { Wifi } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  ssid: string;
  busy?: boolean;
  onAnswer: (consent: boolean) => void;
}

// One-time "auto-connect to this network from now on?" prompt (design Q2/Q8).
// Shown only in a join/LAN context the first time a remembered, in-range
// network has no consent decision yet.
export function WifiAutoConnectPrompt({ ssid, busy, onAnswer }: Props) {
  const { t } = useTranslation('devicesLan');
  return (
    <div className="pg-overlay">
      <div className="pg-modal max-w-md">
        <div className="pg-modal-head">
          <div className="flex items-center gap-2">
            <Wifi className="w-5 h-5 text-[var(--pg-accent-bright)]" />
            <h2 className="pg-modal-title">{t('autoConnectTitle')}</h2>
          </div>
        </div>
        <div className="pg-modal-body">
          <p className="text-sm text-[var(--pg-text-muted)]">
            {t('autoConnectBody', { ssid })}
          </p>
        </div>
        <div className="pg-modal-foot">
          <button className="pg-btn" disabled={busy} onClick={() => onAnswer(false)}>
            {t('autoConnectNo')}
          </button>
          <button className="pg-btn pg-btn--primary" disabled={busy} onClick={() => onAnswer(true)}>
            {t('autoConnectYes')}
          </button>
        </div>
      </div>
    </div>
  );
}
