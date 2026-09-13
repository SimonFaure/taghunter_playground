/**
 * Mystery in-game layout - shared types, defaults, and the placed-box renderer
 * for the 4 author-positioned text roles (enigma name, timer, score, team name).
 *
 * The 4 boxes are stored as a keyed map in `game_meta.ingame_layout`, each a
 * rectangle in % of the 1920×1080 canonical stage plus an optional horizontal
 * `align`. Font size is driven by the box dimensions: the largest single-line
 * font that fits both width and height (so long team names shrink to fit) - the
 * same O(1) `measureText` approach as TracksTextFit.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ DUPLICATED VERBATIM - keep in sync:                                      │
 * │   studio-taghunter/src/scenarios/preview/mysteryIngameLayout.tsx         │
 * │   taghunter_playground/src/components/mysteryIngameLayout.tsx            │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Plan: C:\Users\faure\.claude\plans\mystery-ingame-layout-editor.md
 */

import { useLayoutEffect, useState } from 'react';

export type IngameAlign = 'left' | 'center' | 'right';

/** One placed text box, in % of the canonical 1920×1080 stage. */
export interface IngameBox {
  left: number; // 0–100 (% of canonical width)
  top: number; // 0–100 (% of canonical height)
  width: number; // 0–100 (% of canonical width)
  height: number; // 0–100 (% of canonical height)
  align?: IngameAlign; // default 'center'
}

/** Fixed-role keyed map stored at game_meta.ingame_layout. */
export interface IngameLayout {
  enigma_name?: IngameBox;
  timer?: IngameBox;
  score?: IngameBox;
  team_name?: IngameBox;
}

export type IngameRoleKey = 'enigma_name' | 'timer' | 'score' | 'team_name';

/** Role metadata: display label + which gameMeta frame image sits behind it
 *  (enigma_name has no frame - it floats as plain text). */
export const INGAME_ROLES: ReadonlyArray<{
  key: IngameRoleKey;
  label: string;
  frameImageKey?: 'time_background_image' | 'score_background_image' | 'team_name_background_image';
}> = [
  { key: 'enigma_name', label: 'Enigma name' },
  { key: 'timer', label: 'Timer', frameImageKey: 'time_background_image' },
  { key: 'score', label: 'Score', frameImageKey: 'score_background_image' },
  { key: 'team_name', label: 'Team name', frameImageKey: 'team_name_background_image' },
];

/**
 * Default placement used whenever a scenario has no (or a partial)
 * `ingame_layout`. Positions approximate the historical 3-column grid look:
 * timer + score stacked top-left, team name top-right, enigma name centred top.
 */
export const DEFAULT_INGAME_LAYOUT: Required<IngameLayout> = {
  enigma_name: { left: 30, top: 3, width: 40, height: 10, align: 'center' },
  timer: { left: 3, top: 3, width: 22, height: 9, align: 'center' },
  score: { left: 3, top: 14, width: 22, height: 9, align: 'center' },
  team_name: { left: 75, top: 3, width: 22, height: 9, align: 'center' },
};

/** Merge a scenario's (possibly absent/partial) layout over the defaults so the
 *  renderer always has all 4 boxes. */
export function resolveIngameLayout(layout: IngameLayout | undefined | null): Required<IngameLayout> {
  const l = layout ?? {};
  return {
    enigma_name: { ...DEFAULT_INGAME_LAYOUT.enigma_name, ...(l.enigma_name ?? {}) },
    timer: { ...DEFAULT_INGAME_LAYOUT.timer, ...(l.timer ?? {}) },
    score: { ...DEFAULT_INGAME_LAYOUT.score, ...(l.score ?? {}) },
    team_name: { ...DEFAULT_INGAME_LAYOUT.team_name, ...(l.team_name ?? {}) },
  };
}

/** Drop-shadow applied to in-game text (matches the historical renderer). */
const INGAME_TEXT_SHADOW = '0 1px 4px rgba(0,0,0,0.7)';

// Reusable offscreen 2D context for text measurement. Created lazily; only
// used synchronously inside a layout effect.
let cachedCtx: CanvasRenderingContext2D | null = null;
function getMeasurementContext(): CanvasRenderingContext2D | null {
  if (cachedCtx) return cachedCtx;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  cachedCtx = canvas.getContext('2d');
  return cachedCtx;
}

