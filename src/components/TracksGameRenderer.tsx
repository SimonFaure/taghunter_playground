/**
 * Tracks game renderer — the on-screen game surface for the 3 display modes
 * plus the clues page and the end-of-game top-X reveal.
 *
 *   - full:   map + checkpoint markers + a reveal panel (title/desc/image)
 *             for the most-recently-hit checkpoint
 *   - map:    map + markers that light up as they're hit (no reveal panel)
 *   - simple: minimal centered HUD (team name + score + checkpoint count),
 *             no map
 *
 * The clues page (auto-triggered on the team's second bip) always renders as
 * a map-style page with every checkpoint revealed, gated by show_title /
 * show_text / show_image.
 *
 * Design plan: C:\Users\faure\.claude\plans\tracks-game-type-design.md (§6)
 */

import type { TracksCheckpoint } from '../services/tracksScoring';

export type TracksScreen = 'ingame' | 'clues' | 'topreveal';
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

export interface TracksGameRendererProps {
  screen: TracksScreen;
  displayMode: TracksDisplayMode;
  /** Background map image URL (already resolved). */
  mapUrl: string;
  /** Checkpoints that count for the active route, in order. */
  routeCheckpoints: TracksCheckpoint[];
  /** Ids of checkpoints already hit by the focused team. */
  hitCheckpointIds: Set<string>;
  /** The checkpoint to feature in the full-mode reveal panel (most recent hit). */
  revealCheckpointId: string | null;
  /** Resolve a per-checkpoint marker image filename → URL. */
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
    mapUrl,
    routeCheckpoints,
    hitCheckpointIds,
    revealCheckpointId,
    resolveCheckpointImage,
    iconSizePercent,
    hud,
    teamName,
    timerText,
    scoreText,
    showScore,
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

  // --- Top-X reveal: full-screen image (end of game) -------------------------
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

  // --- Simple mode: minimal centered HUD, no map -----------------------------
  if (displayMode === 'simple' && screen === 'ingame') {
    const hitCount = routeCheckpoints.filter((c) => hitCheckpointIds.has(c.id)).length;
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

  // --- Map / Full / Clues all render the map with markers --------------------
  const showRevealPanel = displayMode === 'full' && screen === 'ingame';
  const isClues = screen === 'clues';
  const revealCp = revealCheckpointId
    ? routeCheckpoints.find((c) => c.id === revealCheckpointId) ?? null
    : null;

  return (
    <div style={rootStyle}>
      {/* Map background */}
      {mapUrl && (
        <img
          src={mapUrl}
          alt="map"
          className="absolute inset-0 w-full h-full object-contain select-none pointer-events-none"
        />
      )}

      {/* Checkpoint markers */}
      {routeCheckpoints.map((cp) => {
        const pos = cp.position ?? { top: 50, left: 50 };
        const hit = hitCheckpointIds.has(cp.id) || isClues;
        const img = resolveCheckpointImage(cp);
        return (
          <div
            key={cp.id}
            className="absolute -translate-x-1/2 -translate-y-1/2 transition-opacity duration-500"
            style={{
              top: `${pos.top}%`,
              left: `${pos.left}%`,
              width: `${iconSizePercent}%`,
              opacity: hit ? 1 : 0.25,
              filter: hit ? 'none' : 'grayscale(1)',
            }}
          >
            {img ? (
              <img src={img} alt="" className="w-full h-auto" />
            ) : (
              <div
                className="rounded-full border-2"
                style={{
                  width: '100%',
                  paddingBottom: '100%',
                  borderColor: hit ? '#22c55e' : '#94a3b8',
                  background: hit ? 'rgba(34,197,94,0.4)' : 'rgba(148,163,184,0.2)',
                }}
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

      {/* Full-mode reveal panel for the most-recently-hit checkpoint */}
      {showRevealPanel && revealCp && (
        <div className="absolute bottom-0 left-0 right-0 p-6 bg-black/60 backdrop-blur-sm flex items-center gap-6">
          {resolveCheckpointImage(revealCp) && (
            <img
              src={resolveCheckpointImage(revealCp)}
              alt=""
              className="h-40 w-auto object-contain rounded-lg"
            />
          )}
          <div className="flex-1">
            <div className="text-3xl font-bold">{readLocalized(revealCp.title as Localizedish, language)}</div>
            <div className="text-xl opacity-80 mt-2 whitespace-pre-wrap">
              {readLocalized(revealCp.description as Localizedish, language)}
            </div>
          </div>
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
