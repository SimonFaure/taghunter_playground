/**
 * Operator-facing chrome language picker. Lists only the shipped `CHROME_LANGS`
 * subset (not the full player-facing set). Persists via `setUiLanguage`.
 */
import { useTranslation } from 'react-i18next';
import { CHROME_LANGS, LANGUAGES, isLang } from './languages';
import { setUiLanguage } from './index';

export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { i18n } = useTranslation();
  const current = isLang(i18n.language) ? i18n.language : CHROME_LANGS[0];

  return (
    <select
      aria-label="Language"
      value={current}
      onChange={(e) => setUiLanguage(e.target.value)}
      className={`px-2 py-1 border border-slate-300 rounded text-sm bg-white ${className}`}
    >
      {CHROME_LANGS.map((code) => (
        <option key={code} value={code}>
          {LANGUAGES[code]?.nativeName ?? code}
        </option>
      ))}
    </select>
  );
}
