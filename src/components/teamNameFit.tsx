/**
 * Team-name text fit: largest font that fits the box on ONE line, and - when
 * that size falls under the author's minimum - the same name broken over TWO
 * lines instead, so a long team name stays readable rather than shrinking to a
 * sliver.
 *
 *   one line  : f = min(maxPx, boxH, boxW / widthAt1px)
 *   f < minPx : split at the word boundary that balances the two halves (a
 *               single long word is cut mid-word with a hyphen), then
 *               f2 = min(maxPx, boxH / (2 × lineHeight), boxW / widestHalfAt1px)
 *               - kept only when it is bigger than the one-line size, i.e.
 *               when wrapping actually helps.
 *
 * Measurement is the same O(1) offscreen-canvas `measureText` used by
 * MysteryLayoutBox / TracksTextFit.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ DUPLICATED VERBATIM - keep in sync:                                      │
 * │   studio-taghunter/src/scenarios/preview/teamNameFit.tsx                 │
 * │   taghunter_playground/src/components/teamNameFit.tsx                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/** Line height used when the name is drawn over two lines. */
export const TEAM_NAME_TWO_LINE_HEIGHT = 1.05;

/** Bounds of the author-facing "min font size" inputs. */
export const TEAM_NAME_MIN_FONT_MIN = 0;
export const TEAM_NAME_MIN_FONT_MAX = 300;

/** Min font size used when the author left the field empty, in px on the
 *  canonical 1920×1080 screen (every editor stores the min in that unit). */
export const TEAM_NAME_MIN_FONT_DEFAULT = 20;

/** Authored minimum → px on the 1920×1080 screen. Blank / bad input = the
 *  default (20); an explicit 0 = never wrap. */
export function readMinFontSize(v: unknown): number {
  if (v === undefined || v === null || v === '') return TEAM_NAME_MIN_FONT_DEFAULT;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return TEAM_NAME_MIN_FONT_DEFAULT;
  if (n <= 0) return 0;
  return Math.min(TEAM_NAME_MIN_FONT_MAX, n);
}

export interface TextFit {
  fontSize: number;
  /** One entry per drawn line (1 or 2). */
  lines: string[];
}

let cachedCtx: CanvasRenderingContext2D | null = null;
function getMeasurementContext(): CanvasRenderingContext2D | null {
  if (cachedCtx) return cachedCtx;
  if (typeof document === 'undefined') return null;
  cachedCtx = document.createElement('canvas').getContext('2d');
  return cachedCtx;
}

/** Best two-line split of `text`: the cut that minimises the wider half. */
function splitInTwo(text: string, widthAt100: (s: string) => number): [string, string] | null {
  const t = text.trim();
  const candidates: Array<[string, string]> = [];
  const re = /\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    candidates.push([t.slice(0, m.index), t.slice(m.index + m[0].length)]);
  }
  if (candidates.length === 0) {
    // One long word: cut it, hyphenated, anywhere that leaves ≥ 2 chars a side.
    const chars = Array.from(t);
    for (let i = 2; i <= chars.length - 2; i++) {
      candidates.push([`${chars.slice(0, i).join('')}-`, chars.slice(i).join('')]);
    }
  }
  let best: [string, string] | null = null;
  let bestW = Infinity;
  for (const c of candidates) {
    const w = Math.max(widthAt100(c[0]), widthAt100(c[1]));
    if (w < bestW) {
      bestW = w;
      best = c;
    }
  }
  return best;
}

/**
 * Fit `text` in a `boxW × boxH` px box.
 *  - `font`: the CSS font minus its size, e.g. `{ weight: 700, family: "'Bangers', sans-serif" }`.
 *  - `maxPx`: ceiling (the authored size); defaults to the box height.
 *  - `minPx`: below this one-line size the name goes on two lines (0 = never).
 *  - `floorPx`: absolute floor so a degenerate box still draws something.
 */
