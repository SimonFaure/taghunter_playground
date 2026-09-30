/**
 * Feedback-image legend box for tracks scenarios (`game_meta.show_legend`).
 *
 * Shared by the LayoutEditor preview and the playground runtime so both
 * surfaces render the same box. The box is a fixed dark rounded panel holding
 * up to two rows (image square on the left, caption on the right). Row height
 * is ALWAYS half the inner box height, whatever the row count, so the legend
 * keeps its authored footprint; a single row (free mode / clues page) is
 * centred vertically.
 *
 * Caption size: `textScale`% of the row height (default 45), shrunk so the
 * longest caption fits the text column on one line. Text is always white with
 * a shadow - the panel is dark, so the scenario `font_color` is ignored.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ DUPLICATED VERBATIM - keep in sync:                                     │
 * │   studio-taghunter/src/scenarios/bodies/tracks/TracksLegend.tsx         │
 * │   taghunter_playground/src/components/TracksLegend.tsx                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

/** Layout element id of the legend box in `scenario_layout.elements`. */
export const TRACKS_LEGEND_ID = 'legend';
/** Default caption size, % of the row height. */
export const TRACKS_LEGEND_DEFAULT_SCALE = 45;
/** Default box (percent of the map) when the legend is first placed. */
export const TRACKS_LEGEND_DEFAULT_BOX = { x: 2, y: 84, width: 22, height: 12 };

export interface TracksLegendRow {
  /** Resolved image URL; '' draws a dashed placeholder when `placeholders`. */
  imageUrl: string;
  label: string;
}

interface TracksLegendProps {
  rows: TracksLegendRow[];
  boxWidthPx: number;
  boxHeightPx: number;
  fontFamily?: string;
  /** Caption size as % of row height; undefined = default. */
  textScale?: number;
  /** Editor only: draw a dashed square where a row has no image. */
  placeholders?: boolean;
}

let cachedCtx: CanvasRenderingContext2D | null = null;
function measureAt100(text: string, fontFamily: string): number {
  if (!cachedCtx && typeof document !== 'undefined') {
    cachedCtx = document.createElement('canvas').getContext('2d');
  }
  if (!cachedCtx) return text.length * 55;
  cachedCtx.font = `400 100px ${fontFamily || 'sans-serif'}`;
  return cachedCtx.measureText(text).width;
}

export function TracksLegend({
  rows,
  boxWidthPx,
  boxHeightPx,
  fontFamily = '',
  textScale,
  placeholders = false,
}: TracksLegendProps) {
  const pad = Math.max(2, Math.min(boxWidthPx, boxHeightPx) * 0.08);
  const innerW = Math.max(0, boxWidthPx - pad * 2);
  const innerH = Math.max(0, boxHeightPx - pad * 2);
  const rowH = innerH / 2;
  const imgSide = rowH * 0.85;
  const gap = rowH * 0.25;
  const textW = Math.max(1, innerW - imgSide - gap);
  const scale = typeof textScale === 'number' ? textScale : TRACKS_LEGEND_DEFAULT_SCALE;
  const widest = rows.reduce((m, r) => Math.max(m, measureAt100(r.label, fontFamily)), 0);
  const fitPx = widest > 0 ? (textW / widest) * 100 : Infinity;
  const fontPx = Math.max(6, Math.min(rowH * (scale / 100), fitPx));

  return (
    <div
      className="w-full h-full flex flex-col justify-center pointer-events-none select-none overflow-hidden"
      style={{
        padding: pad,
        background: 'rgba(0,0,0,0.55)',
        borderRadius: 8,
        fontFamily: fontFamily || undefined,
        color: '#ffffff',
        textShadow: '0 1px 3px rgba(0,0,0,0.85)',
      }}
    >
      {rows.map((row, i) => (
        <div key={i} className="flex items-center shrink-0" style={{ height: rowH, gap }}>
          {row.imageUrl ? (
            <img
              src={row.imageUrl}
              alt=""
              className="object-contain shrink-0"
              style={{ width: imgSide, height: imgSide }}
              draggable={false}
            />
          ) : placeholders ? (
            <div
              className="shrink-0 border border-dashed border-white/50 rounded"
              style={{ width: imgSide, height: imgSide }}
            />
          ) : null}
          <span className="whitespace-nowrap leading-none" style={{ fontSize: `${fontPx}px` }}>
            {row.label}
          </span>
        </div>
      ))}
    </div>
  );
}
