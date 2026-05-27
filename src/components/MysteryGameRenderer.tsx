/**
 * Mystery in-game renderer for the playground.
 *
 * Visual architecture is ported verbatim from
 * `studio-taghunter/src/scenarios/preview/MysteryPreviewRenderer.tsx` so the
 * preview and the live playground render at identical positions and font
 * proportions: a single fit-to-canonical stage box centered in the wrapper,
 * with every padding/gap/fontSize expressed as a fraction of stage.height or
 * stage.width.
 *
 * Driven by runtime game state instead of mock state. The instructions and
 * endgame screens are gated by the `screen` prop; the in-game screen uses
 * `selectedEnigmaIndex` (typically the first uncompleted enigma) for the
 * centre column and `completedEnigmas` for the right-column recap blur.
 */

import { useEffect, useRef, useState } from 'react';
import './mystery-renderer.css';

type Localized = Record<string, string>;

export type MysteryScreen = 'instructions' | 'ingame' | 'endgame';

/** Semantic per-enigma scoring result. Drives the colour-blind status marks. */
export type EnigmaStatusKind = 'correct' | 'incorrect' | 'no_answer' | 'both_answers';

export interface MysteryRendererGameMeta {
  background_image?: string;
  team_name_background_image?: string;
  time_background_image?: string;
  score_background_image?: string;
  steps_container_image?: string;
  enigmas_header_image?: string;
  levels_gauge_image?: string;
  levels_gauge_image_with_content?: string;
  levels_gauge_player_icon_image?: string;
  levels_gauge_level_icon_image?: string;
  gauge_filling?: string;
  font_color?: string;
  level_font_color?: string;
  points_units?: string;
  score_full_game?: string;
  game_instructions_image?: string;
  game_instructions_button_image?: string;
  game_instructions_button_hover_image?: string;
  game_refresh_button_image?: string;
  game_refresh_button_hover_image?: string;
  levels?: Record<string, { points?: string; name?: Localized | string; description?: Localized | string }>;
}

export interface MysteryRendererEnigma {
  number: string;
  text: string;
  good_answer_image?: string;
}

export interface MysteryGameRendererProps {
  gameMeta: MysteryRendererGameMeta;
  enigmas: MysteryRendererEnigma[];
  resolveMediaUrl: (filename: string) => string;
  /** Active screen of the gameplay flow. */
  screen: MysteryScreen;
  /** When true on the 'ingame' screen, render only the background — every board
   *  element (timer/score/enigmas/gauge) stays hidden until the reveal fires. */
  boardHidden?: boolean;
  /** Pre-formatted timer string (e.g. "MM:SS"). */
  timerText: string;
  /** Current score (whatever unit `points_units` says). */
  score: number;
  /** Team name shown in the right-column header card. */
  teamName: string;
  /** Enigma numbers (matching `enigma.number`) that have been revealed
   * (unblurred) in the right-column recap and the centre-column image. */
  completedEnigmas: Set<number>;
  /** Per-enigma feedback colour overlays, keyed by `enigma.number`. Used by
   * the end-of-game reveal animation to flash green/red/orange/gray on each
   * cell as the score is tallied. */
  enigmaStatusColors?: Record<string, string>;
  /** Per-enigma semantic result, keyed by `enigma.number`. Populated during the
   * reveal alongside `enigmaStatusColors`; drives the colour-blind status marks. */
  enigmaStatusKinds?: Record<string, EnigmaStatusKind>;
  /** When true, overlay shape-coded status marks (✓ / ✗ / both-biped) on the
   * featured + recap enigma images so colour-blind operators can read each
   * result without relying on the green/red/amber background tint. */
  colorblind?: boolean;
  /** Which enigma to feature in the centre column (0-based). */
  selectedEnigmaIndex: number;
  /** Gauge fill in 0-100. */
  gaugePercent: number;
  /** Click handler for the Instructions screen start button. */
  onStartGame?: () => void;
  /** Click handler for the Endgame screen restart button. */
  onRestart?: () => void;
  /** Pre-formatted final-score line shown on the endgame screen. */
  finalScoreText?: string;
  /** Endgame "reached level" name + description, already localized. */
  endLevelName?: string;
  endLevelDescription?: string;
  /** Canonical authoring viewport. Defaults to 1920x1080. */
  canonicalWidth?: number;
  canonicalHeight?: number;
  /** Scenario-wide font family (Typography section). */
  fontFamily?: string;
}

