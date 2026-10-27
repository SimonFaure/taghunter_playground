import { WifiOff, Lock, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { offlineGraceInfo } from '../../services/authStore';
import type { AuthUser } from '../../services/authStore';

interface OfflineGraceBannerProps {
  user: AuthUser;
  variant: 'banner' | 'lock';
  onRetry?: () => void;
}

export function OfflineGraceBanner({ user, variant, onRetry }: OfflineGraceBannerProps) {
  const { t } = useTranslation();
  const { ageDays, remainingDays: remaining } = offlineGraceInfo(user);

  if (variant === 'banner') {
    // Solid amber bar with dark text - this only renders when the offline
    // runway is short (<= OFFLINE_WARNING_THRESHOLD_DAYS), so it's meant to be
    // noticed. The previous translucent amber-on-dark was nearly illegible.
    return (
      <div className="bg-amber-400 border-b border-amber-500 px-4 py-2 flex items-center justify-between text-sm">
        <div className="flex items-center gap-2 text-amber-950 font-medium">
          <WifiOff className="w-4 h-4 shrink-0" />
          <span>
            {t('authChrome:offlineGrace.bannerLastReached', { count: ageDays })}{' '}
            {remaining > 0
              ? t('authChrome:offlineGrace.bannerRemaining', { count: remaining })
              : t('authChrome:offlineGrace.reconnectRequired')}
          </span>
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="text-amber-900 hover:text-black underline font-semibold shrink-0 ml-3"
          >
            {t('authChrome:offlineGrace.retryNow')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 pg-app-bg">
      <div className="max-w-md w-full pg-panel p-8 text-center space-y-4">
        <div className="bg-red-500/20 border border-red-500/40 rounded-full p-3 inline-flex">
          <Lock className="w-6 h-6 text-red-400" />
        </div>
        <h2 className="text-2xl font-semibold text-[var(--pg-text)]">{t('authChrome:offlineGrace.lockTitle')}</h2>
        <p className="text-[var(--pg-text-dim)]">
          {t('authChrome:offlineGrace.lockBody', { ageDays, graceDays: user.offline_grace_days })}
        </p>
        <p className="text-sm text-[var(--pg-text-dim)] flex items-start gap-2 text-left">
          <Loader2 className="w-4 h-4 mt-0.5 shrink-0 animate-spin" />
          <span>{t('authChrome:offlineGrace.lockLanSearch')}</span>
        </p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="pg-btn pg-btn--primary w-full !py-3"
          >
            {t('authChrome:offlineGrace.retryConnection')}
          </button>
        )}
      </div>
    </div>
  );
}
