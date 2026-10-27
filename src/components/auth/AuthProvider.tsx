import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { LoginScreen } from './LoginScreen';
import { OfflineGraceBanner } from './OfflineGraceBanner';
import { BillingGraceBanner } from './BillingGraceBanner';
import { billingGraceInfo, BILLING_WARNING_THRESHOLD_DAYS } from '../../services/deviceLock';
import { SetPinScreen } from './SetPinScreen';
import { LockScreen } from './LockScreen';
import { AppDisabledScreen } from './AppDisabledScreen';
import { LanguageStep } from './onboarding/LanguageStep';
import { InternetCheckStep } from './onboarding/InternetCheckStep';
import { PostPinOnboarding } from './onboarding/PostPinOnboarding';
import {
  isOnboardingComplete,
  isStepAnswered,
  isLangTouched,
  ONBOARDING_KEYS,
} from '../../services/onboardingStore';
import { setUiLanguage } from '../../i18n';
import { CHROME_LANGS } from '../../i18n/languages';
import { bootstrap, signOutOfThisDevice } from '../../services/auth';
import { hasPin } from '../../services/pinStore';
import { loadJwt } from '../../services/strongholdStore';
import { getAuthUser, offlineGraceInfo, OFFLINE_WARNING_THRESHOLD_DAYS } from '../../services/authStore';
import type { AuthUser } from '../../services/authStore';
import { onLicenceAdopted, startLicenceLanWatch } from '../../services/licenceLanSync';

// The manual lock is a `locked` boolean, NOT an auth state: the user taps
// "Lock" in the nav bar and LockScreen renders as a full-screen overlay ON
// TOP of the still-mounted app shell, so sync and any live game keep running
// underneath. Entering the PIN just hides the overlay again.
//
// 'offline_locked' is the slice-1 grace expiration: the JWT may be valid but
// we haven't reached the server within `offline_grace_days`, so we hard-stop
// until internet returns.
// 'needs_pin_setup' covers the post-OTP step where the user picks a PIN
// before the app shell becomes visible. It also catches the rare
// "JWT exists but no PIN on disk" case (e.g. mid-onboarding crash), so an
// authenticated user always has a PIN for the Lock action to check against.
// 'app_disabled' is the Client-App master switch: the client no longer owns the
// Playground product (auth_state.playground_enabled === false). Unlike the
// billing/device lock (which keeps the app usable, blocking only launch/join),
// this replaces the whole shell. Computed from the cached flag so it holds
// offline. Design: project_client_app_section.
type AuthState =
  | { kind: 'loading' }
  | { kind: 'unauthenticated' }
  | { kind: 'needs_pin_setup'; user: AuthUser }
  | { kind: 'authenticated'; user: AuthUser; offline: boolean }
  | { kind: 'offline_locked'; user: AuthUser }
  | { kind: 'app_disabled'; user: AuthUser };

