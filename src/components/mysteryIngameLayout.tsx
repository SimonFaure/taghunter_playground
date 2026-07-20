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

export interface MysteryFixedFramesProps {
  /** role → resolved frame image URL. Roles without a frame are omitted. */
  frameUrls: Partial<Record<IngameRoleKey, string>>;
}

/**
 * Fixed (non-movable) element frame images, drawn at each role's default box
 * position. The author places only the TEXT (via MysteryLayoutBox); these frame
 * images stay put. Rendered behind the text layer. enigma_name has no frame.
 */
export function MysteryFixedFrames({ frameUrls }: MysteryFixedFramesProps) {
  return (
    <>
      {INGAME_ROLES.map((role) => {
        const url = frameUrls[role.key];
        if (!url) return null;
        const box = DEFAULT_INGAME_LAYOUT[role.key];
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