/**
 * Largest font-size (px) where a single line of `text` fits both box width and
 * box height. Bold weight (700) is baked in for the canvas measurement.
 *   - Width:  `(f / 100) * widthAt100 ≤ boxW`
 *   - Height: `f ≤ boxH`
 */
function fitFontSizePx(text: string, fontFamily: string, boxW: number, boxH: number, minPx: number): number {
  const ctx = getMeasurementContext();
  if (!ctx || !text) return Math.max(minPx, Math.min(boxH, 16));
  ctx.font = `700 100px ${fontFamily || 'sans-serif'}`;
  const w = ctx.measureText(text).width;
  if (w <= 0) return Math.max(minPx, boxH);
  return Math.max(minPx, Math.min(boxW / (w / 100), boxH));
}

export interface MysteryLayoutBoxProps {
  box: IngameBox;
  /** Stage dimensions in px (the fit box the % positions resolve against). */
  stageWidth: number;
  stageHeight: number;
  text: string;
  fontFamily: string;
  color: string;
  minPx?: number;
}

/**
 * One absolutely-positioned in-game text box: auto-fit single-line text only
 * (the texts are what authors place - frame images are not part of this box).
 * Positioned by % of the stage. Used identically by the studio preview, the
 * layout editor, and the playground runtime so all three render WYSIWYG.
 */