interface AuthContextValue {
  user: AuthUser | null;
  offline: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  lock: () => void;
  // Manual lock overlay state + a PIN-less lift, used ONLY by a remote
  // join_game push: an operator pulling a locked device into a game.
  locked: boolean;
  unlock: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// During first-launch onboarding, default the UI language to the client's
// account language - but only if the operator didn't explicitly pick one on the
// language step. Once onboarding is complete the device owns its language, so a
// later admin change never yanks a running device. Design: project_client_language.
async function maybeApplyClientLanguage(user: AuthUser): Promise<void> {
  if (await isOnboardingComplete()) return;
  if (await isLangTouched()) return;
  const lang = user.language;
  if (lang && CHROME_LANGS.includes(lang)) {
    setUiLanguage(lang); // changes i18n + persists taghunter_ui_lang
  }
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<AuthState>({ kind: 'loading' });
  // Manual lock overlay. Kept separate from `state` so the authenticated app
  // shell stays mounted (sync, timers, live games) while LockScreen covers it.
  const [locked, setLocked] = useState(false);

  // First-launch onboarding gate (per-device, hard gate). `onboardingComplete`
  // is null until the schema_meta flag is read. The pre-auth steps (language,
  // internet) only matter while unauthenticated; the post-PIN steps (name,
  // mother, operator-only, appearance) gate the app shell once authenticated.
  // Design: plans/playground-first-launch-onboarding.md.
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const [langAnswered, setLangAnswered] = useState(false);
  const [internetConfirmed, setInternetConfirmed] = useState(false);

  useEffect(() => {
    void (async () => {
      const done = await isOnboardingComplete();
      if (!done) setLangAnswered(await isStepAnswered(ONBOARDING_KEYS.lang));
      setOnboardingComplete(done);
    })();
  }, []);

  // Cold-start gate. Order:
  //   1. No JWT → LoginScreen.
  //   2. JWT but no PIN → SetPinScreen (user finishes onboarding before app).
  //   3. JWT (+ PIN, or no cached user) → straight to a server bootstrap.
  // The PIN is no longer a launch gate; it only guards the nav-bar "Lock"
  // button. A relaunch therefore drops the user straight into the app shell.
  const refresh = useCallback(async () => {
    setState({ kind: 'loading' });

    const token = await loadJwt();
    if (!token) {
      setState({ kind: 'unauthenticated' });
      return;
    }

    const cachedUser = await getAuthUser();
    if (cachedUser && !(await hasPin())) {
      // Rare: JWT landed but the PIN was never persisted (mid-onboarding
      // crash). Finish PIN setup so the Lock action always has one to check.
      setState({ kind: 'needs_pin_setup', user: cachedUser });
      return;
    }

    // JWT present (with a PIN, or with no cached user) - fall through to a
    // server bootstrap to refresh auth_state, resurrect the auth_user row,
    // or be told the token is dead.
    await runServerBootstrap();
  }, []);

  // Post-unlock / post-PIN-setup step: contact the server to refresh
  // auth_state, bump last_seen, and surface 401s as a clean logout.
  const runServerBootstrap = useCallback(async () => {
    setState({ kind: 'loading' });
    // Any full re-bootstrap supersedes a pending manual lock.
    setLocked(false);
    const outcome = await bootstrap();
    switch (outcome.kind) {
      case 'no_token':
      case 'token_invalid':
        setState({ kind: 'unauthenticated' });
        break;
      case 'authenticated':
        if (!outcome.authUser.playground_enabled) {
          setState({ kind: 'app_disabled', user: outcome.authUser });
          break;
        }
        await maybeApplyClientLanguage(outcome.authUser);
        setState({ kind: 'authenticated', user: outcome.authUser, offline: false });
        break;
      case 'offline_in_grace':
        if (!outcome.authUser.playground_enabled) {
          setState({ kind: 'app_disabled', user: outcome.authUser });
          break;
        }
        await maybeApplyClientLanguage(outcome.authUser);
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

  // A LAN peer's newer licence replaced ours (services/licenceLanSync): the
  // running shell picks up the renewed countdown and the account's locks in
  // place; a locked-out device re-runs the gate, which now finds it in grace.
  const stateKind = state.kind;
  useEffect(() => {
    if (stateKind === 'offline_locked') return onLicenceAdopted(() => void runServerBootstrap());
    if (stateKind !== 'authenticated') return;
    return onLicenceAdopted(() => {
      void getAuthUser().then((user) => {
        if (!user) return;
        setState((prev) => {
          if (prev.kind !== 'authenticated') return prev;
          return user.playground_enabled ? { ...prev, user } : { kind: 'app_disabled', user };
        });
      });
    });
  }, [stateKind, runServerBootstrap]);

  // Locked for being offline too long: look on the LAN for a device of the
  // licensee holding a fresher licence (the shell's own ping loop is unmounted).
  const lockedClientId = state.kind === 'offline_locked' ? state.user.client_id : null;
  useEffect(() => {
    if (lockedClientId == null) return;
    return startLicenceLanWatch(lockedClientId);
  }, [lockedClientId]);

  // Called by LoginScreen on successful OTP. The user now has a JWT and an
  // auth_user row but hasn't set a PIN yet - route to SetPinScreen.
  const handleAuthenticated = useCallback((user: AuthUser) => {
    // Apply the client language as early as the OTP step so the PIN-setup and
    // post-PIN onboarding screens already render in it (guarded; see helper).
    void maybeApplyClientLanguage(user);
    setState({ kind: 'needs_pin_setup', user });
  }, []);

  // Called by SetPinScreen once the PIN has been persisted. Continue with
  // the normal server-bootstrap step so the app shell sees a fresh auth_state.
  const handlePinSet = useCallback(() => {
    void runServerBootstrap();
  }, [runServerBootstrap]);

  // Called by the LockScreen overlay on a correct PIN (or a completed
  // Forgot-PIN reset). The app shell never unmounted - just hide the overlay.
  const handleUnlocked = useCallback(() => {
    setLocked(false);
  }, []);

  const handleSignOut = useCallback(async () => {
    await signOutOfThisDevice();
    setState({ kind: 'unauthenticated' });
  }, []);

  // Manual lock. Invoked by the nav-bar "Lock" button. Raises the LockScreen
  // overlay over the still-running app shell; handleUnlocked lowers it again.
  const lock = useCallback(() => {
    setLocked(true);
  }, []);

  if (state.kind === 'loading' || onboardingComplete === null) {
    return (
      <div className="min-h-screen flex items-center justify-center pg-app-bg">
        <div className="flex flex-col items-center gap-3 text-[var(--pg-text-dim)]">
          <Loader2 className="w-8 h-8 animate-spin" />
          <span>{t('authChrome:provider.loading')}</span>
        </div>
      </div>
    );
  }

  if (state.kind === 'unauthenticated') {
    // First-launch pre-auth steps gate the login screen (steps 0–1).
    if (!onboardingComplete) {
      if (!langAnswered) {
        return <LanguageStep onDone={() => setLangAnswered(true)} />;
      }
      if (!internetConfirmed) {
        return <InternetCheckStep onReachable={() => setInternetConfirmed(true)} />;
      }
    }
    return <LoginScreen onAuthenticated={handleAuthenticated} />;
  }

  if (state.kind === 'needs_pin_setup') {
    return <SetPinScreen user={state.user} onPinSet={handlePinSet} />;
  }

  if (state.kind === 'offline_locked') {
    return <OfflineGraceBanner user={state.user} variant="lock" onRetry={runServerBootstrap} />;
  }

  // Master Client-App switch is off - hard-replace the shell. Sits above the
  // onboarding gate so a disabled account can never reach the app, and offers
  // a re-check (admin may re-enable) plus a clean sign-out.
  if (state.kind === 'app_disabled') {
    return (
      <AppDisabledScreen user={state.user} onRetry={runServerBootstrap} onSignOut={handleSignOut} />
    );
  }

  // Authenticated but onboarding never finished (fresh install OR an existing
  // JWT+PIN install that predates the wizard - the migration case). Run the
  // post-PIN steps (name → mother → operator-only → appearance) before the app shell.
  if (!onboardingComplete) {
    return (
      <PostPinOnboarding user={state.user} onComplete={() => setOnboardingComplete(true)} />
    );
  }

  const ctxValue: AuthContextValue = {
    user: state.user,
    offline: state.offline,
    refresh: runServerBootstrap,
    signOut: handleSignOut,
    lock,
    locked,
    unlock: handleUnlocked,
  };

  // Only nag with the offline banner once the runway is short. While offline
  // with plenty of days left the device works fine and the bar is just noise;
  // the full remaining allowance is always visible in Settings → Account.
  const showOfflineBanner =
    state.offline &&
    offlineGraceInfo(state.user).remainingDays <= OFFLINE_WARNING_THRESHOLD_DAYS;

  // Billing/device-lock banner (project_client_device_lock). Always surface a
  // hard block (emergency-disabled or already past grace); for the countdown,
  // only nag once the runway is short, like the offline banner.
  const billing = billingGraceInfo(state.user);
  const showBillingBanner =
    state.user.devices_disabled ||
    billing.locked ||
    (billing.overdue && (billing.daysUntilLock ?? Infinity) <= BILLING_WARNING_THRESHOLD_DAYS);

  // The app shell stays mounted while locked - LockScreen overlays it so
  // sync and any in-progress game keep running behind the PIN gate.
  return (
    <AuthContext.Provider value={ctxValue}>
      {showOfflineBanner && <OfflineGraceBanner user={state.user} variant="banner" onRetry={runServerBootstrap} />}
      {showBillingBanner && <BillingGraceBanner user={state.user} />}
      {children}
      {locked && <LockScreen user={state.user} onUnlocked={handleUnlocked} />}
    </AuthContext.Provider>
  );
}
