import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { OnboardingShell } from './OnboardingShell';
import { probeStudioReachable } from '../../../services/connectivity';

// Step 1 - actively probe studio reachability (NOT just navigator.onLine, which
// lies on captive portals) so we only show the OTP screen once the API answers.
// Auto-advances on success; on failure shows a retry button and also auto-retries
// on the `online` event and a short poll. No persisted marker - once a JWT lands
// (after OTP) internet was obviously available, so this never re-shows.
export function InternetCheckStep({ onReachable }: { onReachable: () => void }) {
  const { t } = useTranslation('onboarding');
  const [checking, setChecking] = useState(true);
  const doneRef = useRef(false);

  const check = useCallback(async () => {
    if (doneRef.current) return;
    setChecking(true);
    const ok = await probeStudioReachable();
    if (ok) {
      doneRef.current = true;
      onReachable();
      return;
    }
    setChecking(false);
  }, [onReachable]);

  useEffect(() => {
    void check();
    const onOnline = () => void check();
    window.addEventListener('online', onOnline);
    const poll = setInterval(() => void check(), 5000);
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(poll);
    };
  }, [check]);

  return (
    <OnboardingShell
      stepNumber={2}
      title={t('internet.title')}
      subtitle={t('internet.subtitle')}
      onPrimary={checking ? undefined : () => void check()}
      primaryLabel={t('internet.retry')}
    >
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        {checking ? (
          <>
            <Loader2 className="w-8 h-8 animate-spin text-[var(--pg-accent-bright)]" />
            <p className="text-[var(--pg-text-dim)] text-sm">{t('internet.checking')}</p>
          </>
        ) : (
          <>
            <WifiOff className="w-8 h-8 text-[var(--pg-text-dim)]" />
            <p className="text-[var(--pg-text)] text-sm">{t('internet.offline')}</p>
          </>
        )}
      </div>
    </OnboardingShell>
  );
}