export function MysteryLayoutBox({
  box,
  stageWidth,
  stageHeight,
  text,
  fontFamily,
  color,
  minPx = 6,
}: MysteryLayoutBoxProps) {
  const boxWidthPx = (box.width / 100) * stageWidth;
  const boxHeightPx = (box.height / 100) * stageHeight;
  const [fontSize, setFontSize] = useState(minPx);

  useLayoutEffect(() => {
    if (boxWidthPx <= 0 || boxHeightPx <= 0) {
      setFontSize(minPx);
      return;
    }
    setFontSize(fitFontSizePx(text, fontFamily, boxWidthPx, boxHeightPx, minPx));
  }, [text, fontFamily, boxWidthPx, boxHeightPx, minPx]);

  const align = box.align ?? 'center';
  const justifyContent = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';

  return (
    <div
      style={{
        position: 'absolute',
        left: `${box.left}%`,
        top: `${box.top}%`,
        width: `${box.width}%`,
        height: `${box.height}%`,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent,
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            // Applied explicitly (not just inherited) so the text renders in the
            // scenario font even outside a stage that sets it - e.g. the layout
            // editor's draggable boxes, which sit on plain UI chrome.
            fontFamily: fontFamily || undefined,
            fontWeight: 700,
            color,
            fontSize: `${fontSize}px`,
            lineHeight: 1,
            whiteSpace: 'nowrap',
            textShadow: INGAME_TEXT_SHADOW,
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
}

/* ───────────────────────────── Idle screen ─────────────────────────────────
 * The "idle" screen is what the playground shows between teams (background only)
 * when "reveal results on Enter/click" is OFF. Authors may place up to two fully
 * styled text elements over the background: the scenario TITLE (text = scenario
 * name) and a SUBTITLE (text = a per-launch custom string). Unlike the in-game
 * boxes, idle elements carry their OWN typography (font / explicit size / color)
 * and are independently togg-able via `enabled`. Stored at game_meta.idle_layout.
 * ──────────────────────────────────────────────────────────────────────────── */

export type IdleRoleKey = 'title' | 'subtitle';

/** One placed, styled idle text element (% of the canonical 1920×1080 stage). */
export interface IdleElement {
  enabled: boolean; // togg-able add/remove - false ⇒ not drawn
  left: number; // 0–100 (% of canonical width)
  top: number; // 0–100 (% of canonical height)
  width: number; // 0–100 (% of canonical width)
  height: number; // 0–100 (% of canonical height)
  align?: IngameAlign; // default 'center'
  font?: string; // family name; '' ⇒ inherit the scenario font (game_meta.font)
  fontSizePct?: number; // explicit size as % of stage height (NOT box-fit)
  color?: string; // '' ⇒ inherit the scenario font_color
}

/** Fixed-role keyed map stored at game_meta.idle_layout. */
export interface IdleLayout {
  title?: IdleElement;
  subtitle?: IdleElement;
}

/** Role metadata for the idle screen: display label per element. */
export const IDLE_ROLES: ReadonlyArray<{ key: IdleRoleKey; label: string }> = [
  { key: 'title', label: 'Title' },
  { key: 'subtitle', label: 'Subtitle' },
];

/**
 * Default idle placement: title centred in the upper third, subtitle just below.
 * Both start DISABLED so a scenario with no authored idle_layout shows only the
 * background (the historical behaviour) until the author adds an element.
 */
export const DEFAULT_IDLE_LAYOUT: Required<IdleLayout> = {
  title: { enabled: false, left: 15, top: 28, width: 70, height: 16, align: 'center', font: '', fontSizePct: 9, color: '' },
  subtitle: { enabled: false, left: 20, top: 46, width: 60, height: 10, align: 'center', font: '', fontSizePct: 4.5, color: '' },
};

/** Merge a scenario's (possibly absent/partial) idle layout over the defaults so
 *  the renderer always has both complete elements. */
export function resolveIdleLayout(layout: IdleLayout | undefined | null): Required<IdleLayout> {
  const l = layout ?? {};
  return {
    title: { ...DEFAULT_IDLE_LAYOUT.title, ...(l.title ?? {}) },
    subtitle: { ...DEFAULT_IDLE_LAYOUT.subtitle, ...(l.subtitle ?? {}) },
  };
}

export interface MysteryIdleBoxProps {
  element: IdleElement;
  /** Stage height in px - the explicit font size resolves against it
   *  (`fontSizePct%` of it). Position/width use %, so stage width isn't needed. */
  stageHeight: number;
  text: string;
  /** Scenario-wide fallbacks used when the element leaves font/color blank. */
  fallbackFontFamily: string;
  fallbackColor: string;
  /** Resolve a font family-name to a CSS stack (studio + playground both pass
   *  their `resolveFontFamily`). When omitted the family name is used verbatim. */
  resolveFont?: (family: string) => string;
}

/**
 * One absolutely-positioned idle text element with EXPLICIT (author-set) font
 * size - no auto-fit. Text wraps inside the box width and is vertically centred,
 * horizontally aligned per `align`. Used identically by the studio preview, the
 * layout editor, and the playground runtime so all three render WYSIWYG.
 */
export function MysteryIdleBox({
  element,
  stageHeight,
  text,
  fallbackFontFamily,
  fallbackColor,
  resolveFont,
}: MysteryIdleBoxProps) {
  const align = element.align ?? 'center';
  const justifyContent = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
  const textAlign = align;
  // Idle text always uses the scenario font (same as the in-game HUD UI strings) -
  // there is no per-element font override.
  void resolveFont;
  const family = fallbackFontFamily;
  const color = element.color || fallbackColor;
  const fontSizePx = ((element.fontSizePct ?? 5) / 100) * stageHeight;

  return (
    <div
      style={{
        position: 'absolute',
        left: `${element.left}%`,
        top: `${element.top}%`,
        width: `${element.width}%`,
        height: `${element.height}%`,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent,
        }}
      >
        <span
          style={{
            fontFamily: family || undefined,
            fontWeight: 700,
            color,
            fontSize: `${fontSizePx}px`,
            lineHeight: 1.1,
            whiteSpace: 'normal',
            textAlign,
            textShadow: INGAME_TEXT_SHADOW,
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
}

/* ──────────────────────────── Element frames ───────────────────────────────
 * The timer / score / team-name frame images used to be pinned to each role's
 * DEFAULT text box, which is why they came out tiny and un-callable in the
 * studio preview (retour #42) - a wide plate `contain`-fitted into a 22%×9% box
 * shrinks to the box height. They are now placed independently of the text, in
 * `game_meta.ingame_frames`, so the author can size and position each plate and
 * then drop the text wherever they want inside it.
 *
 * Absent / partial → the historical default boxes, so every scenario authored
 * before this renders exactly as it did.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The roles that own a frame image. `enigma_name` floats as plain text. */
export const FRAME_ROLES = INGAME_ROLES.filter((r) => r.frameImageKey) as ReadonlyArray<{
  key: IngameRoleKey;
  label: string;
  frameImageKey: 'time_background_image' | 'score_background_image' | 'team_name_background_image';
}>;

/** Placed frame rectangles stored at game_meta.ingame_frames. */
export interface IngameFrames {
  timer?: IngameBox;
  score?: IngameBox;
  team_name?: IngameBox;
  bonus?: IngameBox;
}

export type IngameFrameKey = 'timer' | 'score' | 'team_name' | 'bonus';

/**
 * The bonus ("overscore") plate - the empty-bonus image plus whichever tier the
 * team has unlocked - used to be locked to the left cell of the board grid, so
 * an author could neither move it nor resize it. It is a placed image block like
 * the frames, so it is stored with them, as `ingame_frames.bonus`.
 *
 * DEFAULT_BONUS_BOX reproduces that grid cell exactly, in % of the canonical
 * stage: the board area is inset by the stage's 2 % padding, starts under the
 * 12 % title band and stops above the 19 % gauge strip (0.18 + 0.01 margin);
 * horizontally the grid is `1fr 2fr 1fr` with two 1.5 % gaps, so the left cell
 * is (96 - 3) / 4 = 23.25 % wide. A scenario that never touched it renders
 * exactly where it always did.
 */
export const DEFAULT_BONUS_BOX: IngameBox = { left: 2, top: 14, width: 23.25, height: 65 };

/** Bonus plate role metadata - listed alongside FRAME_ROLES in the layout
 *  editor (it is an image block, not one of the text roles). */
export const BONUS_FRAME_ROLE: { key: 'bonus'; label: string; frameImageKey: 'steps_container_image' } = {
  key: 'bonus',
  label: 'Bonus',
  frameImageKey: 'steps_container_image',
};

/** Merge a scenario's (possibly absent/partial) frame boxes over the historical
 *  fixed positions - which are the text roles' default boxes, plus the bonus
 *  plate's former grid cell. */
export function resolveIngameFrames(frames: IngameFrames | undefined | null): Record<IngameFrameKey, IngameBox> {
  const f = frames ?? {};
  return {
    timer: { ...DEFAULT_INGAME_LAYOUT.timer, ...(f.timer ?? {}) },
    score: { ...DEFAULT_INGAME_LAYOUT.score, ...(f.score ?? {}) },
    team_name: { ...DEFAULT_INGAME_LAYOUT.team_name, ...(f.team_name ?? {}) },
    bonus: { ...DEFAULT_BONUS_BOX, ...(f.bonus ?? {}) },
  };
}

/** The bonus plate's rectangle for a scenario, defaults merged in. */
export function resolveMysteryBonusBox(frames: IngameFrames | undefined | null): IngameBox {
  return { ...DEFAULT_BONUS_BOX, ...((frames ?? {}).bonus ?? {}) };
}

export interface MysteryFixedFramesProps {
  /** role → resolved frame image URL. Roles without a frame are omitted. */
  frameUrls: Partial<Record<IngameRoleKey, string>>;
  /** Author-placed frame rectangles. Absent → the historical default boxes. */
  frames?: IngameFrames | null;
}

/**
 * Element frame images, drawn behind the author-placed text at the rectangles
 * stored in `game_meta.ingame_frames`. enigma_name has no frame.
 */
export function MysteryFixedFrames({ frameUrls, frames }: MysteryFixedFramesProps) {
  const placed = resolveIngameFrames(frames);
  return (
    <>
      {INGAME_ROLES.map((role) => {
        const url = frameUrls[role.key];
        if (!url) return null;
        const box = placed[role.key as IngameFrameKey] ?? DEFAULT_INGAME_LAYOUT[role.key];
        return (
          <div
            key={role.key}
            style={{
              position: 'absolute',
              left: `${box.left}%`,
              top: `${box.top}%`,
              width: `${box.width}%`,
              height: `${box.height}%`,
              pointerEvents: 'none',
            }}
          >
            <img
              src={url}
              alt=""
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
            />
          </div>
        );
      })}
    </>
  );
}

/* ─────────────────────────── Level-gauge geometry ───────────────────────────
 * The gauge is three stacked layers: the empty gauge WITH its background
 * (`levels_gauge_image`), the coloured fill, then the same empty gauge WITHOUT
 * background (`levels_gauge_image_with_content`) on top so the fill shows
 * through its transparent interior.
 *
 * Where the fill starts and stops inside that frame used to be hard-coded
 * (a px inset derived from the stage height), which never lined up with an
 * author's own gauge artwork - visibly so on the left edge (retour #31). Four
 * optional game_meta fields now tune it, and the level icons + player icon read
 * the same numbers so they keep tracking the fill exactly:
 *
 *   gauge_fill_inset_left  - % of the gauge bar width
 *   gauge_fill_inset_right - % of the gauge bar width
 *   gauge_fill_inset_y     - % of the gauge bar height (top AND bottom)
 *   gauge_fill_radius      - corner radius in px
 *
 * Blank/absent → the historical values, so untouched scenarios don't move.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface MysteryGaugeGeometryMeta {
  gauge_fill_inset_left?: string | number;
  gauge_fill_inset_right?: string | number;
  gauge_fill_inset_y?: string | number;
  gauge_fill_radius?: string | number;
}

export interface MysteryGaugeGeometry {
  /** Height of the gauge bar box, in px. */
  barHeight: number;
  /** Height of a level / player icon, in px. */
  iconHeight: number;
  /** CSS lengths for the fill track's insets (px or %, per what was authored). */
  insetLeft: string;
  insetRight: string;
  insetY: string;
  radius: number;
  /** CSS `left` placing a point at `fraction` (0..1) along the fill track. */
  trackLeft: (fraction: number) => string;
  /** CSS `width` for a fill covering `fraction` (0..1) of the track. */
  trackWidth: (fraction: number) => string;
  /** CSS `height` for something spanning the track vertically. */
  trackHeight: string;
}

/** Parse an authored numeric field; null on blank/garbage so the legacy value wins. */
function gaugeNum(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export function resolveMysteryGaugeGeometry(
  meta: MysteryGaugeGeometryMeta | null | undefined,
  stageHeight: number,
): MysteryGaugeGeometry {
  const m = meta ?? {};
  const barHeight = stageHeight * 0.08;
  const iconHeight = barHeight - 14;
  // Historical inset: half an icon (so a 0%/100% icon sits inside the frame)
  // plus 8px of breathing room.
  const legacyInsetPx = iconHeight / 2 + 8;

  const left = gaugeNum(m.gauge_fill_inset_left);
  const right = gaugeNum(m.gauge_fill_inset_right);
  const insetY = gaugeNum(m.gauge_fill_inset_y);

  const insetLeft = left === null ? `${legacyInsetPx}px` : `${left}%`;
  const insetRight = right === null ? `${legacyInsetPx}px` : `${right}%`;
  const insetYCss = insetY === null ? '7px' : `${insetY}%`;
  const radius = gaugeNum(m.gauge_fill_radius) ?? 6;

  const trackSpan = `(100% - ${insetLeft} - ${insetRight})`;
  return {
    barHeight,
    iconHeight,
    insetLeft,
    insetRight,
    insetY: insetYCss,
    radius,
    trackLeft: (fraction) => `calc(${insetLeft} + ${trackSpan} * ${fraction})`,
    trackWidth: (fraction) => `calc(${trackSpan} * ${fraction})`,
    trackHeight: `calc(100% - ${insetYCss} - ${insetYCss})`,
  };
}

/* ───────────────── Result sub-frame ("sous-cadre coloré") ───────────────────
 * Every enigma tile - the big centre one and each recap thumbnail - carries a
 * coloured plate that reads the verdict: green for a correct answer, red for a
 * wrong one, amber when both stations were biped, grey when nothing was found.
 *
 * It used to be a fixed, full-tile rectangle drawn BEHIND the artwork, which
 * caused two problems in the field:
 *
 *   • retour #85 - authors' frame images are rarely perfect rectangles (irregular
 *     edges, transparent corners), so a full-tile plate sticks out around the
 *     artwork and the board looks unfinished. `status_frame_scale` shrinks the
 *     plate inside the tile and `status_frame_radius` rounds it, per scenario.
 *   • retour #83 - artwork exported on an OPAQUE background completely hides a
 *     plate drawn only behind it: the same picture read green as a good answer
 *     (transparent file) and plain white as a wrong one (flattened file). A
 *     second, weaker copy of the plate is now drawn ON TOP of the image so the
 *     verdict reads whatever the artwork's alpha; `status_frame_over_image`
 *     (% of the base tint, 0 = off) tunes it.
 *
 * All three fields are blank by default: blank keeps the historical geometry and
 * applies the top tint at STATUS_FRAME_OVER_DEFAULT.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Verdict → plate colour. Shared so the playground reveal, the studio preview
 *  and any future surface tint an enigma exactly the same way. */
export const MYSTERY_STATUS_COLORS = {
  correct: 'rgba(0, 255, 0, 0.3)',
  incorrect: 'rgba(255, 0, 0, 0.3)',
  no_answer: 'rgba(128, 128, 128, 0.3)',
  both_answers: 'rgba(255, 165, 0, 0.3)',
} as const;

/** Neutral plate shown on a tile with no verdict yet. STUDIO PREVIEW ONLY: it
 *  is how the author sees the main-image underlay they are sizing. The board
 *  draws nothing until an enigma has a verdict - a white slab behind the artwork
 *  is not wanted in-game. */
export const MYSTERY_STATUS_NEUTRAL = 'rgba(255,255,255,0.06)';

/** How much of the base tint is drawn over the image when the scenario leaves
 *  `status_frame_over_image` blank (% - 60 % of a 0.3 tint ≈ 0.18 on screen). */
export const STATUS_FRAME_OVER_DEFAULT = 60;

export interface MysteryStatusFrameMeta {
  status_frame_scale?: string | number;
  status_frame_radius?: string | number;
  status_frame_over_image?: string | number;
}

export interface MysteryStatusFrame {
  /** CSS inset applied on all four sides of the tile ('0%' at full size). */
  inset: string;
  /** Authored border-radius, or null to keep the caller's legacy px value. */
  radius: string | null;
  /** 0–1 opacity of the copy drawn over the artwork (0 = don't draw it). */
  overOpacity: number;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

export function resolveMysteryStatusFrame(
  meta: MysteryStatusFrameMeta | null | undefined,
): MysteryStatusFrame {
  const m = meta ?? {};
  const scale = clampPct(gaugeNum(m.status_frame_scale) ?? 100);
  const radius = gaugeNum(m.status_frame_radius);
  const over = clampPct(gaugeNum(m.status_frame_over_image) ?? STATUS_FRAME_OVER_DEFAULT);
  return {
    inset: `${(100 - scale) / 2}%`,
    radius: radius === null ? null : `${radius}%`,
    overOpacity: over / 100,
  };
}

/* ──────────────── Main-image underlay ("fond de l'image principale") ─────────
 * Every enigma's main image sits on a square tile: that tile is the underlay -
 * what the result sub-frame paints, and what `object-fit: contain` letterboxes
 * the artwork inside. It used to be hard-wired to the full height of the centre
 * column, which is normally much bigger than the artwork, so the neutral plate
 * read as a large white slab around a small picture.
 *
 * `enigma_underlay_scale` (% of the available square, blank = 100) lets the
 * author shrink it. The studio preview PAINTS the neutral underlay so its size
 * is visible while authoring; the playground draws no neutral plate at all (a
 * white slab under the artwork is never wanted in-game) but honours the size.
 * ─────────────────────────────────────────────────────────────────────────── */

export interface MysteryUnderlayMeta {
  enigma_underlay_scale?: string | number;
}

/** % of the available square that the main-image tile occupies (10-100). */
export function resolveMysteryUnderlayScale(
  meta: MysteryUnderlayMeta | null | undefined,
): number {
  const n = gaugeNum((meta ?? {}).enigma_underlay_scale);
  if (n === null) return 100;
  return Math.max(10, Math.min(100, n));
}

export interface MysteryStatusPlateProps {
  /** Tint colour (a verdict colour, or the neutral plate). */
  color: string;
  frame: MysteryStatusFrame;
  /** Radius used when the scenario left `status_frame_radius` blank. */
  legacyRadius: number;
  /** Draw the weaker copy that sits ON TOP of the artwork (retour #83). */
  over?: boolean;
}

/** One layer of the result sub-frame, positioned inside a `position:relative` tile. */
export function MysteryStatusPlate({ color, frame, legacyRadius, over }: MysteryStatusPlateProps) {
  if (over && frame.overOpacity <= 0) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: frame.inset,
        right: frame.inset,
        top: frame.inset,
        bottom: frame.inset,
        background: color,
        borderRadius: frame.radius ?? `${legacyRadius}px`,
        opacity: over ? frame.overOpacity : undefined,
        transition: 'background 0.3s ease',
        pointerEvents: 'none',
        zIndex: over ? 2 : 0,
      }}
    />
  );
}
