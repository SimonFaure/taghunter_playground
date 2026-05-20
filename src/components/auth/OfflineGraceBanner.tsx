import { WifiOff, Lock } from 'lucide-react';
import type { AuthUser } from '../../services/authStore';

interface OfflineGraceBannerProps {
  user: AuthUser;
  variant: 'banner' | 'lock';
  onRetry?: () => void;
}

export function OfflineGraceBanner({ user, variant, onRetry }: OfflineGraceBannerProps) {
  const lastSeen = new Date(user.last_server_check_at);
  const ageDays = Math.floor((Date.now() - lastSeen.getTime()) / (1000 * 60 * 60 * 24));
  const remaining = Math.max(0, user.offline_grace_days - ageDays);

  if (variant === 'banner') {
    return (
      <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 flex items-center justify-between text-sm">
        <div className="flex items-center gap-2 text-amber-300">
          <WifiOff className="w-4 h-4" />
          <span>
            Offline mode — last reached the server {ageDays} day{ageDays === 1 ? '' : 's'} ago.{' '}
            {remaining > 0 ? `${remaining} day${remaining === 1 ? '' : 's'} of offline access left.` : 'Reconnect required.'}
          </span>
        </div>
        {onRetry && (
          <button onClick={onRetry} className="text-amber-200 hover:text-white underline">
            Retry now
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <div className="max-w-md w-full bg-slate-800 border border-slate-700 rounded-2xl p-8 text-center space-y-4">
        <div className="bg-red-500/20 border border-red-500/40 rounded-full p-3 inline-flex">
          <Lock className="w-6 h-6 text-red-400" />
        </div>
        <h2 className="text-2xl font-semibold text-white">Reconnect to continue</h2>
        <p className="text-slate-400">
          This device hasn't reached the server in {ageDays} days, exceeding your{' '}
          {user.offline_grace_days}-day offline allowance. Connect to the internet to resume.
        </p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium"
          >
            Retry connection
          </button>
        )}
      </div>
    </div>
  );
}