export function fitTeamNameText(
  text: string,
  font: { family: string; weight?: string | number; style?: string },
  boxW: number,
  boxH: number,
  opts: { maxPx?: number; minPx?: number; floorPx?: number } = {},
): TextFit {
  const floorPx = opts.floorPx ?? 6;
  const ceil = Math.min(opts.maxPx ?? boxH, boxH);
  const ctx = getMeasurementContext();
  if (!ctx || !text || boxW <= 0 || boxH <= 0) {
    return { fontSize: Math.max(floorPx, Math.min(ceil, 16)), lines: [text] };
  }
  ctx.font = `${font.style || 'normal'} ${font.weight ?? 'normal'} 100px ${font.family || 'sans-serif'}`;
  const widthAt100 = (s: string) => ctx.measureText(s).width;

  const w = widthAt100(text);
  const one = w > 0 ? Math.min(ceil, boxW / (w / 100)) : ceil;
  const minPx = opts.minPx ?? 0;
  if (!(minPx > 0) || one >= minPx) return { fontSize: Math.max(floorPx, one), lines: [text] };

  const split = splitInTwo(text, widthAt100);
  if (!split) return { fontSize: Math.max(floorPx, one), lines: [text] };
  const wMax = Math.max(widthAt100(split[0]), widthAt100(split[1]));
  const two = Math.min(
    opts.maxPx ?? boxH,
    boxH / (2 * TEAM_NAME_TWO_LINE_HEIGHT),
    wMax > 0 ? boxW / (wMax / 100) : Infinity,
  );
  if (!(two > one)) return { fontSize: Math.max(floorPx, one), lines: [text] };
  return { fontSize: Math.max(floorPx, two), lines: split };
}

/** Lines → children: one line as-is, two lines separated by a <br/>. */
export function renderFitLines(lines: string[]) {
  if (lines.length < 2) return lines[0] ?? '';
  return (
    <>
      {lines[0]}
      <br />
      {lines[1]}
    </>
  );
}

/* Re-fit once web fonts finish loading: a measurement taken against the
 * fallback font is wrong for the scenario font. */
function useFontsLoadedTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
    if (!fonts) return;
    let alive = true;
    const bump = () => alive && setTick((n) => n + 1);
    fonts.ready.then(bump).catch(() => {});
    fonts.addEventListener?.('loadingdone', bump);
    return () => {
      alive = false;
      fonts.removeEventListener?.('loadingdone', bump);
    };
  }, []);
  return tick;
}

export interface TeamNameFitProps {
  text: string;
  /** Ceiling in rendered px (the authored size). Absent = the box height. */
  maxPx?: number;
  /** Two-line threshold in rendered px. 0 / absent = always one line. */
  minPx?: number;
  align?: 'left' | 'center' | 'right';
  /** Font family / weight / colour / shadow for the text. The box measures the
   *  font it actually renders with, so inherited values work too. */
  textStyle?: CSSProperties;
  className?: string;
}

/**
 * Self-measuring team-name box: fills its parent (100 % × 100 %), reads its own
 * size + computed font, and draws the name with `fitTeamNameText`. For callers
 * that can't easily compute the box in px (TagQuest HUD, Tracks HUD frame).
 */
export function TeamNameFit({ text, maxPx, minPx, align = 'center', textStyle, className }: TeamNameFitProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const spanRef = useRef<HTMLSpanElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [fit, setFit] = useState<TextFit>({ fontSize: maxPx ?? 16, lines: [text] });
  const fontsTick = useFontsLoadedTick();

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const span = spanRef.current;
    const cs = span && typeof getComputedStyle !== 'undefined' ? getComputedStyle(span) : null;
    setFit(
      fitTeamNameText(
        text,
        { family: cs?.fontFamily || '', weight: cs?.fontWeight, style: cs?.fontStyle },
        size.w,
        size.h,
        { maxPx, minPx },
      ),
    );
  }, [text, size.w, size.h, maxPx, minPx, fontsTick, textStyle?.fontFamily, textStyle?.fontWeight]);

  const justifyContent = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
  const twoLines = fit.lines.length > 1;
  return (
    <div
      ref={boxRef}
      className={className}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent,
        overflow: 'hidden',
      }}
    >
      <span
        ref={spanRef}
        className="vcenter-text"
        style={{
          ...textStyle,
          fontSize: `${fit.fontSize}px`,
          lineHeight: twoLines ? TEAM_NAME_TWO_LINE_HEIGHT : 1,
          whiteSpace: 'nowrap',
          textAlign: align,
        }}
      >
        {renderFitLines(fit.lines)}
      </span>
    </div>
  );
}