const DEFAULT_CANONICAL_WIDTH = 1920;
const DEFAULT_CANONICAL_HEIGHT = 1080;

// Fade length (each direction) for the centre "main" enigma image.
const ENIGMA_FADE_MS = 220;

/**
 * Centre "main" enigma image with a fade-out → fade-in between successive
 * enigmas during the reveal. Exactly ONE <img> is mounted at a time, so images
 * never overlap: when the featured enigma changes, the current image fades to
 * transparent, the src swaps while invisible, then the new image fades back in.
 * The first image fades in too (it mounts hidden and is shown on the next
 * frame). `blurred` keeps the existing blur filter (blurred until revealed).
 */
function CenterEnigmaImage({ src, blurred, alt }: { src: string; blurred: boolean; alt: string }) {
  const [shown, setShown] = useState(src); // the src currently in the DOM
  const [visible, setVisible] = useState(false); // drives the opacity fade

  // Fade the freshly-shown image in on the next frame (also handles the first).
  useEffect(() => {
    if (!shown) return;
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [shown]);

  // On a new src: show immediately if nothing is up yet, else fade the current
  // image out first, then swap (the effect above fades the new one back in).
  useEffect(() => {
    if (src === shown) return;
    if (!shown) {
      setShown(src);
      return;
    }
    setVisible(false);
    const t = setTimeout(() => setShown(src), ENIGMA_FADE_MS);
    return () => clearTimeout(t);
  }, [src, shown]);

  if (!shown) return null;
  return (
    <img
      src={shown}
      alt={alt}
      className={blurred ? 'mystery-game-blur' : ''}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        opacity: visible ? 1 : 0,
        transition: `opacity ${ENIGMA_FADE_MS}ms ease`,
      }}
    />
  );
}

/** Crisp white check/cross drawn as SVG so it renders identically regardless of
 *  the scenario's (possibly decorative) font. */
function MarkGlyph({ type, px }: { type: 'check' | 'cross'; px: number }) {
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#ffffff"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.45))' }}
    >
      {type === 'check' ? (
        <path d="M5 13l4 4L19 7" />
      ) : (
        <>
          <path d="M6 6l12 12" />
          <path d="M6 18L18 6" />
        </>
      )}
    </svg>
  );
}

/**
 * Shape-coded status badge pinned to the bottom-right corner of an enigma
 * image. Shown only in colour-blind mode so the result is readable without
 * relying on the green/red/amber background tint:
 *   • correct       → ✓ (green badge)
 *   • incorrect     → ✗ (red badge)
 *   • both_answers  → ✓✗ (amber pill — both stations were biped)
 *   • no_answer     → no badge (nothing was biped)
 * Colour is kept as a secondary cue; the glyph shape carries the meaning.
 */
