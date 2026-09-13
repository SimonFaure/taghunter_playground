/**
 * Tagquest HUD typography - runtime half of the studio's author-facing font
 * size + colour categories (retours #1 / #2).
 *
 * MIRROR of:
 *   ../../../../studio-taghunter/src/scenarios/bodies/tagquest/typographyCategories.ts
 * The ids, the matchers and the resolution rule must stay identical, or the
 * studio preview lies about what the game will draw. The studio file carries
 * the full rationale; the short version:
 *
 *   - a category holds a SCALE in percent (100 = the size authored in
 *     defaultLayout.json), not an absolute size, because elements inside one
 *     category have different authored sizes (combo multiplicator 25 vs combo
 *     points 31) and those proportions must survive;
 *   - the layout's sizes are authored against a 1920-wide stage and the caller
 *     multiplies by `stage.width / 1920`, so the result is resolution
 *     independent.
 *
 * Read from `game_meta.tagquest_typography`; absent on every scenario authored
 * before this feature, which resolves to "exactly as before".
 */

export type TagquestTextCategoryId =
  | 'chrome_titles'
  | 'malus_data'
  | 'combo_titles'
  | 'combo_data'
  | 'quest_titles'
  | 'quest_data'
  | 'active_quest_name'
  | 'timer'
  | 'team_name'
  | 'score_title'
  | 'score_data';

export interface TagquestTextStyle {
  /** Font size as a percentage of the authored size. 100 = unchanged. */
  size?: number;
  /** Hex colour (`#rrggbb`). Absent = the layout element's own colour. */
  color?: string;
  /** Colour painted behind the text's own box. Absent = nothing drawn. */
  background?: string;
}

export type TagquestTypography = Partial<Record<TagquestTextCategoryId, TagquestTextStyle>>;

const CATEGORY_MATCHERS: readonly { id: TagquestTextCategoryId; match: (id: string) => boolean }[] = [
  { id: 'timer', match: (id) => id === 'timer' },
  { id: 'team_name', match: (id) => id === 'team_name_text' },
  { id: 'score_title', match: (id) => id === 'score_label' },
  { id: 'score_data', match: (id) => id === 'score' },
  {
    id: 'chrome_titles',
    match: (id) => id === 'malus_label' || id === 'late_malus_label' || id === 'combo_points_label',
  },
  { id: 'malus_data', match: (id) => /^(late_)?malus_(multiplicator|points)$/.test(id) },
  { id: 'combo_titles', match: (id) => /^combo_[642]_title$/.test(id) },
  { id: 'combo_data', match: (id) => /^combo_[642]_(multiplicator|points)$/.test(id) },
  // Anchored so it never swallows `animation_quest_name`.
  { id: 'quest_titles', match: (id) => /^quest_\d+_name$/.test(id) },
  { id: 'quest_data', match: (id) => /^quest_\d+_(multiplicator|points)$/.test(id) },
  { id: 'active_quest_name', match: (id) => id === 'animation_quest_name' },
];

export function tagquestTextCategoryFor(elementId: string): TagquestTextCategoryId | null {
  const id = (elementId || '').toLowerCase();
  for (const cat of CATEGORY_MATCHERS) {
    if (cat.match(id)) return cat.id;
  }
  return null;
}

/** Percent → multiplier, clamped. Anything unusable reads as 100 %. */
export function tagquestSizeFactor(size: number | undefined): number {
  if (size == null) return 1;
  const n = typeof size === 'number' ? size : Number(size);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(400, Math.max(25, n)) / 100;
}

/** Read `game_meta.tagquest_typography` defensively (it is synced authored JSON). */
export function readTagquestTypography(value: unknown): TagquestTypography {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const src = value as Record<string, unknown>;
  const out: TagquestTypography = {};
  for (const { id } of CATEGORY_MATCHERS) {
    const raw = src[id];
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const style: TagquestTextStyle = {};
    if (typeof rec.size === 'number' || typeof rec.size === 'string') {
      const n = Number(rec.size);
      if (Number.isFinite(n) && n > 0) style.size = n;
    }
    if (typeof rec.color === 'string' && rec.color.trim()) style.color = rec.color.trim();
    if (typeof rec.background === 'string' && rec.background.trim()) {
      style.background = rec.background.trim();
    }
    if (style.size !== undefined || style.color !== undefined || style.background !== undefined) {
      out[id] = style;
    }
  }
  return out;
}

/**
 * Resolve one layout text element's final size + colour. `baseFontSize` is the
 * element's authored `fontSize` (still against the 1920-wide canonical stage -
 * the caller applies the stage scaling afterwards).
 */
export function resolveTagquestTextStyle(
  elementId: string,
  typography: TagquestTypography | undefined,
  baseFontSize: number | undefined,
  baseColor: string | undefined,
): { fontSize: number | undefined; color: string | undefined; background: string | undefined } {
  const catId = tagquestTextCategoryFor(elementId);
  const style = catId && typography ? typography[catId] : undefined;
  const factor = tagquestSizeFactor(style?.size);
  return {
    fontSize: baseFontSize != null ? baseFontSize * factor : undefined,
    color: style?.color || baseColor,
    background: style?.background || undefined,
  };
}

/**
 * Lay a scenario's typography over the studio-wide defaults, FIELD BY FIELD.
 * The defaults arrive in the sync manifest as the `default_typography_tagquest`
 * admin config row; the scenario's own `game_meta.tagquest_typography` wins
 * field by field, so a default colour survives a scenario that only sets a size.
 */
export function mergeTagquestTypography(
  defaults: TagquestTypography | undefined,
  scenario: TagquestTypography | undefined,
): TagquestTypography {
  if (!defaults) return scenario ?? {};
  if (!scenario) return defaults;
  const out: TagquestTypography = { ...defaults };
  for (const [id, style] of Object.entries(scenario) as [
    TagquestTextCategoryId,
    TagquestTextStyle,
  ][]) {
    out[id] = { ...(out[id] ?? {}), ...style };
  }
  return out;
}
