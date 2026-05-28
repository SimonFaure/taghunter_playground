/**
 * Tracks game renderer — the on-screen game surface.
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
  /** Map image URL (already resolved) — the reveal surface. */
  mapUrl: string;
  /** Checkpoints that count for the active route, in order (positions + clues). */
  routeCheckpoints: TracksCheckpoint[];
  /** cpId → resolved per-status image URL currently placed on the map (accumulates). */
  placedCheckpoints: Map<string, string>;
  /** Full-mode center reveal for the current checkpoint, or null. */
  bigReveal: TracksBigReveal | null;
  /** Resolve a checkpoint's own image filename → URL (clues page). */
  resolveCheckpointImage: (cp: TracksCheckpoint) => string;
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
  } = props;

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
  // this rect — NOT against the full viewport — to land where the editor showed.
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

      {/* Reveal markers — only the checkpoints already placed on the map, each
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
              className="absolute -translate-x-1/2 -translate-y-1/2 transition-opacity duration-300"
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

      {/* Top HUD strip (team / timer / score) — hidden on the clues page */}
      {!isClues && (
        <div className="absolute top-4 left-0 right-0 flex items-start justify-between px-6 pointer-events-none">
          <HudBox frameUrl={hud.timerFrame} label="Time" value={timerText} />
          <HudBox frameUrl={hud.teamNameFrame} value={teamName} />
          {showScore && <HudBox frameUrl={hud.scoreFrame} label="Score" value={scoreText} />}
        </div>
      )}

      {/* Full-mode big-center reveal for the current checkpoint */}
      {screen === 'reveal' && bigReveal && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center px-10 pointer-events-none" style={{ background: 'rgba(0,0,0,0.45)' }}>
          {bigReveal.imageUrl && (
            <img
              src={bigReveal.imageUrl}
              alt=""
              className="max-w-[60%] max-h-[60%] object-contain"
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

      {/* Clues page — list every checkpoint with the enabled elements */}
      {isClues && clues.enabled && (
        <div className="absolute inset-0 bg-black/70 overflow-auto p-8">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {routeCheckpoints.map((cp, i) => (
              <div key={cp.id} className="bg-black/50 rounded-lg p-3 flex flex-col items-center text-center">
                {clues.show_image && resolveCheckpointImage(cp) && (
                  <img src={resolveCheckpointImage(cp)} alt="" className="h-24 w-auto object-contain mb-2" />
                )}
                {clues.show_title && (
                  <div className="font-bold">
                    {readLocalized(cp.title as Localizedish, language) || `#${i + 1}`}
                  </div>
                )}
                {clues.show_text && (
                  <div className="text-sm opacity-80 whitespace-pre-wrap">
                    {readLocalized(cp.description as Localizedish, language)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
