/**
 * Register a scenario's author-uploaded custom fonts so the gameplay pages can
 * render text in them.
 *
 * Custom font files are synced into the scenario's version dir (same path as
 * every other scenario asset) and resolve through the `scenario://` protocol.
 * Each face in `game_meta.custom_fonts` becomes a `FontFace` registered under
 * the family name; `resolveFontFamily()` then maps `game_meta.font` onto it.
 *
 * Playground-only — Studio has its own preview-side equivalent.
 *
 * Plan: C:\Users\faure\.claude\plans\studio-custom-fonts-typography.md
 */

import { scenarioAssetUrl } from '../services/contentFs';

interface CustomFontFace {
  filename?: string;
  weight?: number;
  style?: string;
}
interface CustomFont {
  family?: string;
  faces?: CustomFontFace[];
}

// `uniqid::family::filename` keys already added to `document.fonts`, so
// re-mounting a game page (or switching versions) doesn't double-register.
const registered = new Set<string>();

export async function registerScenarioFonts(uniqid: string, customFonts: unknown): Promise<void> {
  if (typeof document === 'undefined' || !uniqid) return;
  if (!Array.isArray(customFonts)) return;

  for (const cf of customFonts as CustomFont[]) {
    const family = (cf?.family ?? '').trim();
    if (!family || !Array.isArray(cf?.faces)) continue;

    for (const face of cf.faces) {
      const filename = face?.filename;
      if (!filename) continue;

      const key = `${uniqid}::${family}::${filename}`;
      if (registered.has(key)) continue;
      registered.add(key);

      const url = scenarioAssetUrl(uniqid, filename);
      try {
        const ff = new FontFace(family, `url("${url}")`, {
          weight: String(face.weight ?? 400),
          style: face.style === 'italic' ? 'italic' : 'normal',
          display: 'swap',
        });
        const loaded = await ff.load();
        document.fonts.add(loaded);
      } catch (err) {
        // Allow a retry on the next scenario load (e.g. file still syncing).
        registered.delete(key);
        console.warn('[registerScenarioFonts] failed to load font face', {
          family,
          filename,
          err,
        });
      }
    }
  }
}
