/**
 * Studio-wide DEFAULT POSITIONS for the Tagquest HUD.
 *
 * Quest's HUD geometry is authored in code - `defaultLayout.ts` in the studio,
 * mirrored as `defaultLayout.json` bundled in the playground - and there has
 * never been a per-scenario layout for it. So "move the timer 2 % left" meant a
 * code change and a release. This module is the seam that makes those positions
 * author-editable without giving every scenario its own layout:
 *
 *   the bundled layout is the SKELETON (ids, artwork, font sizes, preview text)
 *   and an admin-authored override map supplies x / y / width / height per id.
 *
 * Overriding per id rather than storing the whole element array is deliberate:
 * a saved blob from an older layout version then still works, because elements
 * added to the skeleton since keep their code-authored geometry instead of
 * vanishing. An unknown id in the blob is ignored for the same reason.
 *
 * Authored on the studio admin "Default layouts" page, stored in the
 * `default_config` row `default_layout_tagquest`, and shipped to the playground
 * in the sync manifest alongside the admin translation rows.
 *
 * THIS FILE IS MIRRORED - keep the two byte-identical:
 *   studio-taghunter/src/scenarios/bodies/tagquest/layoutOverrides.ts
 *   taghunter_playground/src/scenarios/tagquest/layoutOverrides.ts
 */

/**
 * A width/height value. Numbers are percentages of the 16:9 stage box; the CSS
 * keywords pass through verbatim (`'auto'` on the two malus icons lets the
 * browser derive the other side from the artwork's aspect ratio).
 */
export type TagquestDim = number | 'auto' | 'fit-content' | 'min-content' | 'max-content';

/** Geometry override for one layout element. Absent field = keep the skeleton's. */
export interface TagquestElementOverride {
  x?: number;
  y?: number;
  width?: TagquestDim;
  height?: TagquestDim;
}

/** The stored blob: element id → geometry override, plus HUD-wide knobs. */
export interface TagquestLayoutOverrides {
  elements: Record<string, TagquestElementOverride>;
  /**
   * Inner margin of the COMPLETED main image inside the `animation_quest_image`
   * box, as a percentage of that box's shorter side, applied on all four sides.
   *
   * The status colour on quest artwork is a `drop-shadow` glow that follows the
   * image's alpha rather than a rectangle (retours #61 + #100 - see the halo
   * block in the playground's TagQuestGamePage). A glow needs room: on artwork
   * that fills its square the green/red bleeds past the box and over the
   * template frame. This insets the image so the glow lands inside the box.
   *
   * The four reveal slots are deliberately NOT affected: their cells are already
   * a fitted grid and shrinking them would open gaps between quadrants that are
   * authored to meet in the middle.
   *
   * Absent / 0 = the historical flush geometry.
   */
  mainImageMargin?: number;
}

export const EMPTY_TAGQUEST_LAYOUT_OVERRIDES: TagquestLayoutOverrides = { elements: {} };

/** Upper bound on the inner margin: half the box would leave nothing to draw. */
export const TAGQUEST_MAIN_IMAGE_MARGIN_MAX = 40;

const DIM_KEYWORDS = ['auto', 'fit-content', 'min-content', 'max-content'] as const;

/** Percent positions are clamped well outside the stage so an element can be
 *  parked off-canvas deliberately, but never to a value that loses it forever. */
function readPercent(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return undefined;
  return Math.max(-100, Math.min(200, n));
}

function readDim(v: unknown): TagquestDim | undefined {
  if (typeof v === 'string') {
    const s = v.trim();
    if ((DIM_KEYWORDS as readonly string[]).includes(s)) return s as TagquestDim;
  }
  const n = readPercent(v);
  if (n === undefined) return undefined;
  // A zero-size element is indistinguishable from a bug; keep a visible floor.
  return Math.max(0.1, n);
}

/**
 * Parse the stored blob defensively - it is authored JSON that arrives over the
 * sync manifest, so every field is suspect. Accepts both `{ elements: {...} }`
 * and a bare `{ <id>: {...} }` map (what a hand-written row is likely to be).
 */
