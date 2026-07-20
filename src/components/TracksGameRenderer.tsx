/**
 * Tracks game renderer - the on-screen game surface.
 *
 *   - background: the resting screen (background_image) shown at idle + during a
 *                 run. Black when no background image is configured.
 *   - reveal:     the second-bip reveal surface. Shows the map with checkpoint
 *                 markers that ACCUMULATE as the run is revealed (each marker is
 *                 a per-status image: own image / wrong-order / missing). In full
 *                 mode a `bigReveal` panel shows the current checkpoint big +
 *                 centered (with name/description for correct hits) before it
 *                 lands on the map. Simple mode shows a minimal summary HUD
 *                 instead of the map.
 *   - clues:      map-style review page listing every checkpoint (auto-triggered
 *                 when a finished card re-bips and the clues page is enabled).
 *   - topreveal:  end-of-run top-X reward image.
 *
 * Design plan: C:\Users\faure\.claude\plans\tracks-reveal-redesign.md
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import type { TracksCheckpoint } from '../services/tracksScoring';
import { resolveFontFamily } from '../fonts/resolveFontFamily';
import { TracksTextFit } from './TracksTextFit';
import { TEXT_ELEMENT_DEFAULT_ALIGN } from './trackTextElementStyle';
import {
  resolveTypography,
  type TextCategoryTypography,
} from './trackTypographyResolve';

export type TracksScreen = 'background' | 'reveal' | 'clues' | 'topreveal';
export type TracksDisplayMode = 'full' | 'map' | 'simple';

type Localizedish = Record<string, string> | string | undefined | null;

/** Read a Localized<string> map (or plain string) at the active language. */
export function readLocalized(value: Localizedish, lang: string, fallbackLang = 'fr'): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return value[lang] ?? value[fallbackLang] ?? Object.values(value)[0] ?? '';
  }
  return '';
}

/**
 * Author-defined text overlay positioned on the tracks map. Content + style
 * live here; the studio LayoutEditor owns `position`. Only entries with a
 * defined `position` are placed at runtime (others are still authored but
 * "unplaced" - see the design plan).
 *
 * Plan: C:\Users\faure\.claude\plans\tracks-text-elements.md
 */
