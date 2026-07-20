/**
 * Single-line auto-fit text component for tracks scenarios.
 *
 * Shared by the studio LayoutEditor preview and the playground runtime so
 * both surfaces render visually identical. Pure measurement + CSS - no DOM
 * mutation outside the component's own subtree.
 *
 * Algorithm: O(1) via offscreen canvas `measureText`. Measure the text width
 * at a reference 100px font-size, then compute the largest font-size where
 * the rendered text fits both box width and box height on a single line. No
 * binary search needed.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ DUPLICATED VERBATIM - keep in sync with the studio:                      │
 * │   studio-taghunter/src/scenarios/bodies/tracks/TracksTextFit.tsx         │
 * │   taghunter_playground/src/components/TracksTextFit.tsx                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Plan: C:\Users\faure\.claude\plans\tracks-text-elements.md
 */

import { useLayoutEffect, useState } from 'react';
import {
  TEXT_ELEMENT_SHADOW_CSS,
  TEXT_ELEMENT_BACKGROUND_CSS,
} from './trackTextElementStyle';

interface TracksTextFitProps {
  text: string;
  /** Available box width in px. */
  boxWidthPx: number;
  /** Available box height in px. */
  boxHeightPx: number;
  /** CSS font-family stack - typically `resolveFontFamily(element font ?? scenario font)`. */
  fontFamily: string;
  /** 400 (normal) or 700 (bold). */
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  underline: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  shadow: boolean;
  background: boolean;
  /** Floor for the computed font size (px); default 6. */
  minPx?: number;
}

// Reusable offscreen 2D context. Created lazily; safe on the main thread
// because we only use it synchronously inside a layout effect.
let cachedCtx: CanvasRenderingContext2D | null = null;
function getMeasurementContext(): CanvasRenderingContext2D | null {
  if (cachedCtx) return cachedCtx;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  cachedCtx = canvas.getContext('2d');
  return cachedCtx;
}

/**
 * Solve for the largest font-size (px) where a single line of text fits both
 * box width and box height. When `background` is true, accounts for the
 * preset 0.2em-vertical / 0.4em-horizontal padding analytically.
 *
 * - Width constraint (no padding):   `(f / 100) * w ≤ boxW`
 * - Width with background padding:   `(f / 100) * w + 0.8 * f ≤ boxW`
 * - Height constraint (no padding):  `f ≤ boxH`
 * - Height with background padding:  `f + 0.4 * f ≤ boxH`
 */
function fitFontSizePx(args: {
  textWidthAt100Px: number;
  boxWidthPx: number;
  boxHeightPx: number;
  background: boolean;
  minPx: number;
}): number {
  const { textWidthAt100Px: w, boxWidthPx: boxW, boxHeightPx: boxH, background, minPx } = args;
  const padH = background ? 0.8 : 0;
  const padV = background ? 0.4 : 0;
  if (w <= 0) {
    return Math.max(minPx, boxH / (1 + padV));
  }
  const fByWidth = boxW / (w / 100 + padH);
  const fByHeight = boxH / (1 + padV);
  return Math.max(minPx, Math.min(fByWidth, fByHeight));
}

export function TracksTextFit({
  text,
  boxWidthPx,
  boxHeightPx,
  fontFamily,
  fontWeight,
  fontStyle,
  underline,
  color,
  align,
  shadow,
  background,
  minPx = 6,
}: TracksTextFitProps) {
  const [fontSize, setFontSize] = useState(minPx);

  useLayoutEffect(() => {
    if (boxWidthPx <= 0 || boxHeightPx <= 0 || !text) {
      setFontSize(minPx);
      return;
    }
    const ctx = getMeasurementContext();
    if (!ctx) {
      setFontSize(Math.max(minPx, Math.min(boxHeightPx, 16)));
      return;
    }
    // CSS font shorthand. Quote the family if it isn't already wrapped to
    // avoid the canvas treating multi-word names as separate fallbacks.
    ctx.font = `${fontStyle} ${fontWeight} 100px ${fontFamily || 'sans-serif'}`;
    const measuredWidthAt100 = ctx.measureText(text).width;
    setFontSize(
      fitFontSizePx({
        textWidthAt100Px: measuredWidthAt100,
        boxWidthPx,
        boxHeightPx,
        background,
        minPx,
      }),
    );
  }, [text, boxWidthPx, boxHeightPx, fontFamily, fontWeight, fontStyle, background, minPx]);

  const justifyContent =
    align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent,
        overflow: 'hidden',
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      <span
        style={{
          fontFamily: fontFamily || undefined,
          fontWeight,
          fontStyle,
          textDecoration: underline ? 'underline' : 'none',
          color,
          fontSize: `${fontSize}px`,
          lineHeight: 1,
          whiteSpace: 'nowrap',
          textShadow: shadow ? TEXT_ELEMENT_SHADOW_CSS : undefined,
          ...(background ? TEXT_ELEMENT_BACKGROUND_CSS : null),
        }}
      >
        {text}
      </span>
    </div>
  );
}
