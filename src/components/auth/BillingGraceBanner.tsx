import { useTranslation } from 'react-i18next';
import { AlertTriangle, Lock } from 'lucide-react';
import { billingGraceInfo } from '../../services/deviceLock';
import type { AuthUser } from '../../services/authStore';

// Pre-lock / locked billing banner (project_client_device_lock). Informational
// only - the actual block lives on the launch/join action (GameLockGate). Shown
// when the device is emergency-disabled, already billing-locked, or counting
// down within the warning window. Mirrors OfflineGraceBanner's solid-amber bar.

interface BillingGraceBannerProps {
  user: AuthUser;
}

export function BillingGraceBanner({ user }: BillingGraceBannerProps) {
  const { t } = useTranslation();

  // Emergency disable trumps the billing clock.
  if (user.devices_disabled) {
    return <Bar tone="red" icon={<Lock className="w-4 h-4 shrink-0" />} text={t('deviceLock:bannerDisabled')} />;
  }

  const info = billingGraceInfo(user);
  if (!info.overdue) return null;

  if (info.locked) {
    return <Bar tone="red" icon={<Lock className="w-4 h-4 shrink-0" />} text={t('deviceLock:bannerLocked')} />;
  }

  return (
    <Bar
      tone="amber"
      icon={<AlertTriangle className="w-4 h-4 shrink-0" />}
      text={t('deviceLock:bannerOverdue', { days: info.daysUntilLock })}
    />
  );
}

function Bar({ tone, icon, text }: { tone: 'amber' | 'red'; icon: React.ReactNode; text: string }) {
  const cls =
    tone === 'red'
      ? 'bg-red-500 border-red-600 text-red-50'
      : 'bg-amber-400 border-amber-500 text-amber-950';
  return (
    <div className={`${cls} border-b px-4 py-2 flex items-center gap-2 text-sm font-medium`}>
      {icon}
      <span>{text}</span>
    </div>
  );
}