export interface SceneTextElement {
  id: string;
  text?: Localizedish;
  /** Category id reference; undefined = Uncategorized. Resolution: element
   *  field → category typography → scenario default (see resolveTypography). */
  category?: string;
  /** Family name; per-element override of the category/scenario font. */
  font?: string;
  /** Hex color; per-element override of the category/scenario font_color. */
  font_color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right';
  shadow?: boolean;
  background?: boolean;
  position?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

/**
 * Author-defined text-element category - first-class object carrying
 * typography defaults that its elements inherit.
 *
 * Plan: tracks-text-elements-categories.md
 */
export interface SceneTextCategory {
  id: string;
  name: string;
  typography?: TextCategoryTypography;
}

export interface TracksRendererCluesConfig {
  enabled: boolean;
  show_title: boolean;
  show_text: boolean;
  show_image: boolean;
}

/** The full-mode big-center reveal for the current checkpoint. */
export interface TracksBigReveal {
  imageUrl: string;
  title: string;
  description: string;
}

export interface TracksGameRendererProps {
  screen: TracksScreen;
  displayMode: TracksDisplayMode;
  /** Resting background image URL (already resolved); '' → black. */
  backgroundUrl: string;
  /** Map image URL (already resolved) - the reveal surface. */
  mapUrl: string;
  /** Checkpoints that count for the active route, in order (positions + clues). */
  routeCheckpoints: TracksCheckpoint[];
  /** cpId → resolved per-status image URL currently placed on the map (accumulates). */
  placedCheckpoints: Map<string, string>;
  /** Full-mode center reveal for the current checkpoint, or null. */
  bigReveal: TracksBigReveal | null;
  /** Resolve a checkpoint's own image filename → URL (clues page). */
  resolveCheckpointImage: (cp: TracksCheckpoint) => string;
  /**
   * Checkpoints the focused team actually reached, used by the clues page to
   * decide which image each cell shows: a found checkpoint shows its own image,
   * an unfound one shows `missingCheckpointUrl` instead. Empty/undefined ⇒ every
   * checkpoint is treated as not-found.
   */
  foundCheckpointIds?: Set<string>;
  /** "Not found" image URL (already resolved) shown on the clues page for
   *  checkpoints the team didn't reach; '' falls back to no image. */
  missingCheckpointUrl?: string;
  /** Marker size as a % of map width. */
  iconSizePercent: number;
  /** HUD frame backgrounds (already resolved URLs; '' if none). */
  hud: {
    teamNameFrame: string;
    timerFrame: string;
    scoreFrame: string;
    timeFrame: string;
  };
  teamName: string;
  timerText: string;
  scoreText: string;
  showScore: boolean;
  /** Correct-checkpoint count for the simple summary ("X / N"). */
  hitCount: number;
  language: string;
  clues: TracksRendererCluesConfig;
  /** Top-X reveal image URL (when screen === 'topreveal'); '' to skip. */
  topRevealUrl: string;
  fontFamily?: string;
  fontColor?: string;
  /**
   * Authored text overlays on the map. Filtered to entries with `position`
   * before rendering. Visibility matches the HUD (shown whenever the map is
   * showing - i.e. `displayMode` ∈ {full, map} during the `reveal` screen).
   */
  textElements?: SceneTextElement[];
  /**
   * Author-defined categories carrying typography defaults. Resolution at
   * runtime: element override (per field) → category typography → scenario
   * default. Elements with no `category` (or pointing at a missing one)
   * inherit straight from the scenario.
   */
  textCategories?: SceneTextCategory[];
  /**
   * Raw scenario-level font name (NOT the resolved stack). Per-element fonts
   * fall back to this when blank; resolved through `resolveFontFamily` inline.
   */
  scenarioFontName?: string;
  /** Raw scenario-level color. Per-element colors fall back to this. */
  scenarioFontColor?: string;
  /**
   * Saved HUD frame positions from the studio LayoutEditor (% of map image,
   * same referential as checkpoint markers + text elements). Keyed by the
   * element id (e.g. `team_name_background_image`). When any HUD frame has
   * a saved position, the renderer switches from the top-strip default to
   * absolute positioning per box - boxes without a saved entry keep a
   * sensible top-strip fallback so a partial layout still works.
   */
  hudLayout?: {
    team_name_background_image?: { x: number; y: number; width: number; height: number };
    timer_background_image?: { x: number; y: number; width: number; height: number };
    score_background_image?: { x: number; y: number; width: number; height: number };
    time_background_image?: { x: number; y: number; width: number; height: number };
  };
}

function HudBox({
  frameUrl,
  label,
  value,
}: {
  frameUrl: string;
  label?: string;
  value: string;
}) {
  return (
    <div
      className="relative px-5 py-2 min-w-[120px] text-center"
      style={
        frameUrl
          ? {
              backgroundImage: `url(${frameUrl})`,
              backgroundSize: '100% 100%',
              backgroundRepeat: 'no-repeat',
            }
          : { background: 'rgba(0,0,0,0.45)', borderRadius: 8 }
      }
    >
      {label && <div className="text-[10px] uppercase tracking-wider opacity-70">{label}</div>}
      <div className="text-xl font-bold leading-tight">{value}</div>
    </div>
  );
}

/**
 * Absolute-positioned HUD box used when the studio LayoutEditor has saved
 * a per-frame position. `pos` is in `% of map image`; we convert through
 * `imgBounds` (map rect in % of viewport) to get viewport-relative coords -
 * the exact same math used for checkpoint markers + text elements, so all
 * three referentials land identically.
 *
 * Font sizes scale with the box height so a small frame doesn't overflow,
 * matching the studio editor's mock-text heuristic (≈40% of box height).
 */
function PositionedHudBox({
  pos,
  imgBounds,
  frameUrl,
  label,
  value,
}: {
  pos: { x: number; y: number; width: number; height: number };
  imgBounds: { x: number; y: number; width: number; height: number };
  frameUrl: string;
  label?: string;
  value: string;
}) {
  const left = imgBounds.x + (pos.x / 100) * imgBounds.width;
  const top = imgBounds.y + (pos.y / 100) * imgBounds.height;
  const widthPct = (pos.width / 100) * imgBounds.width;
  const heightPct = (pos.height / 100) * imgBounds.height;
  const heightPx =
    (heightPct / 100) * (typeof window !== 'undefined' ? window.innerHeight : 0);
  const valueFontSize = Math.max(10, heightPx * (label ? 0.45 : 0.55));
  const labelFontSize = Math.max(8, heightPx * 0.18);
  return (
    <div
      className="absolute pointer-events-none flex flex-col items-center justify-center overflow-hidden text-center"
      style={{
        left: `${left}%`,
        top: `${top}%`,
        width: `${widthPct}%`,
        height: `${heightPct}%`,
        ...(frameUrl
          ? {
              backgroundImage: `url(${frameUrl})`,
              backgroundSize: '100% 100%',
              backgroundRepeat: 'no-repeat',
            }
          : { background: 'rgba(0,0,0,0.45)', borderRadius: 8 }),
      }}
    >
      {label && (
        <div
          className="uppercase tracking-wider opacity-70 leading-none"
          style={{ fontSize: `${labelFontSize}px` }}
        >
          {label}
        </div>
      )}
      <div className="font-bold leading-tight" style={{ fontSize: `${valueFontSize}px` }}>
        {value}
      </div>
    </div>
  );
}

export function TracksGameRenderer(props: TracksGameRendererProps) {
  const {
    screen,
    displayMode,
    backgroundUrl,
    mapUrl,
    routeCheckpoints,
    placedCheckpoints,
    bigReveal,
    resolveCheckpointImage,
    foundCheckpointIds,
    missingCheckpointUrl,
    iconSizePercent,
    hud,
    teamName,
    timerText,
    scoreText,
    showScore,
    hitCount,
    language,
    clues,
    topRevealUrl,
    fontFamily,
    fontColor,
    textElements,
    textCategories,
    scenarioFontName,
    scenarioFontColor,
    hudLayout,
  } = props;

  // Resolution index - categories looked up by id. Built per render; cheap
  // (≤ a handful of categories per scenario).
  const categoryById = new Map<string, SceneTextCategory>();
  (textCategories ?? []).forEach((c) => {
    if (c && c.id) categoryById.set(c.id, c);
  });

  const rootStyle: React.CSSProperties = {
    position: 'relative',
    width: '100vw',
    height: '100vh',
    overflow: 'hidden',
    fontFamily,
    color: fontColor || '#fff',
    background: '#000',
  };

  // Map-image rect within the viewport (object-contain letterbox), in % of the
  // viewport. Checkpoint positions are stored as % of the MAP IMAGE (the exact
  // referential the studio LayoutEditor uses), so markers must be placed inside
  // this rect - NOT against the full viewport - to land where the editor showed.
  const mapImgRef = useRef<HTMLImageElement>(null);
  const [imgBounds, setImgBounds] = useState({ x: 0, y: 0, width: 100, height: 100 });
  const recalcBounds = useCallback(() => {
    const img = mapImgRef.current;
    const cw = window.innerWidth;
    const ch = window.innerHeight;
    if (!img || !img.naturalWidth || !img.naturalHeight || !cw || !ch) {
      setImgBounds({ x: 0, y: 0, width: 100, height: 100 });
      return;
    }
    const imgAR = img.naturalWidth / img.naturalHeight;
    const cAR = cw / ch;
    let aw: number, ah: number, ox: number, oy: number;
    if (imgAR > cAR) {
      aw = cw;
      ah = cw / imgAR;
      ox = 0;
      oy = (ch - ah) / 2;
    } else {
      ah = ch;
      aw = ch * imgAR;
      oy = 0;
      ox = (cw - aw) / 2;
    }
    setImgBounds({ x: (ox / cw) * 100, y: (oy / ch) * 100, width: (aw / cw) * 100, height: (ah / ch) * 100 });
  }, []);
  useEffect(() => {
    recalcBounds();
    window.addEventListener('resize', recalcBounds);
    return () => window.removeEventListener('resize', recalcBounds);
  }, [recalcBounds, mapUrl]);

  // --- Background: the resting screen (idle + run) ---------------------------
  if (screen === 'background') {
    return (
      <div style={rootStyle}>
        {backgroundUrl && (
          <img
            src={backgroundUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover select-none pointer-events-none"
          />
        )}
      </div>
    );
  }

  // --- Top-X reveal: full-screen image (end of run) --------------------------
  if (screen === 'topreveal') {
    return (
      <div style={rootStyle} className="flex items-center justify-center">
        {topRevealUrl ? (
          <img src={topRevealUrl} alt="result" className="max-w-full max-h-full object-contain" />
        ) : (
          <div className="text-3xl font-bold">{scoreText}</div>
        )}
      </div>
    );
  }

  // --- Simple mode reveal: minimal centered HUD, no map ----------------------
  if (displayMode === 'simple' && screen === 'reveal') {
    return (
      <div style={rootStyle} className="flex flex-col items-center justify-center gap-6">
        <div className="text-5xl font-bold">{teamName}</div>
        {showScore && <div className="text-7xl font-extrabold">{scoreText}</div>}
        <div className="text-3xl opacity-80">
          {hitCount} / {routeCheckpoints.length} checkpoints
        </div>
        <div className="text-2xl opacity-60">{timerText}</div>
      </div>
    );
  }

  // --- Reveal (full/map) + clues both render the map -------------------------
  const isClues = screen === 'clues';

  return (
    <div style={rootStyle}>
      {/* Map background */}
      {mapUrl && (
        <img
          ref={mapImgRef}
          onLoad={recalcBounds}
          src={mapUrl}
          alt="map"
          className="absolute inset-0 w-full h-full object-contain select-none pointer-events-none"
        />
      )}

      {/* Reveal markers - only the checkpoints already placed on the map, each
          using its per-status image (own / wrong-order / missing). Positioned
          inside the map-image rect (same referential as the studio editor). */}
      {screen === 'reveal' &&
        routeCheckpoints.map((cp) => {
          if (!placedCheckpoints.has(cp.id)) return null;
          const url = placedCheckpoints.get(cp.id) || '';
          const pos = cp.position ?? { top: 50, left: 50 };
          const left = imgBounds.x + (Number(pos.left) / 100) * imgBounds.width;
          const top = imgBounds.y + (Number(pos.top) / 100) * imgBounds.height;
          const w = (iconSizePercent / 100) * imgBounds.width;
          return (
            <div
              key={cp.id}
              className="absolute -translate-x-1/2 -translate-y-1/2 tracks-fade-in"
              style={{ top: `${top}%`, left: `${left}%`, width: `${w}%` }}
            >
              {url ? (
                <img src={url} alt="" className="w-full h-auto" />
              ) : (
                <div
                  className="rounded-full border-2"
                  style={{ width: '100%', paddingBottom: '100%', borderColor: '#22c55e', background: 'rgba(34,197,94,0.4)' }}
                />
              )}
            </div>
          );
        })}

      {/* Author-defined text overlays on the map. Sits ABOVE reveal markers
          (DOM order: rendered after) and BELOW the HUD (rendered before), per
          the design's z-order. Same visibility rule as the HUD via `!isClues`;
          background + topreveal + simple already early-returned above. Each
          element's `position` is `% of map image`, identical to the
          checkpoint-marker referential - same math here as for markers. The
          inner TracksTextFit needs pixel dimensions, so we multiply by the
          live window size (kiosk renderer fills the viewport). */}
      {!isClues && Array.isArray(textElements) && textElements.length > 0 && (
        <>
          {textElements.map((te) => {
            if (!te.position) return null;
            const left = imgBounds.x + (te.position.left / 100) * imgBounds.width;
            const top = imgBounds.y + (te.position.top / 100) * imgBounds.height;
            const widthPct = (te.position.width / 100) * imgBounds.width;
            const heightPct = (te.position.height / 100) * imgBounds.height;
            const widthPx = (widthPct / 100) * (typeof window !== 'undefined' ? window.innerWidth : 0);
            const heightPx = (heightPct / 100) * (typeof window !== 'undefined' ? window.innerHeight : 0);
            const textValue = readLocalized(te.text, language);
            if (!textValue) return null;
            // Inheritance chain: per-element override (any field set) →
            // category typography (when te.category points at a known cat) →
            // scenario default. Per the categories design (see
            // tracks-text-elements-categories.md).
            const cat = te.category ? categoryById.get(te.category) : undefined;
            const resolved = resolveTypography({
              element: {
                font: te.font,
                font_color: te.font_color,
                bold: te.bold,
                italic: te.italic,
                underline: te.underline,
                align: te.align,
                shadow: te.shadow,
                background: te.background,
              },
              category: cat?.typography,
              scenarioFont: scenarioFontName || '',
              scenarioFontColor: scenarioFontColor || '',
            });
            const effFontStack = resolveFontFamily(resolved.font);
            const effColor = resolved.font_color || fontColor || '#ffffff';
            return (
              <div
                key={te.id}
                className="absolute pointer-events-none"
                style={{
                  left: `${left}%`,
                  top: `${top}%`,
                  width: `${widthPct}%`,
                  height: `${heightPct}%`,
                }}
              >
                <TracksTextFit
                  text={textValue}
                  boxWidthPx={widthPx}
                  boxHeightPx={heightPx}
                  fontFamily={effFontStack}
                  fontWeight={resolved.bold ? 700 : 400}
                  fontStyle={resolved.italic ? 'italic' : 'normal'}
                  underline={resolved.underline}
                  color={effColor}
                  align={resolved.align ?? TEXT_ELEMENT_DEFAULT_ALIGN}
                  shadow={resolved.shadow}
                  background={resolved.background}
                />
              </div>
            );
          })}
        </>
      )}

      {/* HUD - hidden on the clues page. When the studio LayoutEditor has
          saved per-frame positions, each box renders absolutely inside the
          map referential (matching the editor preview exactly). Otherwise we
          fall back to the legacy top strip so scenarios that never opened
          the layout editor still get a usable HUD. */}
      {!isClues && (
        (() => {
          const placedTeam = hudLayout?.team_name_background_image;
          const placedTimer = hudLayout?.timer_background_image;
          const placedScore = hudLayout?.score_background_image;
          const anyPlaced = !!(placedTeam || placedTimer || placedScore);
          if (anyPlaced) {
            return (
              <>
                {placedTimer && (
                  <PositionedHudBox
                    pos={placedTimer}
                    imgBounds={imgBounds}
                    frameUrl={hud.timerFrame}
                    label="Time"
                    value={timerText}
                  />
                )}
                {placedTeam && (
                  <PositionedHudBox
                    pos={placedTeam}
                    imgBounds={imgBounds}
                    frameUrl={hud.teamNameFrame}
                    value={teamName}
                  />
                )}
                {placedScore && showScore && (
                  <PositionedHudBox
                    pos={placedScore}
                    imgBounds={imgBounds}
                    frameUrl={hud.scoreFrame}
                    label="Score"
                    value={scoreText}
                  />
                )}
              </>
            );
          }
          return (
            <div className="absolute top-4 left-0 right-0 flex items-start justify-between px-6 pointer-events-none">
              <HudBox frameUrl={hud.timerFrame} label="Time" value={timerText} />
              <HudBox frameUrl={hud.teamNameFrame} value={teamName} />
              {showScore && <HudBox frameUrl={hud.scoreFrame} label="Score" value={scoreText} />}
            </div>
          );
        })()
      )}

      {/* Full-mode big-center reveal for the current checkpoint */}
      {screen === 'reveal' && bigReveal && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center px-10 pointer-events-none" style={{ background: 'rgba(0,0,0,0.45)' }}>
          {bigReveal.imageUrl && (
            <img
              key={bigReveal.imageUrl}
              src={bigReveal.imageUrl}
              alt=""
              className="max-w-[60%] max-h-[60%] object-contain tracks-fade-in"
            />
          )}
          {bigReveal.title && (
            <div className="mt-5 text-4xl font-bold text-center">{bigReveal.title}</div>
          )}
          {bigReveal.description && (
            <div className="mt-3 text-2xl opacity-85 text-center whitespace-pre-wrap max-w-[80%]">
              {bigReveal.description}
            </div>
          )}
        </div>
      )}

      {/* Clues page - every checkpoint, constrained to the viewport with no
          overflow (kiosk display has no scroll). A top strip shows the team
          name, score and time; the grid below fits all checkpoints by computing
          a near-square column count and dividing the remaining height evenly. A
          checkpoint the team found shows its own image; an unfound one shows the
          "not found" image instead. */}
      {isClues && clues.enabled && (() => {
        const n = routeCheckpoints.length || 1;
        // Bias toward more columns than rows for landscape kiosks.
        const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.7)));
        const rows = Math.max(1, Math.ceil(n / cols));
        return (
          <div className="absolute inset-0 bg-black/70 flex flex-col overflow-hidden">
            {/* Top HUD: team name, score, time */}
            <div className="shrink-0 flex items-center justify-between gap-4 px-8 py-3 border-b border-white/15">
              <div className="text-2xl font-bold truncate">{teamName}</div>
              <div className="flex items-center gap-6">
                {showScore && (
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-wider opacity-60">Score</div>
                    <div className="text-2xl font-bold leading-none">{scoreText}</div>
                  </div>
                )}
                {timerText && (
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-wider opacity-60">Time</div>
                    <div className="text-2xl font-bold leading-none">{timerText}</div>
                  </div>
                )}
              </div>
            </div>
            {/* Checkpoint grid - fills the remaining height, no overflow */}
            <div className="flex-1 min-h-0 p-4">
              <div
                className="h-full w-full"
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
                  gap: '0.6rem',
                }}
              >
                {routeCheckpoints.map((cp, i) => {
                  const found = !!foundCheckpointIds?.has(cp.id);
                  const imgUrl = found
                    ? resolveCheckpointImage(cp)
                    : (missingCheckpointUrl || '');
                  return (
                    <div
                      key={cp.id}
                      className="min-h-0 min-w-0 bg-black/50 rounded-lg p-2 flex flex-col items-center justify-center text-center overflow-hidden"
                    >
                      {clues.show_image && imgUrl && (
                        <img
                          src={imgUrl}
                          alt=""
                          className="flex-1 min-h-0 max-w-full object-contain"
                        />
                      )}
                      {clues.show_title && (
                        <div className="shrink-0 mt-1 font-bold text-sm leading-tight truncate w-full">
                          {readLocalized(cp.title as Localizedish, language) || `#${i + 1}`}
                        </div>
                      )}
                      {clues.show_text && (
                        <div className="shrink-0 text-xs opacity-80 leading-tight line-clamp-2 w-full">
                          {readLocalized(cp.description as Localizedish, language)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
