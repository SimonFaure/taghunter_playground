/**
 * Curated font catalog — the "wide range of fonts" offered by the Typography
 * section picker.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ THIS FILE IS DUPLICATED VERBATIM IN BOTH PROJECTS — KEEP THEM IN SYNC:    │
 * │   studio-taghunter/src/fonts/catalog.ts                                  │
 * │   taghunter_playground/src/fonts/catalog.ts                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * `system` fonts need no file — they rely on the OS. `bundled` fonts ship as
 * files in each project's `public/fonts/` directory (served at `/fonts/<file>`)
 * so the offline Tauri playground renders them without a network.
 *
 * To add a font: drop the file(s) into both `public/fonts/` dirs and add an
 * entry here (in both copies).
 *
 * Plan: C:\Users\faure\.claude\plans\studio-custom-fonts-typography.md
 */

export type FontGroup = 'standard' | 'themed';

export interface CatalogFontFace {
  /** Filename under `public/fonts/`, e.g. `zombie.ttf`. */
  file: string;
  /** CSS `@font-face` `format()` token. */
  format: 'truetype' | 'opentype' | 'woff' | 'woff2';
  weight: number;
  style: 'normal' | 'italic';
}

export interface CatalogFont {
  /** Identifier stored in `game_meta.font`; also the CSS family name. */
  family: string;
  /** Human-readable label shown in the picker. */
  label: string;
  /** Picker grouping. */
  group: FontGroup;
  /** Full CSS `font-family` stack applied at render time (with fallbacks). */
  stack: string;
  /**
   * Bundled faces. Omitted for system fonts. When present,
   * `registerCatalogFonts()` emits one `@font-face` rule per face.
   */
  faces?: CatalogFontFace[];
}

const ttf = (file: string, weight = 400, style: 'normal' | 'italic' = 'normal'): CatalogFontFace => ({
  file,
  format: 'truetype',
  weight,
  style,
});
const otf = (file: string, weight = 400, style: 'normal' | 'italic' = 'normal'): CatalogFontFace => ({
  file,
  format: 'opentype',
  weight,
  style,
});

/**
 * The curated catalog. `standard` fonts come first (system + a clean bundled
 * sans), then `themed` display fonts carried over from the legacy escape-game.
 */
export const FONT_CATALOG: readonly CatalogFont[] = [
  // ---- Standard: system fonts (no file needed) ----
  { family: 'Arial', label: 'Arial', group: 'standard', stack: 'Arial, Helvetica, sans-serif' },
  { family: 'Arial Black', label: 'Arial Black', group: 'standard', stack: '"Arial Black", Gadget, sans-serif' },
  { family: 'Verdana', label: 'Verdana', group: 'standard', stack: 'Verdana, Geneva, sans-serif' },
  { family: 'Tahoma', label: 'Tahoma', group: 'standard', stack: 'Tahoma, Geneva, sans-serif' },
  { family: 'Trebuchet MS', label: 'Trebuchet MS', group: 'standard', stack: '"Trebuchet MS", Helvetica, sans-serif' },
  { family: 'Impact', label: 'Impact', group: 'standard', stack: 'Impact, Charcoal, sans-serif' },
  { family: 'Georgia', label: 'Georgia', group: 'standard', stack: 'Georgia, "Times New Roman", serif' },
  { family: 'Times New Roman', label: 'Times New Roman', group: 'standard', stack: '"Times New Roman", Times, serif' },
  { family: 'Courier New', label: 'Courier New', group: 'standard', stack: '"Courier New", Courier, monospace' },
  { family: 'Comic Sans MS', label: 'Comic Sans MS', group: 'standard', stack: '"Comic Sans MS", "Comic Sans", cursive' },
  { family: 'Palatino Linotype', label: 'Palatino Linotype', group: 'standard', stack: '"Palatino Linotype", "Book Antiqua", Palatino, serif' },
  { family: 'Lucida Sans', label: 'Lucida Sans', group: 'standard', stack: '"Lucida Sans Unicode", "Lucida Grande", sans-serif' },

  // ---- Standard: bundled clean sans ----
  {
    family: 'Glacial Indifference',
    label: 'Glacial Indifference',
    group: 'standard',
    stack: '"Glacial Indifference", "Trebuchet MS", sans-serif',
    faces: [otf('glacial-indifference.otf', 400), otf('glacial-indifference-bold.otf', 700)],
  },

  // ---- Themed: legacy escape-game display fonts ----
  { family: 'Zombie', label: 'Zombie', group: 'themed', stack: '"Zombie", "Arial Black", sans-serif', faces: [ttf('zombie.ttf')] },
  { family: 'Zombie Blood', label: 'Zombie Blood', group: 'themed', stack: '"Zombie Blood", "Arial Black", sans-serif', faces: [ttf('zombie-blood.ttf')] },
  { family: 'Spider', label: 'Spider', group: 'themed', stack: '"Spider", "Arial Black", sans-serif', faces: [ttf('spider.ttf')] },
  { family: 'Mortified Drip', label: 'Mortified Drip', group: 'themed', stack: '"Mortified Drip", "Arial Black", sans-serif', faces: [ttf('mortified-drip.ttf')] },
  { family: 'October Crow', label: 'October Crow', group: 'themed', stack: '"October Crow", "Arial Black", sans-serif', faces: [ttf('october-crow.ttf')] },
  { family: 'Ancient Medium', label: 'Ancient Medium', group: 'themed', stack: '"Ancient Medium", Georgia, serif', faces: [ttf('ancient-medium.ttf')] },
  {
    family: 'Trajan Pro',
    label: 'Trajan Pro',
    group: 'themed',
    stack: '"Trajan Pro", Georgia, serif',
    faces: [ttf('trajan-pro.ttf', 400), otf('trajan-pro-bold.otf', 700)],
  },
  { family: 'Stranger Things', label: 'Stranger Things', group: 'themed', stack: '"Stranger Things", "Arial Black", sans-serif', faces: [ttf('stranger-things.ttf')] },
  { family: 'Stranger', label: 'Stranger', group: 'themed', stack: '"Stranger", "Arial Black", sans-serif', faces: [ttf('stranger.ttf')] },
  { family: 'Monsters', label: 'Monsters', group: 'themed', stack: '"Monsters", "Arial Black", sans-serif', faces: [ttf('monsters.ttf')] },
  { family: 'Monster', label: 'Monster', group: 'themed', stack: '"Monster", "Arial Black", sans-serif', faces: [ttf('monster.ttf')] },
  { family: 'Caribbean', label: 'Caribbean', group: 'themed', stack: '"Caribbean", Georgia, serif', faces: [ttf('caribbean.ttf')] },
  {
    family: 'Another Danger',
    label: 'Another Danger',
    group: 'themed',
    stack: '"Another Danger", "Arial Black", sans-serif',
    faces: [otf('another-danger.otf', 400, 'normal'), otf('another-danger-slanted.otf', 400, 'italic')],
  },
];

/** Lower-cased family → catalog entry, for case-insensitive lookups. */
const BY_FAMILY: ReadonlyMap<string, CatalogFont> = new Map(
  FONT_CATALOG.map((f) => [f.family.toLowerCase(), f]),
);

/** Case-insensitive catalog lookup by family name. */
export function findCatalogFont(family: string | null | undefined): CatalogFont | undefined {
  if (!family) return undefined;
  return BY_FAMILY.get(family.trim().toLowerCase());
}
