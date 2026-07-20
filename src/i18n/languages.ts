/**
 * Canonical language registry for the playground.
 *
 * Builds on `services/langFlags.ts` (which already owns the 12 code→name→flag
 * map used by the launch modal / per-team language selects) so there is a single
 * source of truth. Adds text direction, the chrome subset, and pivot/default.
 *
 * Mirrors studio's `src/i18n/languages.ts`. Design: plan
 * `multilingual-app-translator-workflow.md`.
 *
 * - `CHROME_LANGS` = operator-facing UI subset (starts fr/en; es next).
 * - In-game shared text (bucket 2) + scenario text target the full player set.
 * - `dir` is registry-ready; player-facing rendering uses it for RTL (ar).
 * - `en` is pivot/source; `fr` is the default display language.
 */

import { LANG_NAMES, SUPPORTED_LANGS } from '../services/langFlags';

export { SUPPORTED_LANGS };

/** The canonical language codes, as a string-literal-ish union via the names map. */
export type Lang = keyof typeof LANG_NAMES & string;

const RTL_LANGS = new Set<string>(['ar']);

const ENGLISH_NAMES: Record<string, string> = {
  en: 'English', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian',
  ja: 'Japanese', zh: 'Chinese', ar: 'Arabic',
};

export interface LanguageMeta {
  code: string;
  nativeName: string;
  englishName: string;
  dir: 'ltr' | 'rtl';
}

export const LANGUAGES: Record<string, LanguageMeta> = Object.fromEntries(
  SUPPORTED_LANGS.map((code) => [
    code,
    {
      code,
      nativeName: LANG_NAMES[code] ?? code,
      englishName: ENGLISH_NAMES[code] ?? code,
      dir: RTL_LANGS.has(code) ? 'rtl' : 'ltr',
    },
  ]),
);

export const PIVOT_LANG = 'en';
export const DEFAULT_DISPLAY_LANG = 'fr';

/** Operator-facing chrome subset shipped today; grow as markets come online. */
export const CHROME_LANGS: readonly string[] = ['fr', 'en', 'es'] as const;

export function isLang(code: string): code is Lang {
  return SUPPORTED_LANGS.includes(code);
}

export function dirOf(code: string): 'ltr' | 'rtl' {
  return RTL_LANGS.has(code) ? 'rtl' : 'ltr';
}
