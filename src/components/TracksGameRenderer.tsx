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
import { TracksLegend, type TracksLegendRow } from './TracksLegend';
import { TEXT_ELEMENT_DEFAULT_ALIGN } from './trackTextElementStyle';
import { readMinFontSize, TeamNameFit } from './teamNameFit';
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
  /** Clues page: checkpoints punched out of itinerary order (not credited);
   *  drawn with `wrongOrderUrl`, exactly like the reveal. */
  wrongCheckpointIds?: Set<string>;
  wrongOrderUrl?: string;
  /** Marker size as a % of map width. */
  iconSizePercent: number;
  /** HUD frame backgrounds (already resolved URLs; '' if none). */
  hud: {
    teamNameFrame: string;
    timerFrame: string;
    scoreFrame: string;
  };
  teamName: string;
  timerText: string;
  scoreText: string;
  showScore: boolean;
  /**
   * Feedback-image legend (scenario option), or null. Rows are pre-filtered by
   * the page (missing image / free mode → null). Drawn over the map on the
   * reveal (full/map) and on the clues page, where only the "missing" row
   * applies (and only when the clues page shows images).
   */
  legend?: {
    box: HudBoxPos;
    wrongOrder: TracksLegendRow | null;
    missing: TracksLegendRow | null;
  } | null;
  /** Localized caption drawn over the timer frame (`ingame_tracks:hud_time`). */
  timeLabel: string;
  /** Localized caption drawn over the score frame (`ingame_tracks:hud_score`). */
  scoreLabel: string;
  /** Localized, already-interpolated "X / N checkpoints" line for simple mode. */
  checkpointsSummary: string;
  language: string;
  clues: TracksRendererCluesConfig;
  /** Seconds left before the clues page closes itself; null/undefined ⇒ no
   *  countdown drawn. */
  cluesCountdownSec?: number | null;
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
    team_name_background_image?: HudBoxPos;
    timer_background_image?: HudBoxPos;
    score_background_image?: HudBoxPos;
  };
}

/** One saved HUD box: geometry in % of the map image, plus the author's text
 *  size for the value drawn inside it (% of box height; see `DEFAULT_HUD_TEXT_SCALE`). */
interface HudBoxPos {
  x: number;
  y: number;
  width: number;
  height: number;
  textScale?: number;
  /** Team name: below this size (px on a 1920×1080 screen, default 20) the
   *  name goes on two lines. */
  minFontSize?: number;
}

/** Value font size as a % of the box height when the author set none. Mirrors
 *  `TRACKS_HUD_MOCK[*].defaultScale` in the studio's layoutGroups.ts. */
const DEFAULT_HUD_TEXT_SCALE = { withLabel: 45, withoutLabel: 55 } as const;

