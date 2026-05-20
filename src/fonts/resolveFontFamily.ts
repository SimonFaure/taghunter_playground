/**
 * Resolve a stored `game_meta.font` value to a CSS `font-family` stack.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ DUPLICATED VERBATIM — keep in sync:                                      │
 * │   studio-taghunter/src/fonts/resolveFontFamily.ts                        │
 * │   taghunter_playground/src/fonts/resolveFontFamily.ts                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * `game_meta.font` holds a plain family-name string (see the data-model
 * decision in the plan). This maps it to something the renderer can use:
 *
 *   - empty / whitespace        → '' (no override; caller keeps its default)
 *   - curated-catalog family    → the catalog entry's full fallback stack
 *   - custom-font family        → `"<family>", sans-serif` (the FontFace is
 *                                  registered under exactly `<family>` by
 *                                  registerScenarioFonts / registerStudioCustomFonts)
 *   - unknown legacy free-text  → `"<value>", sans-serif` (best-effort: the
 *                                  OS may still have the font installed)
 *
 * Plan: C:\Users\faure\.claude\plans\studio-custom-fonts-typography.md
 */

import { findCatalogFont } from './catalog';

export function resolveFontFamily(font: string | null | undefined): string {
  const name = (font ?? '').trim();
  if (!name) return '';

  const catalogHit = findCatalogFont(name);
  if (catalogHit) return catalogHit.stack;

  // Custom fonts and unknown legacy values resolve the same way: a quoted
  // family name with a generic fallback. Custom fonts are registered as
  // `FontFace`s under this exact name; legacy values lean on the OS.
  return `"${name}", sans-serif`;
}
