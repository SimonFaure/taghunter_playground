import { Ban } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AuthUser } from '../../services/authStore';

// Full-screen hard lock shown when the client no longer owns the Playground app
// (auth_state.playground_enabled === false). Stronger than the billing/device
// lock: those keep the app usable and only block launching/joining games, while
// this replaces the whole shell - the product is gone until an admin re-enables
// it. Design: project_client_app_section.
//
// The flag is cached on auth_user so this holds offline; `onRetry` re-runs the
// server bootstrap so a re-enabled client gets straight back in without a
// restart, and `onSignOut` releases the device entirely.
interface AppDisabledScreenProps {
  user: AuthUser;
  onRetry: () => void;
  onSignOut: () => void;
}

export function AppDisabledScreen({ user, onRetry, onSignOut }: AppDisabledScreenProps) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center p-6 pg-app-bg">
      <div className="max-w-md w-full pg-panel p-8 text-center space-y-4">
        <div className="bg-red-500/20 border border-red-500/40 rounded-full p-3 inline-flex">
          <Ban className="w-6 h-6 text-red-400" />
        </div>
        <h2 className="text-2xl font-semibold text-[var(--pg-text)]">{t('authChrome:appDisabled.title')}</h2>
        <p className="text-[var(--pg-text-dim)]">
          {t('authChrome:appDisabled.body', { email: user.email })}
        </p>
        <div className="space-y-2">
          <button onClick={onRetry} className="pg-btn pg-btn--primary w-full !py-3">
            {t('authChrome:appDisabled.checkAgain')}
          </button>
          <button onClick={onSignOut} className="pg-btn w-full !py-3">
            {t('authChrome:appDisabled.signOut')}
          </button>
        </div>
      </div>
    </div>
  );
}