/** Caption size as a fraction of the value size (was .18/.45 hard-coded). */
const HUD_LABEL_RATIO = 0.4;

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
  fitValue,
}: {
  pos: HudBoxPos;
  imgBounds: { x: number; y: number; width: number; height: number };
  frameUrl: string;
  label?: string;
  value: string;
  /** Team name: shrink to fit the box, two lines under `pos.minFontSize`. */
  fitValue?: boolean;
}) {
  const left = imgBounds.x + (pos.x / 100) * imgBounds.width;
  const top = imgBounds.y + (pos.y / 100) * imgBounds.height;
  const widthPct = (pos.width / 100) * imgBounds.width;
  const heightPct = (pos.height / 100) * imgBounds.height;
  const heightPx =
    (heightPct / 100) * (typeof window !== 'undefined' ? window.innerHeight : 0);
  // Text size is authored in the studio layout editor (% of box height); the
  // legacy ratios stay the default so untouched layouts render unchanged.
  const scale =
    typeof pos.textScale === 'number' && pos.textScale > 0
      ? pos.textScale
      : label
        ? DEFAULT_HUD_TEXT_SCALE.withLabel
        : DEFAULT_HUD_TEXT_SCALE.withoutLabel;
  const valueFontSize = Math.max(10, heightPx * (scale / 100));
  const labelFontSize = Math.max(8, valueFontSize * HUD_LABEL_RATIO);
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
      {fitValue ? (
        <TeamNameFit
          text={value}
          maxPx={valueFontSize}
          minPx={readMinFontSize(pos.minFontSize) * ((typeof window !== 'undefined' ? window.innerHeight : 1080) / 1080)}
          textStyle={{ fontWeight: 700 }}
        />
      ) : (
      /* One trimmed block: label top + value baseline centre as a pair. */
      <div className="vcenter-text">
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
      )}
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
    wrongCheckpointIds,
    wrongOrderUrl,
    iconSizePercent,
    hud,
    teamName,
    timerText,
    scoreText,
    showScore,
    legend,
    timeLabel,
    scoreLabel,
    checkpointsSummary,
    language,
    clues,
    cluesCountdownSec,
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
  // The scenario background stays behind it (the map is what simple mode drops,
  // not the whole scene): on a scenario whose font_color is dark, a bare black
  // ground rendered this screen as an apparently blank display - retours #93.
  // A scrim + text shadow keep the summary readable over any background.
  if (displayMode === 'simple' && screen === 'reveal') {
    return (
      <div style={rootStyle}>
        {backgroundUrl && (
          <img
            src={backgroundUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover select-none pointer-events-none"
          />
        )}
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-6 text-center px-10"
          style={{ background: 'rgba(0,0,0,0.55)', textShadow: '0 2px 8px rgba(0,0,0,0.9)' }}
        >
          <div className="text-5xl font-bold">{teamName}</div>
          {showScore && <div className="text-7xl font-extrabold">{scoreText}</div>}
          <div className="text-3xl opacity-90">{checkpointsSummary}</div>
          <div className="text-2xl opacity-75">{timerText}</div>
        </div>
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
          // No image for this status (typically a scenario that never uploaded a
          // "missing checkpoint" image) → draw NOTHING. The old fallback was a
          // green disc, which both looked like a success marker and gave away the
          // position of checkpoints the team never punched. Retours #92.
          if (!url) return null;
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
              <img src={url} alt="" className="w-full h-auto" />
            </div>
          );
        })}

      {/* Author-defined text overlays on the map. Sits ABOVE reveal markers
          (DOM order: rendered after) and BELOW the HUD (rendered before), per
          the design's z-order. Shown on the reveal and the clues map alike;
          background + topreveal + simple already early-returned above. Each
          element's `position` is `% of map image`, identical to the
          checkpoint-marker referential - same math here as for markers. The
          inner TracksTextFit needs pixel dimensions, so we multiply by the
          live window size (kiosk renderer fills the viewport). */}
      {Array.isArray(textElements) && textElements.length > 0 && (
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

      {/* HUD - reveal and clues map. When the studio LayoutEditor has
          saved per-frame positions, each box renders absolutely inside the
          map referential (matching the editor preview exactly). Otherwise we
          fall back to the legacy top strip so scenarios that never opened
          the layout editor still get a usable HUD. */}
      {(
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
                    label={timeLabel}
                    value={timerText}
                  />
                )}
                {placedTeam && (
                  <PositionedHudBox
                    pos={placedTeam}
                    imgBounds={imgBounds}
                    frameUrl={hud.teamNameFrame}
                    value={teamName}
                    fitValue
                  />
                )}
                {placedScore && showScore && (
                  <PositionedHudBox
                    pos={placedScore}
                    imgBounds={imgBounds}
                    frameUrl={hud.scoreFrame}
                    label={scoreLabel}
                    value={scoreText}
                  />
                )}
              </>
            );
          }
          return (
            <div className="absolute top-4 left-0 right-0 flex items-start justify-between px-6 pointer-events-none">
              <HudBox frameUrl={hud.timerFrame} label={timeLabel} value={timerText} />
              <HudBox frameUrl={hud.teamNameFrame} value={teamName} />
              {showScore && <HudBox frameUrl={hud.scoreFrame} label={scoreLabel} value={scoreText} />}
            </div>
          );
        })()
      )}

      {/* Feedback-image legend - under the big reveal (z-40) in full mode. */}
      {legend && (() => {
        // Clues page draws the same status images as the reveal, but only
        // when it shows images at all.
        const rows = (
          isClues && !(clues.enabled && clues.show_image)
            ? []
            : [legend.wrongOrder, legend.missing]
        ).filter((r): r is TracksLegendRow => !!r);
        if (rows.length === 0) return null;
        const { box } = legend;
        const widthPct = (box.width / 100) * imgBounds.width;
        const heightPct = (box.height / 100) * imgBounds.height;
        const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
        return (
          <div
            className="absolute pointer-events-none"
            style={{
              left: `${imgBounds.x + (box.x / 100) * imgBounds.width}%`,
              top: `${imgBounds.y + (box.y / 100) * imgBounds.height}%`,
              width: `${widthPct}%`,
              height: `${heightPct}%`,
            }}
          >
            <TracksLegend
              rows={rows}
              boxWidthPx={(widthPct / 100) * vw}
              boxHeightPx={(heightPct / 100) * vh}
              fontFamily={fontFamily || ''}
              textScale={box.textScale}
            />
          </div>
        );
      })()}

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

      {/* Clues page - the MAP with every route checkpoint drawn at its own
          position: a found checkpoint shows its own image, an unfound one the
          "not found" image, each optionally captioned with its title/text. The
          HUD above stays up (team, time, score). It used to be a black overlay
          with one dark tile per checkpoint, which hid the map - the numbered
          crosses the players need to read the clues (retours sept. #64). */}
      {isClues && clues.enabled &&
        routeCheckpoints.map((cp) => {
          const found = !!foundCheckpointIds?.has(cp.id);
          const imgUrl = clues.show_image
            ? (found
                ? resolveCheckpointImage(cp)
                : wrongCheckpointIds?.has(cp.id)
                  ? (wrongOrderUrl || '')
                  : (missingCheckpointUrl || ''))
            : '';
          // No "#N" fallback for an untitled checkpoint: station numbers are
          // not shown on this page.
          const title = clues.show_title ? readLocalized(cp.title as Localizedish, language) : '';
          const text = clues.show_text ? readLocalized(cp.description as Localizedish, language) : '';
          if (!imgUrl && !title && !text) return null;
          const pos = cp.position ?? { top: 50, left: 50 };
          const left = imgBounds.x + (Number(pos.left) / 100) * imgBounds.width;
          const top = imgBounds.y + (Number(pos.top) / 100) * imgBounds.height;
          const w = (iconSizePercent / 100) * imgBounds.width;
          return (
            <div
              key={cp.id}
              className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center text-center pointer-events-none tracks-fade-in"
              style={{ top: `${top}%`, left: `${left}%`, width: `${w}%` }}
            >
              {imgUrl && <img src={imgUrl} alt="" className="w-full h-auto" />}
              {(title || text) && (
                <div
                  className="mt-1 px-1.5 py-0.5 rounded bg-black/60 leading-tight"
                  style={{ width: 'max-content', maxWidth: '12rem' }}
                >
                  {title && <div className="font-bold text-sm truncate">{title}</div>}
                  {text && <div className="text-xs opacity-85 line-clamp-2">{text}</div>}
                </div>
              )}
            </div>
          );
        })}

      {/* Clues page countdown - seconds left before the page closes itself.
          Sits above the pending-teams line pinned to the bottom edge. */}
      {isClues && cluesCountdownSec != null && cluesCountdownSec > 0 && (
        <div
          className="absolute bottom-14 right-6 z-40 px-3 py-1 rounded-full bg-black/60 text-white text-lg font-bold tabular-nums pointer-events-none"
        >
          {cluesCountdownSec}
        </div>
      )}
    </div>
  );
}
