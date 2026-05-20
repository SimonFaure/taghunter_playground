/**
 * Inject `@font-face` rules for every bundled catalog font.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ DUPLICATED VERBATIM — keep in sync:                                      │
 * │   studio-taghunter/src/fonts/registerCatalogFonts.ts                     │
 * │   taghunter_playground/src/fonts/registerCatalogFonts.ts                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * System catalog fonts (no `faces`) need nothing — the OS provides them.
 * Bundled fonts ship in `public/fonts/` and are served at `/fonts/<file>`.
 * Call this once at app startup so the picker preview and the rendered text
 * have the faces available.
 *
 * Plan: C:\Users\faure\.claude\plans\studio-custom-fonts-typography.md
 */

import { FONT_CATALOG } from './catalog';

let registered = false;

export function registerCatalogFonts(): void {
  if (registered || typeof document === 'undefined') return;
  registered = true;

  const rules: string[] = [];
  for (const font of FONT_CATALOG) {
    for (const face of font.faces ?? []) {
      rules.push(
        `@font-face{` +
          `font-family:"${font.family}";` +
          `src:url("/fonts/${face.file}") format("${face.format}");` +
          `font-weight:${face.weight};` +
          `font-style:${face.style};` +
          `font-display:swap;` +
          `}`,
      );
    }
  }
  if (rules.length === 0) return;

  const style = document.createElement('style');
  style.setAttribute('data-font-catalog', '');
  style.textContent = rules.join('\n');
  document.head.appendChild(style);
}