function StatusMark({ kind, size }: { kind: EnigmaStatusKind; size: number }) {
  if (kind === 'no_answer') return null;
  const bg = kind === 'correct' ? '#16a34a' : kind === 'incorrect' ? '#dc2626' : '#d97706';
  const glyphs: Array<'check' | 'cross'> =
    kind === 'correct' ? ['check'] : kind === 'incorrect' ? ['cross'] : ['check', 'cross'];
  const isPill = glyphs.length > 1;
  return (
    <div
      style={{
        position: 'absolute',
        right: `${size * 0.16}px`,
        bottom: `${size * 0.16}px`,
        height: `${size}px`,
        minWidth: `${size}px`,
        padding: isPill ? `0 ${size * 0.18}px` : 0,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: isPill ? `${size * 0.08}px` : 0,
        background: bg,
        borderRadius: `${size}px`,
        border: `${Math.max(1, size * 0.05)}px solid rgba(255,255,255,0.92)`,
        boxShadow: '0 2px 6px rgba(0,0,0,0.55)',
        zIndex: 5,
        pointerEvents: 'none',
      }}
    >
      {glyphs.map((g, i) => (
        <MarkGlyph key={i} type={g} px={size * 0.62} />
      ))}
    </div>
  );
}

export function MysteryGameRenderer({
  gameMeta,
  enigmas,
  resolveMediaUrl,
  screen,
  boardHidden,
  timerText,
  score,
  teamName,
  completedEnigmas,
  enigmaStatusColors,
  enigmaStatusKinds,
  colorblind,
  selectedEnigmaIndex,
  gaugePercent,
  onStartGame,
  onRestart,
  finalScoreText,
  endLevelName,
  endLevelDescription,
  canonicalWidth = DEFAULT_CANONICAL_WIDTH,
  canonicalHeight = DEFAULT_CANONICAL_HEIGHT,
  fontFamily,
}: MysteryGameRendererProps) {
  const fitWrapperRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  useEffect(() => {
    const wrapper = fitWrapperRef.current;
    if (!wrapper) return;
    const TARGET =
      canonicalWidth > 0 && canonicalHeight > 0 ? canonicalWidth / canonicalHeight : 16 / 9;

    function applyFit() {
      if (!wrapper) return;
      const w = wrapper.clientWidth;
      const h = wrapper.clientHeight;
      if (w <= 0 || h <= 0) return;
      let sw: number, sh: number;
      if (w / h > TARGET) {
        sh = h;
        sw = h * TARGET;
      } else {
        sw = w;
        sh = w / TARGET;
      }
      setStage({ width: sw, height: sh });
    }

    applyFit();
    const ro = new ResizeObserver(applyFit);
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [canonicalWidth, canonicalHeight]);

  const backgroundUrl = gameMeta.background_image ? resolveMediaUrl(gameMeta.background_image) : '';
  const pointsUnits = gameMeta.points_units ?? 'points';
  const scoreFullGame = gameMeta.score_full_game ?? '100';

  // Gauge geometry mirrors MysteryPreviewRenderer so icons + player icon line
  // up with the gradient bar.
  const gaugeBarHeight = stage.height * 0.08;
  const gaugeIconHeight = gaugeBarHeight - 14;
  const gaugeInset = gaugeIconHeight / 2 + 8;
  const gaugeInsetPx = `${gaugeInset}px`;
  const gaugeDoubleInsetPx = `${gaugeInset * 2}px`;

  const cardStyle: React.CSSProperties = {
    width: '100%',
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: gameMeta.font_color || '#ffffff',
    textShadow: '0 1px 4px rgba(0,0,0,0.7)',
  };

  return (
    <div
      ref={fitWrapperRef}
      className="mystery-game-scope"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: '#0f172a',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {backgroundUrl && (
        <img
          src={backgroundUrl}
          alt=""
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'center',
          }}
        />
      )}

      {stage.width > 0 && (
        <div
          style={{
            position: 'relative',
            width: `${stage.width}px`,
            height: `${stage.height}px`,
            fontFamily: fontFamily || 'Arial Black, Arial, sans-serif',
            color: gameMeta.font_color || '#ffffff',
            padding: `${stage.height * 0.02}px ${stage.width * 0.02}px`,
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {screen === 'ingame' && !boardHidden && (
            <>
              {/* Top 3-column row */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 2fr 1fr',
                  gap: `${stage.width * 0.015}px`,
                  flex: 1,
                  minHeight: 0,
                }}
              >
                {/* Left column: timer, score */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: `${stage.height * 0.02}px` }}>
                  <div style={{ ...cardStyle, aspectRatio: '4 / 1' }}>
                    {gameMeta.time_background_image && (
                      <img
                        src={resolveMediaUrl(gameMeta.time_background_image)}
                        alt=""
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                    )}
                    <div style={{ position: 'relative', fontSize: `${stage.height * 0.045}px`, fontWeight: 'bold' }}>
                      {timerText}
                    </div>
                  </div>

                  <div style={{ ...cardStyle, aspectRatio: '4 / 1' }}>
                    {gameMeta.score_background_image && (
                      <img
                        src={resolveMediaUrl(gameMeta.score_background_image)}
                        alt=""
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                    )}
                    <div style={{ position: 'relative', fontSize: `${stage.height * 0.045}px`, fontWeight: 'bold' }}>
                      {score}
                      {pointsUnits === 'percentage' ? '%' : `/${scoreFullGame}`}
                    </div>
                  </div>
                </div>

                {/* Centre column: ONE big enigma — text on top, image below. */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'stretch',
                    gap: `${stage.height * 0.02}px`,
                    overflow: 'hidden',
                    minHeight: 0,
                  }}
                >
                  {(() => {
                    const enigma = enigmas[selectedEnigmaIndex];
                    if (!enigma) {
                      return (
                        <div style={{ fontSize: `${stage.height * 0.025}px`, opacity: 0.5, textAlign: 'center' }}>
                          No enigma to display
                        </div>
                      );
                    }
                    const imgSrc = enigma.good_answer_image ? resolveMediaUrl(enigma.good_answer_image) : '';
                    const text = enigma.text || `Enigma ${enigma.number ?? selectedEnigmaIndex + 1}`;
                    const revealed = completedEnigmas.has(parseInt(enigma.number, 10));
                    const featuredOverlay = enigmaStatusColors?.[enigma.number];
                    const featuredKind = enigmaStatusKinds?.[enigma.number];
                    return (
                      <>
                        <div
                          style={{
                            fontSize: `${stage.height * 0.05}px`,
                            fontWeight: 'bold',
                            textAlign: 'center',
                            textShadow: '0 1px 4px rgba(0,0,0,0.7)',
                            padding: `0 ${stage.width * 0.01}px`,
                            flexShrink: 0,
                          }}
                        >
                          {text}
                        </div>
                        {/* Flexible area that centres a SQUARE tile so the
                            green/red/amber status tint hugs the (square) enigma
                            image instead of filling a wide rectangle. */}
                        <div
                          style={{
                            flex: '1 1 0',
                            width: '100%',
                            minHeight: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <div
                            style={{
                              position: 'relative',
                              height: '100%',
                              aspectRatio: '1 / 1',
                              maxWidth: '100%',
                              background: featuredOverlay || 'rgba(255,255,255,0.06)',
                              borderRadius: 12,
                              overflow: 'hidden',
                              transition: 'background 0.3s ease',
                            }}
                          >
                            {imgSrc && (
                              <CenterEnigmaImage src={imgSrc} blurred={!revealed} alt={text} />
                            )}
                            {colorblind && featuredKind && (
                              <StatusMark kind={featuredKind} size={stage.height * 0.075} />
                            )}
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* Right column: team name + enigmas header + recap grid */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: `${stage.height * 0.012}px`, minHeight: 0 }}>
                  <div style={{ ...cardStyle, aspectRatio: '4 / 1' }}>
                    {gameMeta.team_name_background_image && (
                      <img
                        src={resolveMediaUrl(gameMeta.team_name_background_image)}
                        alt=""
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                    )}
                    <div style={{ position: 'relative', fontSize: `${stage.height * 0.04}px`, fontWeight: 'bold' }}>
                      {teamName}
                    </div>
                  </div>

                  {gameMeta.enigmas_header_image && (
                    <div style={{ ...cardStyle, aspectRatio: '5 / 1' }}>
                      <img
                        src={resolveMediaUrl(gameMeta.enigmas_header_image)}
                        alt=""
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                    </div>
                  )}

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, 1fr)',
                      gap: `${stage.height * 0.008}px`,
                      flex: 1,
                      alignContent: 'start',
                      overflow: 'hidden',
                    }}
                  >
                    {enigmas.map((enigma, idx) => {
                      const imgSrc = enigma.good_answer_image ? resolveMediaUrl(enigma.good_answer_image) : '';
                      const revealed = completedEnigmas.has(parseInt(enigma.number, 10));
                      const overlay = enigmaStatusColors?.[enigma.number];
                      const overlayKind = enigmaStatusKinds?.[enigma.number];
                      return (
                        <div
                          key={`recap-${enigma.number ?? idx}`}
                          style={{
                            width: '100%',
                            aspectRatio: '1 / 1',
                            position: 'relative',
                            background: overlay || 'rgba(255,255,255,0.06)',
                            borderRadius: 4,
                            overflow: 'hidden',
                            transition: 'background 0.3s ease',
                          }}
                        >
                          {imgSrc && (
                            <img
                              src={imgSrc}
                              alt=""
                              className={revealed ? '' : 'mystery-game-blur'}
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                          )}
                          {colorblind && overlayKind && (
                            <StatusMark kind={overlayKind} size={stage.height * 0.04} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Bottom: level gauge. Outer wrapper is taller than the gauge
                  bar so level icons + labels that overflow the bar stay
                  visible without clipping. The inner div IS the gauge bar. */}
              <div
                style={{
                  position: 'relative',
                  height: `${stage.height * 0.18}px`,
                  marginTop: `${stage.height * 0.01}px`,
                  display: 'flex',
                  alignItems: 'center',
                  flexShrink: 0,
                }}
              >
                <div style={{ position: 'relative', width: '100%', height: `${stage.height * 0.08}px` }}>
                  {gameMeta.levels_gauge_image && (
                    <img
                      src={resolveMediaUrl(gameMeta.levels_gauge_image)}
                      alt=""
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'fill',
                      }}
                    />
                  )}
                  <div
                    style={{
                      position: 'absolute',
                      left: gaugeInsetPx,
                      top: 7,
                      bottom: 7,
                      width: `calc((100% - ${gaugeDoubleInsetPx}) * ${Math.max(0, Math.min(100, gaugePercent)) / 100})`,
                      background: gameMeta.gauge_filling || 'linear-gradient(90deg, #ffc700 0%, #fee300 100%)',
                      opacity: 0.85,
                      borderRadius: 6,
                    }}
                  />
                  {gameMeta.levels_gauge_image_with_content && (
                    <img
                      src={resolveMediaUrl(gameMeta.levels_gauge_image_with_content)}
                      alt=""
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'fill',
                        pointerEvents: 'none',
                      }}
                    />
                  )}

                  {(() => {
                    const fullGame = parseFloat(scoreFullGame) || 0;
                    if (fullGame <= 0) return null;
                    const iconUrl = gameMeta.levels_gauge_level_icon_image
                      ? resolveMediaUrl(gameMeta.levels_gauge_level_icon_image)
                      : '';
                    const iconHeight = gaugeIconHeight;
                    const fontSize = stage.height * 0.018;
                    const barHeight = stage.height * 0.012;
                    const labelOffset = iconHeight / 2 + barHeight;
                    const levelTextColor = gameMeta.level_font_color || '#ffffff';
                    const entries = Object.entries(gameMeta.levels ?? {});
                    const nodes: React.ReactNode[] = [];
                    entries.forEach(([key, level], idx) => {
                      const pts = parseFloat(level?.points ?? '0') || 0;
                      // Levels are hidden by default and only appear once the
                      // team's score reaches them — during the reveal each level
                      // pops in as the running tally crosses its threshold.
                      if (score < pts) return;
                      const clamped = Math.max(0, Math.min(fullGame, pts));
                      const fraction = clamped / fullGame;
                      const isTop = idx % 2 === 0;
                      const name = level?.name
                        ? (typeof level.name === 'string' ? level.name : Object.values(level.name)[0] ?? '')
                        : '';
                      const leftCalc = `calc(${gaugeInsetPx} + (100% - ${gaugeDoubleInsetPx}) * ${fraction})`;

                      if (iconUrl) {
                        nodes.push(
                          <img
                            key={`lvl-icon-${key}`}
                            src={iconUrl}
                            alt=""
                            style={{
                              position: 'absolute',
                              left: leftCalc,
                              top: '50%',
                              transform: 'translate(-50%, -50%)',
                              height: `${iconHeight}px`,
                              width: 'auto',
                              pointerEvents: 'none',
                              zIndex: 2,
                            }}
                          />,
                        );
                      } else {
                        nodes.push(
                          <div
                            key={`lvl-dot-${key}`}
                            style={{
                              position: 'absolute',
                              left: leftCalc,
                              top: '50%',
                              transform: 'translate(-50%, -50%)',
                              width: `${iconHeight}px`,
                              height: `${iconHeight}px`,
                              borderRadius: '50%',
                              background: levelTextColor,
                              opacity: 0.85,
                              pointerEvents: 'none',
                              zIndex: 2,
                            }}
                          />,
                        );
                      }

                      if (name) {
                        nodes.push(
                          <div
                            key={`lvl-bar-${key}`}
                            style={{
                              position: 'absolute',
                              left: leftCalc,
                              top: isTop
                                ? `calc(50% - ${iconHeight / 2 + barHeight}px)`
                                : `calc(50% + ${iconHeight / 2}px)`,
                              width: 2,
                              height: `${barHeight}px`,
                              transform: 'translateX(-50%)',
                              background: levelTextColor,
                              opacity: 0.9,
                              pointerEvents: 'none',
                              zIndex: 2,
                            }}
                          />,
                        );
                        nodes.push(
                          <div
                            key={`lvl-label-${key}`}
                            style={{
                              position: 'absolute',
                              left: leftCalc,
                              top: isTop
                                ? `calc(50% - ${labelOffset + fontSize * 1.1}px)`
                                : `calc(50% + ${labelOffset}px)`,
                              transform: 'translateX(-50%)',
                              fontSize: `${fontSize}px`,
                              whiteSpace: 'nowrap',
                              textShadow: '0 1px 4px rgba(0,0,0,0.8)',
                              color: levelTextColor,
                              lineHeight: 1.1,
                              pointerEvents: 'none',
                              zIndex: 2,
                            }}
                          >
                            {name}
                          </div>,
                        );
                      }
                    });
                    return nodes;
                  })()}

                  {gameMeta.levels_gauge_player_icon_image && (() => {
                    const fraction = Math.max(0, Math.min(100, gaugePercent)) / 100;
                    return (
                      <img
                        src={resolveMediaUrl(gameMeta.levels_gauge_player_icon_image)}
                        alt=""
                        style={{
                          position: 'absolute',
                          left: `calc(${gaugeInsetPx} + (100% - ${gaugeDoubleInsetPx}) * ${fraction})`,
                          top: 7,
                          height: 'calc(100% - 14px)',
                          width: 'auto',
                          transform: 'translateX(-50%)',
                          pointerEvents: 'none',
                          zIndex: 3,
                        }}
                      />
                    );
                  })()}
                </div>
              </div>
            </>
          )}

          {screen === 'instructions' && (() => {
            const buttonImg = gameMeta.game_instructions_button_image
              ? resolveMediaUrl(gameMeta.game_instructions_button_image)
              : '';
            const buttonHoverImg = gameMeta.game_instructions_button_hover_image
              ? resolveMediaUrl(gameMeta.game_instructions_button_hover_image)
              : '';
            const instrImg = gameMeta.game_instructions_image
              ? resolveMediaUrl(gameMeta.game_instructions_image)
              : '';
            return (
              <div
                style={{
                  position: 'relative',
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                }}
              >
                {instrImg && (
                  <img
                    src={instrImg}
                    alt=""
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                    }}
                  />
                )}
                {(buttonImg || buttonHoverImg) && (
                  <div
                    className="mystery-game-instructions-button"
                    onClick={onStartGame}
                    style={{
                      position: 'absolute',
                      bottom: `${stage.height * 0.05}px`,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      width: `${stage.height * 0.18}px`,
                      height: `${stage.height * 0.18}px`,
                      cursor: onStartGame ? 'pointer' : 'default',
                    }}
                  >
                    {buttonImg && (
                      <img
                        src={buttonImg}
                        alt="start"
                        className="mystery-game-button-default"
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                    )}
                    {buttonHoverImg && (
                      <img
                        src={buttonHoverImg}
                        alt="start"
                        className="mystery-game-button-hover"
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', opacity: 0 }}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {screen === 'endgame' && (() => {
            const refreshImg = gameMeta.game_refresh_button_image
              ? resolveMediaUrl(gameMeta.game_refresh_button_image)
              : '';
            const refreshHoverImg = gameMeta.game_refresh_button_hover_image
              ? resolveMediaUrl(gameMeta.game_refresh_button_hover_image)
              : '';
            return (
              <div
                style={{
                  position: 'relative',
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: `${stage.height * 0.025}px`,
                  textAlign: 'center',
                  padding: `${stage.height * 0.04}px ${stage.width * 0.06}px`,
                  boxSizing: 'border-box',
                  overflow: 'hidden',
                }}
              >
                <div style={{ fontSize: `${stage.height * 0.04}px`, textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>
                  Your final score:
                </div>
                <div
                  style={{
                    fontSize: `${stage.height * 0.12}px`,
                    fontWeight: 'bold',
                    color: '#4ade80',
                    textShadow: '0 2px 8px rgba(0,0,0,0.8)',
                    lineHeight: 1,
                  }}
                >
                  {finalScoreText ?? `${score}`}
                </div>
                {endLevelName && (
                  <div
                    style={{
                      fontSize: `${stage.height * 0.045}px`,
                      fontWeight: 'bold',
                      color: gameMeta.level_font_color || '#ffffff',
                      textShadow: '0 1px 4px rgba(0,0,0,0.8)',
                    }}
                  >
                    {endLevelName}
                  </div>
                )}
                {endLevelDescription && (
                  <div
                    style={{
                      fontSize: `${stage.height * 0.022}px`,
                      maxWidth: `${stage.width * 0.7}px`,
                      lineHeight: 1.3,
                      textShadow: '0 1px 4px rgba(0,0,0,0.8)',
                      opacity: 0.95,
                    }}
                  >
                    {endLevelDescription}
                  </div>
                )}
                {(refreshImg || refreshHoverImg) && (
                  <div
                    className="mystery-game-instructions-button"
                    onClick={onRestart}
                    style={{
                      position: 'relative',
                      width: `${stage.height * 0.14}px`,
                      height: `${stage.height * 0.14}px`,
                      marginTop: `${stage.height * 0.02}px`,
                      cursor: onRestart ? 'pointer' : 'default',
                    }}
                  >
                    {refreshImg && (
                      <img
                        src={refreshImg}
                        alt="refresh"
                        className="mystery-game-button-default"
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                    )}
                    {refreshHoverImg && (
                      <img
                        src={refreshHoverImg}
                        alt="refresh"
                        className="mystery-game-button-hover"
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', opacity: 0 }}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
