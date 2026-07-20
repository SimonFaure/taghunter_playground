// Shared language metadata used by the launch modal, the self-register overlay
// flag radios, and the operator language selects (team-details / add-team).
//
// LANG_NAMES is the single source of truth for the human label of a 2-letter
// ISO language code (it used to be duplicated inline in LaunchGameModal).
// LANG_FLAGS maps each code to a bundled SVG flag URL - bundled assets, never
// emoji, because Windows does not render regional-indicator flag emoji.
//
// Canonical flag for the ambiguous codes: en→GB, pt→PT, ar→SA (also ja→JP,
// zh→CN). Swap an asset in src/assets/flags/ to change the depiction.

import flagEn from '../assets/flags/gb.svg';
import flagFr from '../assets/flags/fr.svg';
import flagEs from '../assets/flags/es.svg';
import flagDe from '../assets/flags/de.svg';
import flagIt from '../assets/flags/it.svg';
import flagPt from '../assets/flags/pt.svg';
import flagNl from '../assets/flags/nl.svg';
import flagPl from '../assets/flags/pl.svg';
import flagRu from '../assets/flags/ru.svg';
import flagJa from '../assets/flags/ja.svg';
import flagZh from '../assets/flags/zh.svg';
import flagAr from '../assets/flags/sa.svg';

export const LANG_NAMES: Record<string, string> = {
  en: 'English', fr: 'Français', es: 'Español', de: 'Deutsch', it: 'Italiano',
  pt: 'Português', nl: 'Nederlands', pl: 'Polski', ru: 'Русский',
  ja: '日本語', zh: '中文', ar: 'العربية',
};

export const LANG_FLAGS: Record<string, string> = {
  en: flagEn, fr: flagFr, es: flagEs, de: flagDe, it: flagIt,
  pt: flagPt, nl: flagNl, pl: flagPl, ru: flagRu,
  ja: flagJa, zh: flagZh, ar: flagAr,
};

/** Every language we have a name + flag for, in display order. */
export const SUPPORTED_LANGS: string[] = Object.keys(LANG_NAMES);

/** Human label for a code, falling back to the bare code. */
export function langName(code: string): string {
  return LANG_NAMES[code] || code;
}
