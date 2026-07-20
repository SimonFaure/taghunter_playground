/**
 * i18next bootstrap for playground chrome (bucket 1).
 *
 * One i18next instance. Chrome catalogs bundled at build via Vite glob. In-game
 * shared text (bucket 2) will be injected at runtime from the synced
 * `admin_translations` store via `i18next.addResourceBundle` (step 2 - keyed by
 * the per-team language, not the operator chrome language).
 *
 * Mirrors studio's bootstrap. Design: plan `multilingual-app-translator-workflow.md`.
 * - `{{var}}` interpolation + CLDR plurals (i18next defaults).
 * - Fallback chain: requested → `en` (pivot) → raw key.
 * - Only the `CHROME_LANGS` subset is selectable for chrome.
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  CHROME_LANGS,
  DEFAULT_DISPLAY_LANG,
  PIVOT_LANG,
  SUPPORTED_LANGS,
  dirOf,
  isLang,
} from './languages';
import { INGAME_NAMESPACES, registerIngameBaselines } from './ingame';

const UI_LANG_STORAGE_KEY = 'taghunter_ui_lang';

const catalogModules = import.meta.glob<Record<string, unknown>>(
  './locales/*/*.json',
  { eager: true, import: 'default' },
);

const resources: Record<string, Record<string, Record<string, unknown>>> = {};
const namespaceSet = new Set<string>();

for (const [filePath, content] of Object.entries(catalogModules)) {
  const match = filePath.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!match) continue;
  const [, lang, ns] = match;
  namespaceSet.add(ns);
  (resources[lang] ??= {})[ns] = content;
}

export const CHROME_NAMESPACES = Array.from(namespaceSet).sort();

function resolveInitialLang(): string {
  try {
    const stored = localStorage.getItem(UI_LANG_STORAGE_KEY);
    if (stored && isLang(stored) && CHROME_LANGS.includes(stored)) return stored;
  } catch {
    /* localStorage may be unavailable */
  }
  const browser = (typeof navigator !== 'undefined' ? navigator.language : '')
    .split('-')[0];
  if (isLang(browser) && CHROME_LANGS.includes(browser)) return browser;
  return DEFAULT_DISPLAY_LANG;
}

function applyDocumentLang(lang: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.documentElement.dir = dirOf(lang);
}

void i18n.use(initReactI18next).init({
  resources,
  lng: resolveInitialLang(),
  fallbackLng: PIVOT_LANG,
  // The full player-language set is allowed so in-game text (bucket 2) can
  // resolve any team's language. The chrome picker only OFFERS CHROME_LANGS
  // (enforced by `setUiLanguage`); chrome catalogs exist only for that subset.
  supportedLngs: [...SUPPORTED_LANGS],
  ns: [...CHROME_NAMESPACES, ...INGAME_NAMESPACES],
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  returnNull: false,
  saveMissing: false,
  debug: import.meta.env.DEV,
});

// Bundled in-game baselines (bucket 2). Synced overrides are applied later by
// `hydrateIngameFromStore()` after each sync cycle.
registerIngameBaselines();

applyDocumentLang(i18n.language);
i18n.on('languageChanged', applyDocumentLang);

/** Change + persist the operator chrome language. */
export function setUiLanguage(lang: string): void {
  if (!CHROME_LANGS.includes(lang)) return;
  void i18n.changeLanguage(lang);
  try {
    localStorage.setItem(UI_LANG_STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
}

export default i18n;
