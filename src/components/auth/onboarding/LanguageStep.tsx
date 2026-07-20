import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OnboardingShell } from './OnboardingShell';
import { CHROME_LANGS, LANGUAGES, isLang } from '../../../i18n/languages';
import { setUiLanguage } from '../../../i18n';
import { LANG_FLAGS } from '../../../services/langFlags';
import { markStepAnswered, markLangTouched, ONBOARDING_KEYS } from '../../../services/onboardingStore';

// Step 0 - pick the operator/app UI language. Local + bundled, so this is the
// very first screen: every later screen (incl. "connect to the internet") then
// renders in the chosen language. Distinct from the per-team in-game language.
export function LanguageStep({ onDone }: { onDone: () => void }) {
  const { t, i18n } = useTranslation('onboarding');
  const initial = isLang(i18n.language) && CHROME_LANGS.includes(i18n.language)
    ? i18n.language
    : CHROME_LANGS[0];
  const [selected, setSelected] = useState<string>(initial);
  const [busy, setBusy] = useState(false);

  // Apply live so the whole wizard previews in the picked language immediately.
  // Mark "touched" so a later bootstrap won't override this deliberate choice
  // with the client's account language.
  function pick(code: string) {
    setSelected(code);
    setUiLanguage(code);
    void markLangTouched();
  }

  async function handleContinue() {
    setBusy(true);
    setUiLanguage(selected);
    await markStepAnswered(ONBOARDING_KEYS.lang);
    setBusy(false);
    onDone();
  }

  return (
    <OnboardingShell
      stepNumber={1}
      title={t('lang.title')}
      subtitle={t('lang.subtitle')}
      onPrimary={handleContinue}
      busy={busy}
    >
      <div className="grid grid-cols-1 gap-2">
        {CHROME_LANGS.map((code) => {
          const active = code === selected;
          return (
            <button
              key={code}
              type="button"
              onClick={() => pick(code)}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition ${
                active
                  ? 'border-[var(--pg-accent-line)] bg-[var(--pg-accent-tint)]'
                  : 'border-[var(--pg-line)] hover:bg-[var(--pg-surface-2)]'
              }`}
            >
              <img src={LANG_FLAGS[code]} alt="" className="w-6 h-6 rounded-sm" />
              <span className="text-[var(--pg-text)] font-medium">
                {LANGUAGES[code]?.nativeName ?? code}
              </span>
            </button>
          );
        })}
      </div>
    </OnboardingShell>
  );
}
