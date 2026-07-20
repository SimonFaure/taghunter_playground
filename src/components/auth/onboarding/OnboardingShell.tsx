import { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Shared layout for the wizard-owned first-launch steps (language, internet,
// name, hotspot, mother, operator-only, appearance). The OTP + PIN steps reuse
// their existing dedicated screens, so they don't render through here. Design:
// plans/playground-first-launch-onboarding.md.
const TOTAL_STEPS = 9;

interface OnboardingShellProps {
  /** 1-based step number (1=language … 9=appearance) for the "Step X of 9" pill. */
  stepNumber: number;
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Primary action - omitted when the step advances on its own (e.g. internet). */
  onPrimary?: () => void;
  primaryLabel?: string;
  primaryDisabled?: boolean;
  busy?: boolean;
  /** Back button - only present for the post-PIN preference steps. */
  onBack?: () => void;
}

export function OnboardingShell({
  stepNumber,
  title,
  subtitle,
  children,
  onPrimary,
  primaryLabel,
  primaryDisabled,
  busy,
  onBack,
}: OnboardingShellProps) {
  const { t } = useTranslation('onboarding');
  return (
    <div className="min-h-screen flex items-center justify-center p-6 pg-app-bg">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <span className="pg-pill inline-block mb-3">
            {t('stepOf', { current: stepNumber, total: TOTAL_STEPS })}
          </span>
          <h1 className="text-2xl font-bold text-[var(--pg-text)] mb-1">{title}</h1>
          {subtitle && <p className="text-[var(--pg-text-dim)] text-sm">{subtitle}</p>}
        </div>

        <div className="pg-panel p-6 space-y-4">
          {children}

          {(onPrimary || onBack) && (
            <div className="flex items-center justify-between gap-3 pt-2">
              {onBack ? (
                <button
                  type="button"
                  onClick={onBack}
                  disabled={busy}
                  className="text-sm text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] disabled:opacity-50"
                >
                  ← {t('back')}
                </button>
              ) : (
                <span />
              )}
              {onPrimary && (
                <button
                  type="button"
                  onClick={onPrimary}
                  disabled={primaryDisabled || busy}
                  className="pg-btn pg-btn--primary !py-2.5 px-5 disabled:opacity-50 flex items-center gap-2"
                >
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                  {primaryLabel ?? t('continue')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
