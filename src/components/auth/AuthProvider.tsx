import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { LoginScreen } from './LoginScreen';
import { OfflineGraceBanner } from './OfflineGraceBanner';
import { SetPinScreen } from './SetPinScreen';
import { LockScreen } from './LockScreen';
import { bootstrap, signOutOfThisDevice } from '../../services/auth';
import { hasPin } from '../../services/pinStore';
import { loadJwt } from '../../services/strongholdStore';
import { getAuthUser } from '../../services/authStore';
import type { AuthUser } from '../../services/authStore';

// Two locked states intentionally coexist:
//   - 'pin_locked' is the cold-start PIN gate. JWT + auth_user are intact;
//     entering the PIN reveals the app. Drives offline relogin.
//   - 'offline_locked' is the slice-1 grace expiration. JWT may be valid but
//     we haven't been able to reach the server within `offline_grace_days`,
//     so we hard-stop until internet returns.
// 'needs_pin_setup' covers the post-OTP step where the user picks a PIN
// before the app shell becomes visible. It also catches the rare
// "JWT exists but no PIN on disk" case (e.g. mid-onboarding crash).
type AuthState =
  | { kind: 'loading' }
  | { kind: 'unauthenticated' }
  | { kind: 'pin_locked'; user: AuthUser }
  | { kind: 'needs_pin_setup'; user: AuthUser }
  | { kind: 'authenticated'; user: AuthUser; offline: boolean }
  | { kind: 'offline_locked'; user: AuthUser };

interface AuthContextValue {
  user: AuthUser | null;
  offline: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [state, setState] = useState<AuthState>({ kind: 'loading' });

  // Cold-start gate. Order:
  //   1. No JWT → LoginScreen.
  //   2. JWT but no PIN → SetPinScreen (user finishes onboarding before app).
  //   3. JWT + PIN → LockScreen (offline-friendly unlock, no server contact).
  // bootstrap()-against-the-server only runs once the user clears the lock,
  // so admin-revoked devices still unlock locally and then fall through to
  // LoginScreen via the 401 path inside refresh().
  const refresh = useCallback(async () => {
    setState({ kind: 'loading' });

    const token = await loadJwt();
    if (!token) {
      setState({ kind: 'unauthenticated' });
      return;
    }

    const cachedUser = await getAuthUser();
    if (cachedUser && (await hasPin())) {
      setState({ kind: 'pin_locked', user: cachedUser });
      return;
    }
    if (cachedUser) {
      setState({ kind: 'needs_pin_setup', user: cachedUser });
      return;
    }

    // Token exists but no cached user — fall through to a server bootstrap
    // to either resurrect the auth_user row or be told the token is dead.
    await runServerBootstrap();
  }, []);

  // Post-unlock / post-PIN-setup step: contact the server to refresh
  // auth_state, bump last_seen, and surface 401s as a clean logout.
  const runServerBootstrap = useCallback(async () => {
    setState({ kind: 'loading' });
    const outcome = await bootstrap();
    switch (outcome.kind) {
      case 'no_token':
      case 'token_invalid':
        setState({ kind: 'unauthenticated' });
        break;
      case 'authenticated':
        setState({ kind: 'authenticated', user: outcome.authUser, offline: false });
        break;
      case 'offline_in_grace':
        setState({ kind: 'authenticated', user: outcome.authUser, offline: true });
        break;
      case 'offline_locked':
        setState({ kind: 'offline_locked', user: outcome.authUser });
        break;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Called by LoginScreen on successful OTP. The user now has a JWT and an
  // auth_user row but hasn't set a PIN yet — route to SetPinScreen.
  const handleAuthenticated = useCallback((user: AuthUser) => {
    setState({ kind: 'needs_pin_setup', user });
  }, []);

  // Called by SetPinScreen once the PIN has been persisted. Continue with
  // the normal server-bootstrap step so the app shell sees a fresh auth_state.
  const handlePinSet = useCallback(() => {
    void runServerBootstrap();
  }, [runServerBootstrap]);

  // Called by LockScreen on a correct PIN. JWT + auth_user are already
  // valid locally; bootstrap when we can to keep last_server_check_at fresh.
  const handleUnlocked = useCallback(() => {
    void runServerBootstrap();
  }, [runServerBootstrap]);

  const handleSignOut = useCallback(async () => {
    await signOutOfThisDevice();
    setState({ kind: 'unauthenticated' });
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
        <div className="flex flex-col items-center gap-3 text-slate-400">
          <Loader2 className="w-8 h-8 animate-spin" />
          <span>Loading…</span>
        </div>
      </div>
    );
  }

  if (state.kind === 'unauthenticated') {
    return <LoginScreen onAuthenticated={handleAuthenticated} />;
  }

  if (state.kind === 'needs_pin_setup') {
    return <SetPinScreen user={state.user} onPinSet={handlePinSet} />;
  }

  if (state.kind === 'pin_locked') {
    return <LockScreen user={state.user} onUnlocked={handleUnlocked} />;
  }

  if (state.kind === 'offline_locked') {
    return <OfflineGraceBanner user={state.user} variant="lock" onRetry={runServerBootstrap} />;
  }

  const ctxValue: AuthContextValue = {
    user: state.user,
    offline: state.offline,
    refresh: runServerBootstrap,
    signOut: handleSignOut,
  };

  return (
    <AuthContext.Provider value={ctxValue}>
      {state.offline && <OfflineGraceBanner user={state.user} variant="banner" onRetry={runServerBootstrap} />}
      {children}
    </AuthContext.Provider>
  );
}