export function readTagquestLayoutOverrides(value: unknown): TagquestLayoutOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return EMPTY_TAGQUEST_LAYOUT_OVERRIDES;
  }
  const root = value as Record<string, unknown>;
  const rawElements =
    root.elements && typeof root.elements === 'object' && !Array.isArray(root.elements)
      ? (root.elements as Record<string, unknown>)
      : root;
  const marginRaw = readPercent(root.mainImageMargin);
  const mainImageMargin =
    marginRaw === undefined
      ? undefined
      : Math.max(0, Math.min(TAGQUEST_MAIN_IMAGE_MARGIN_MAX, marginRaw));
  const elements: Record<string, TagquestElementOverride> = {};
  for (const [id, raw] of Object.entries(rawElements)) {
    if (!id || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    const out: TagquestElementOverride = {};
    const x = readPercent(rec.x);
    const y = readPercent(rec.y);
    const width = readDim(rec.width);
    const height = readDim(rec.height);
    if (x !== undefined) out.x = x;
    if (y !== undefined) out.y = y;
    if (width !== undefined) out.width = width;
    if (height !== undefined) out.height = height;
    if (Object.keys(out).length > 0) elements[id] = out;
  }
  return mainImageMargin ? { elements, mainImageMargin } : { elements };
}

/**
 * Pixel inset the completed main image is pushed in by, given the pixel size of
 * its layout box. Shared so the studio preview and the playground compute the
 * SAME inset from the same percentage: the box is not square in the layout
 * (40 % × 60 %), so anchoring the margin to the SHORTER side is what makes the
 * number mean one thing in both.
 */
export function tagquestMainImageInsetPx(
  overrides: TagquestLayoutOverrides | undefined,
  boxWidthPx: number,
  boxHeightPx: number,
): number {
  const m = overrides?.mainImageMargin ?? 0;
  if (!m || boxWidthPx <= 0 || boxHeightPx <= 0) return 0;
  return Math.min(boxWidthPx, boxHeightPx) * (m / 100);
}

/** The shape this module needs from a layout element; both repos' types satisfy it. */
interface GeometryCarrier {
  id?: string;
  x?: number;
  y?: number;
  width?: TagquestDim;
  height?: TagquestDim;
}

/**
 * Apply the override map to a skeleton element list. Returns the SAME array
 * instance when nothing is overridden, so callers can keep it in a memo without
 * re-rendering the whole HUD on every pass.
 */
export function applyTagquestLayoutOverrides<T extends GeometryCarrier>(
  elements: readonly T[],
  overrides: TagquestLayoutOverrides | undefined,
): T[] {
  const map = overrides?.elements;
  if (!map || Object.keys(map).length === 0) return elements as T[];
  return elements.map((el) => {
    const o = el.id ? map[el.id] : undefined;
    if (!o) return el;
    return {
      ...el,
      ...(o.x !== undefined ? { x: o.x } : {}),
      ...(o.y !== undefined ? { y: o.y } : {}),
      ...(o.width !== undefined ? { width: o.width } : {}),
      ...(o.height !== undefined ? { height: o.height } : {}),
    };
  });
}

/**
 * Drop an element's override when it is back to the skeleton's own geometry, so
 * "reset" really removes the row instead of freezing today's code values into
 * the blob. Used by the editor before saving.
 */
export function pruneTagquestLayoutOverrides<T extends GeometryCarrier>(
  skeleton: readonly T[],
  overrides: TagquestLayoutOverrides,
): TagquestLayoutOverrides {
  // This returns a FRESH blob, so any HUD-wide knob not carried across here
  // would be silently dropped the first time an admin saves.
  const mainImageMargin = overrides.mainImageMargin || undefined;
  const byId = new Map(skeleton.filter((e) => e.id).map((e) => [e.id as string, e]));
  const elements: Record<string, TagquestElementOverride> = {};
  for (const [id, o] of Object.entries(overrides.elements)) {
    const base = byId.get(id);
    if (!base) continue;
    const out: TagquestElementOverride = {};
    if (o.x !== undefined && o.x !== base.x) out.x = o.x;
    if (o.y !== undefined && o.y !== base.y) out.y = o.y;
    if (o.width !== undefined && o.width !== base.width) out.width = o.width;
    if (o.height !== undefined && o.height !== base.height) out.height = o.height;
    if (Object.keys(out).length > 0) elements[id] = out;
  }
  return mainImageMargin ? { elements, mainImageMargin } : { elements };
}
