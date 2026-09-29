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
import { resolveFontFamily } from '../fonts/resolveFontFamily';
import {
  IDLE_ROLES,
  INGAME_ROLES,
  MysteryFixedFrames,
  MysteryIdleBox,
  MysteryLayoutBox,
  MysteryStatusPlate,
  resolveIdleLayout,
  resolveIngameLayout,
  resolveMysteryBonusBox,
  resolveMysteryGaugeGeometry,
  resolveMysteryStatusFrame,
  resolveMysteryUnderlayScale,
  resolveMysteryEnigmaImageScale,
  resolveMysteryUnderlayOffset,
  resolveMysteryEnigmaImageOffset,
  mysteryCenteredBox,
  type IdleLayout,
  type IngameFrames,
  type IngameLayout,
  type IngameRoleKey,
} from './mysteryIngameLayout';
import type { MysteryBonusTier } from '../services/mysteryBonuses';
import { reachedMysteryBonuses } from '../services/mysteryBonuses';

type Localized = Record<string, string>;

export type MysteryScreen = 'ingame' | 'endgame';

/** Semantic per-enigma scoring result. Drives the colour-blind status marks. */
export type EnigmaStatusKind = 'correct' | 'incorrect' | 'no_answer' | 'both_answers';

export interface MysteryRendererGameMeta {
  background_image?: string;
  team_name_background_image?: string;
  time_background_image?: string;
  score_background_image?: string;
  /** The "empty bonus" plate: on screen for the whole run, replaced by each
   *  overscore tier's image as the team unlocks it. */
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
  game_refresh_button_image?: string;
  game_refresh_button_hover_image?: string;
  /** Game-level images for the "both answers biped" / "no answer" enigma states.
   *  Empty → fall back to the per-enigma good-answer image (status tint still applies). */
  both_answers_image?: string;
  no_answer_image?: string;
  levels?: Record<string, { points?: string; name?: Localized | string; description?: Localized | string }>;
  /** Author-placed positions for the 4 in-game text roles. Absent → defaults. */
  ingame_layout?: IngameLayout;
  /** Author-placed rectangles for the timer/score/team-name frame images.
   *  Absent → the historical fixed positions. */
  ingame_frames?: IngameFrames;
  /** Author-placed styled title/subtitle for the idle (between-teams) screen. */
  idle_layout?: IdleLayout;
  /** Author-tunable gauge fill geometry (see resolveMysteryGaugeGeometry). */
  gauge_fill_inset_left?: string;
  gauge_fill_inset_right?: string;
  gauge_fill_inset_y?: string;
  gauge_fill_radius?: string;
  /** Author-tunable result sub-frame - the green/red/amber/grey plate behind
   *  (and, faintly, over) each enigma image. See resolveMysteryStatusFrame. */
  status_frame_scale?: string;
  status_frame_radius?: string;
  status_frame_over_image?: string;
  /** Size of the main-image underlay (see resolveMysteryUnderlayScale). */
  enigma_underlay_scale?: string;
  /** Size of the main image itself (see resolveMysteryEnigmaImageScale). */
  enigma_image_scale?: string;
  /** Positions of the underlay / image (see resolveMysteryUnderlayOffset). */
  enigma_underlay_offset_x?: string;
  enigma_underlay_offset_y?: string;
  enigma_image_offset_x?: string;
  enigma_image_offset_y?: string;
}

export interface MysteryRendererEnigma {
  number: string;
  text: string;
  good_answer_image?: string;
  /** Shown (instead of the good-answer image) when this enigma was answered
   *  incorrectly, so the recap reflects what the team actually biped. Falls
   *  back to the good-answer image when no wrong-answer image was authored. */
  wrong_answer_image?: string;
}

export interface MysteryGameRendererProps {
  gameMeta: MysteryRendererGameMeta;
  enigmas: MysteryRendererEnigma[];
  resolveMediaUrl: (filename: string) => string;
  /** Active screen of the gameplay flow. */
  screen: MysteryScreen;
  /** When true on the 'ingame' screen, render only the background - every board
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
  /** Click handler for the Endgame screen restart button. */
  onRestart?: () => void;
  /** When set, the in-game centre column shows the end-of-run summary (final
   *  score, level, team name + a reset button) in place of the big enigma image.
   *  Populated once a reveal animation has finished (or instantly on a finished
   *  card's re-bip). Null/undefined → the centre shows the featured enigma. */
  summary?: {
    teamName: string;
    finalScoreText: string;
    levelName?: string;
    levelDescription?: string;
    /** Optional small footnote shown at the bottom of the board (e.g. the
     *  card-reuse cooldown notice on a finished card's re-bip). */
    note?: string;
  } | null;
  /** Click handler for the summary's reset button (returns the board to idle). */
  onReset?: () => void;
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
  /** Scenario name - text of the idle screen's title element. */
  scenarioTitle?: string;
  /** Whether to render the author-placed idle layout (title/subtitle) between
   *  teams. When false, the idle screen shows the background only. Defaults to true. */
  showIdleLayout?: boolean;
  /** Fades the idle title/subtitle out while a full-screen game message is on
   *  screen. Both are big bold centred text, so "C'est parti !" landing on top
   *  of the scenario title left the two unreadable (retour #82). */
  idleTextHidden?: boolean;
  /** Per-launch subtitle - text of the idle screen's subtitle element. */
  idleSubtitle?: string;
  /** Bonus ("overscore") tiers authored for this scenario, names already
   *  localized (see `services/mysteryBonuses`). The renderer shows the ones
   *  whose threshold `score` has passed - i.e. only teams that beat
   *  `score_full_game` ever see anything here. */
  bonuses?: readonly MysteryBonusTier[];
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
 *   • both_answers  → ✓✗ (amber pill - both stations were biped)
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

/**
 * Which image to feature for an enigma in the recap, by verdict:
 *   • incorrect    → the per-enigma wrong-answer image (so the recap reflects
 *                    what the team actually biped)
 *   • both_answers → the game-level "both answers" image
 *   • no_answer    → the game-level "no answer" image
 *   • correct      → the per-enigma good-answer image
 * Each state-specific image falls back to the per-enigma good-answer image when
 * not authored; the green/red/amber/gray tint still carries the verdict either way.
 */
function pickEnigmaImage(
  enigma: MysteryRendererEnigma,
  gameMeta: MysteryRendererGameMeta,
  kind?: EnigmaStatusKind,
): string {
  if (kind === 'incorrect' && enigma.wrong_answer_image) return enigma.wrong_answer_image;
  if (kind === 'both_answers' && gameMeta.both_answers_image) return gameMeta.both_answers_image;
  if (kind === 'no_answer' && gameMeta.no_answer_image) return gameMeta.no_answer_image;
  return enigma.good_answer_image ?? '';
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
  onRestart,
  summary,
  onReset,
  finalScoreText,
  endLevelName,
  endLevelDescription,
  canonicalWidth = DEFAULT_CANONICAL_WIDTH,
  canonicalHeight = DEFAULT_CANONICAL_HEIGHT,
  fontFamily,
  scenarioTitle,
  showIdleLayout = true,
  idleTextHidden,
  idleSubtitle,
  bonuses,
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
  const gauge = resolveMysteryGaugeGeometry(gameMeta, stage.height);

  // Bonus tiers unlocked by the score currently on the board. Only the HIGHEST
  // one is drawn: tiers replace each other on a single plate rather than piling
  // up side by side, which is what the legacy renderer did (every
  // `.team_bonus_container` was absolutely positioned on the same spot, the
  // later one covering the earlier). Under them the "empty bonus" plate is
  // visible for the whole run. Retour #35.
  // Result sub-frame geometry (retours #83 + #85): how big the verdict plate is
  // inside each enigma tile, how round it is, and how much of it is repeated
  // over the artwork so an opaque image can't swallow the colour.
  const statusFrame = resolveMysteryStatusFrame(gameMeta);

  // Size of the square underlay each enigma's main image sits on, authored in
  // the studio (`enigma_underlay_scale`). The board honours the SIZE but never
  // paints the neutral, verdict-less layer: a white slab behind the artwork is
  // not wanted in-game, so `MYSTERY_STATUS_NEUTRAL` is no longer used here.
  const underlayScale = resolveMysteryUnderlayScale(gameMeta);
  // The main image's own size. It used to be the underlay's (the image filled
  // the tile), so resizing the sub-frame resized the picture (retour 2026-09-16).
  const imageScale = resolveMysteryEnigmaImageScale(gameMeta);
  // Their positions (retours sept. #38): each box can be moved off-centre.
  const underlayOffset = resolveMysteryUnderlayOffset(gameMeta);
  const imageOffset = resolveMysteryEnigmaImageOffset(gameMeta);

  const reachedBonuses = reachedMysteryBonuses(bonuses ?? [], score);
  const activeBonus = reachedBonuses.length > 0 ? reachedBonuses[reachedBonuses.length - 1] : null;
  const emptyBonusUrl = gameMeta.steps_container_image
    ? resolveMediaUrl(gameMeta.steps_container_image)
    : '';
  // Where the bonus plate sits. Author-placed like the other image blocks; the
  // default box is the board grid's left cell, i.e. exactly where it used to be
  // pinned. The board keeps that cell as an empty spacer so the enigma and the
  // recap column don't move when the plate is dragged elsewhere.
  const bonusBox = resolveMysteryBonusBox(gameMeta.ingame_frames);

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
          {/* Idle screen - background only (drawn at the root) plus the author-placed
              title/subtitle. Shown between teams when the board is hidden (i.e. "reveal
              results on Enter/click" is off and no reveal is playing). Title text =
              scenario name, subtitle text = per-launch field.
              When the scenario didn't author any idle element (the in-game layout editor
              leaves both disabled by default), "Show idle layout when idle" falls back to
              the default positions so the operator still sees the title/subtitle. */}
          {screen === 'ingame' && boardHidden && showIdleLayout && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                // Faded out while a full-screen message is up: the idle title and
                // "C'est parti !" are both big bold centred text and were landing
                // on top of each other (retour #82).
                opacity: idleTextHidden ? 0 : 1,
                transition: 'opacity 0.2s ease',
                pointerEvents: 'none',
              }}
            >
              {(() => {
                const idle = resolveIdleLayout(gameMeta.idle_layout);
                const authored = idle.title.enabled || idle.subtitle.enabled;
                const fallbackFont = fontFamily || 'Arial Black, Arial, sans-serif';
                const fallbackColor = gameMeta.font_color || '#ffffff';
                const textByRole: Record<string, string> = {
                  title: scenarioTitle ?? '',
                  subtitle: idleSubtitle ?? '',
                };
                return IDLE_ROLES.map((role) => {
                  const el = idle[role.key];
                  // Respect the author's per-element enable flags when they configured
                  // an idle layout; otherwise (nothing authored) render every role
                  // with text.
                  if (authored && !el.enabled) return null;
                  const text = textByRole[role.key];
                  if (!text) return null;
                  return (
                    <MysteryIdleBox
                      key={role.key}
                      element={el}
                      stageHeight={stage.height}
                      text={text}
                      fallbackFontFamily={fallbackFont}
                      fallbackColor={fallbackColor}
                      resolveFont={resolveFontFamily}
                    />
                  );
                });
              })()}
            </div>
          )}
          {screen === 'ingame' && !boardHidden && summary?.note && (
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: `${stage.height * 0.02}px`,
                textAlign: 'center',
                fontSize: `${stage.height * 0.022}px`,
                opacity: 0.8,
                textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                pointerEvents: 'none',
                padding: `0 ${stage.width * 0.05}px`,
                boxSizing: 'border-box',
              }}
            >
              {summary.note}
            </div>
          )}
          {screen === 'ingame' && !boardHidden && (
            <>
              {/* Top band reserved for the title elements (enigma name centre,
                  team name right, timer/score left). The board below starts under
                  them: enigma image under the enigma title, recap list under the
                  team title. */}
              <div style={{ height: `${stage.height * 0.12}px`, flexShrink: 0 }} />

              {/* Board row: centre = enigma image (under enigma title),
                  right = recap list (under team title). */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 2fr 1fr',
                  gap: `${stage.width * 0.015}px`,
                  flex: 1,
                  minHeight: 0,
                }}
              >
                {/* Left column: an empty spacer. The bonus plate that used to
                    live here is now an author-placed overlay (drawn after the
                    board, below) - the cell stays so the centre enigma image and
                    the right recap keep their fixed positions.
                    Timer + score are author-placed overlays too. */}
                <div />

                {/* Centre column: ONE big enigma - text on top, image below.
                    Once a run's reveal has finished, the end-of-run summary
                    (final score / level / team name + reset) takes this slot
                    instead of the featured enigma image. */}
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
                  {summary ? (
                    <div
                      style={{
                        flex: '1 1 0',
                        minHeight: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: `${stage.height * 0.02}px`,
                        textAlign: 'center',
                        padding: `${stage.height * 0.02}px`,
                        boxSizing: 'border-box',
                      }}
                    >
                      {summary.teamName && (
                        <div
                          style={{
                            fontSize: `${stage.height * 0.045}px`,
                            fontWeight: 'bold',
                            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
                            lineHeight: 1.1,
                          }}
                        >
                          {summary.teamName}
                        </div>
                      )}
                      <div
                        style={{
                          fontSize: `${stage.height * 0.1}px`,
                          fontWeight: 'bold',
                          color: '#4ade80',
                          textShadow: '0 2px 8px rgba(0,0,0,0.8)',
                          lineHeight: 1,
                        }}
                      >
                        {summary.finalScoreText}
                      </div>
                      {summary.levelName && (
                        <div
                          style={{
                            fontSize: `${stage.height * 0.04}px`,
                            fontWeight: 'bold',
                            color: gameMeta.level_font_color || '#ffffff',
                            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
                          }}
                        >
                          {summary.levelName}
                        </div>
                      )}
                      {summary.levelDescription && (
                        <div
                          style={{
                            fontSize: `${stage.height * 0.02}px`,
                            maxWidth: '95%',
                            lineHeight: 1.3,
                            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
                            opacity: 0.95,
                          }}
                        >
                          {summary.levelDescription}
                        </div>
                      )}
                      {(() => {
                        const refreshImg = gameMeta.game_refresh_button_image
                          ? resolveMediaUrl(gameMeta.game_refresh_button_image)
                          : '';
                        const refreshHoverImg = gameMeta.game_refresh_button_hover_image
                          ? resolveMediaUrl(gameMeta.game_refresh_button_hover_image)
                          : '';
                        if (refreshImg || refreshHoverImg) {
                          return (
                            <div
                              className="mystery-game-instructions-button"
                              onClick={onReset}
                              style={{
                                position: 'relative',
                                width: `${stage.height * 0.13}px`,
                                height: `${stage.height * 0.13}px`,
                                marginTop: `${stage.height * 0.01}px`,
                                cursor: onReset ? 'pointer' : 'default',
                              }}
                            >
                              {refreshImg && (
                                <img
                                  src={refreshImg}
                                  alt="reset"
                                  className="mystery-game-button-default"
                                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
                                />
                              )}
                              {refreshHoverImg && (
                                <img
                                  src={refreshHoverImg}
                                  alt="reset"
                                  className="mystery-game-button-hover"
                                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', opacity: 0 }}
                                />
                              )}
                            </div>
                          );
                        }
                        return (
                          <button
                            type="button"
                            onClick={onReset}
                            style={{
                              marginTop: `${stage.height * 0.015}px`,
                              padding: `${stage.height * 0.012}px ${stage.width * 0.02}px`,
                              fontSize: `${stage.height * 0.022}px`,
                              fontWeight: 'bold',
                              fontFamily: 'inherit',
                              color: '#ffffff',
                              background: 'rgba(0,0,0,0.45)',
                              border: '2px solid rgba(255,255,255,0.7)',
                              borderRadius: 8,
                              cursor: onReset ? 'pointer' : 'default',
                            }}
                          >
                            ↻
                          </button>
                        );
                      })()}
                    </div>
                  ) : (() => {
                    const enigma = enigmas[selectedEnigmaIndex];
                    if (!enigma) {
                      return (
                        <div style={{ fontSize: `${stage.height * 0.025}px`, opacity: 0.5, textAlign: 'center' }}>
                          No enigma to display
                        </div>
                      );
                    }
                    const text = enigma.text || `Enigma ${enigma.number ?? selectedEnigmaIndex + 1}`;
                    const revealed = completedEnigmas.has(parseInt(enigma.number, 10));
                    const featuredOverlay = enigmaStatusColors?.[enigma.number];
                    const featuredKind = enigmaStatusKinds?.[enigma.number];
                    const displayImage = pickEnigmaImage(enigma, gameMeta, featuredKind);
                    const imgSrc = displayImage ? resolveMediaUrl(displayImage) : '';
                    return (
                      <>
                        {/* Enigma name is now an author-placed overlay (below);
                            the centre column shows only the featured image. */}
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
                          {/* The full square available to the main image.
                              The underlay (sub-frame) and the image are two
                              SEPARATE centred boxes inside it, each with its
                              own scale (retour 2026-09-16). */}
                          <div
                            style={{
                              position: 'relative',
                              height: '100%',
                              aspectRatio: '1 / 1',
                              maxWidth: '100%',
                              overflow: 'hidden',
                            }}
                          >
                            {/* Underlay: drawn ONLY once the enigma has a
                                verdict. The old neutral fallback painted a white
                                plate behind every un-answered image - a white
                                slab under the artwork is never wanted in-game. */}
                            {featuredOverlay && (
                              <div style={mysteryCenteredBox(underlayScale, underlayOffset)}>
                                <MysteryStatusPlate
                                  color={featuredOverlay}
                                  frame={statusFrame}
                                  legacyRadius={12}
                                />
                              </div>
                            )}
                            {imgSrc && (
                              <div style={mysteryCenteredBox(imageScale, imageOffset)}>
                                <CenterEnigmaImage src={imgSrc} blurred={!revealed} alt={text} />
                              </div>
                            )}
                            {/* Same tint repeated over the artwork so a picture
                                exported on an opaque background still shows its
                                verdict colour (retour #83). */}
                            {featuredOverlay && (
                              <div style={mysteryCenteredBox(underlayScale, underlayOffset)}>
                                <MysteryStatusPlate
                                  color={featuredOverlay}
                                  frame={statusFrame}
                                  legacyRadius={12}
                                  over
                                />
                              </div>
                            )}
                            {colorblind && featuredKind && (
                              <div style={mysteryCenteredBox(underlayScale, underlayOffset)}>
                                <StatusMark kind={featuredKind} size={stage.height * 0.075} />
                              </div>
                            )}
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* Right column: enigmas header + recap grid. Team name is now
                    an author-placed overlay (see below). */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: `${stage.height * 0.012}px`, minHeight: 0 }}>
                  {gameMeta.enigmas_header_image && (
                    <div style={{ width: '100%', position: 'relative', aspectRatio: '5 / 1' }}>
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
                      const revealed = completedEnigmas.has(parseInt(enigma.number, 10));
                      const overlay = enigmaStatusColors?.[enigma.number];
                      const overlayKind = enigmaStatusKinds?.[enigma.number];
                      const recapImage = pickEnigmaImage(enigma, gameMeta, overlayKind);
                      const imgSrc = recapImage ? resolveMediaUrl(recapImage) : '';
                      return (
                        <div
                          key={`recap-${enigma.number ?? idx}`}
                          style={{
                            width: '100%',
                            aspectRatio: '1 / 1',
                            position: 'relative',
                            overflow: 'hidden',
                          }}
                        >
                          {overlay && (
                            <MysteryStatusPlate
                              color={overlay}
                              frame={statusFrame}
                              legacyRadius={4}
                            />
                          )}
                          {imgSrc && (
                            <img
                              src={imgSrc}
                              alt=""
                              className={revealed ? '' : 'mystery-game-blur'}
                              style={{
                                position: 'relative',
                                width: '100%',
                                height: '100%',
                                objectFit: 'cover',
                              }}
                            />
                          )}
                          {overlay && (
                            <MysteryStatusPlate
                              color={overlay}
                              frame={statusFrame}
                              legacyRadius={4}
                              over
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

              {/* The bonus ("overscore") plate, placed by the author
                  (ingame_frames.bonus, default = the board's left cell). The
                  "empty bonus" image shows until a tier is reached; the highest
                  tier a team has unlocked by scoring ABOVE score_full_game then
                  takes its PLACE at the plate's full size - not inside it
                  (retour 2026-09-16) - replacing whatever tier was showing
                  before (retour #35). Absolutely positioned over the stage, so moving
                  or resizing it never disturbs the board columns. */}
              {(emptyBonusUrl || activeBonus) && (
                <div
                  style={{
                    position: 'absolute',
                    left: `${bonusBox.left}%`,
                    top: `${bonusBox.top}%`,
                    width: `${bonusBox.width}%`,
                    height: `${bonusBox.height}%`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'none',
                  }}
                >
                  {emptyBonusUrl && !activeBonus?.image && (
                    <img
                      src={emptyBonusUrl}
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
                  {activeBonus && (
                    <div
                      // Keyed by tier index so the plate remounts - and the
                      // pop-in animation fires - exactly when a new tier
                      // takes over, not on every re-render.
                      key={`bonus-${activeBonus.index}`}
                      className="mystery-game-bonus"
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: `${stage.height * 0.006}px`,
                        minWidth: 0,
                      }}
                    >
                      {activeBonus.image && (
                        <img
                          src={resolveMediaUrl(activeBonus.image)}
                          alt=""
                          // Same box as the empty plate it replaces - legacy
                          // `.team_bonus_container img { width: 100% }` stacked
                          // over `.team_bonus_container_empty`.
                          style={{
                            position: 'absolute',
                            inset: 0,
                            width: '100%',
                            height: '100%',
                            objectFit: 'contain',
                          }}
                        />
                      )}
                      {/* The tier artwork carries its own wording, so the name
                          is only drawn for a tier authored without an image. */}
                      {activeBonus.name && !activeBonus.image && (
                        <div
                          style={{
                            fontSize: `${stage.height * 0.018}px`,
                            textAlign: 'center',
                            lineHeight: 1.15,
                            // Authored names run long ("Champion de la lutte
                            // contre les Zombies") and the plate is narrow.
                            overflowWrap: 'anywhere',
                            maxWidth: '100%',
                            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
                            color: gameMeta.level_font_color || '#ffffff',
                            // Name-only tiers still read as a badge rather than
                            // floating text.
                            // +0.15em top/bottom gives back the line room the
                            // cap trim (vcenter-text) takes off the name.
                            padding: `calc(${stage.height * 0.008}px + 0.15em) ${stage.width * 0.008}px`,
                            border: '2px solid rgba(255,255,255,0.65)',
                            borderRadius: 8,
                            background: 'rgba(0,0,0,0.35)',
                          }}
                        >
                          <div className="vcenter-text">{activeBonus.name}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

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
                <div style={{ position: 'relative', width: '100%', height: `${gauge.barHeight}px` }}>
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
                      left: gauge.insetLeft,
                      top: gauge.insetY,
                      height: gauge.trackHeight,
                      width: gauge.trackWidth(Math.max(0, Math.min(100, gaugePercent)) / 100),
                      background: gameMeta.gauge_filling || 'linear-gradient(90deg, #ffc700 0%, #fee300 100%)',
                      opacity: 0.85,
                      borderRadius: gauge.radius,
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
                    const iconHeight = gauge.iconHeight;
                    const fontSize = stage.height * 0.018;
                    const barHeight = stage.height * 0.012;
                    const labelOffset = iconHeight / 2 + barHeight;
                    const levelTextColor = gameMeta.level_font_color || '#ffffff';
                    const entries = Object.entries(gameMeta.levels ?? {});
                    const nodes: React.ReactNode[] = [];
                    entries.forEach(([key, level], idx) => {
                      const pts = parseFloat(level?.points ?? '0') || 0;
                      // Levels are hidden by default and only appear once the
                      // team's score reaches them - during the reveal each level
                      // pops in as the running tally crosses its threshold.
                      if (score < pts) return;
                      const clamped = Math.max(0, Math.min(fullGame, pts));
                      const fraction = clamped / fullGame;
                      const isTop = idx % 2 === 0;
                      const name = level?.name
                        ? (typeof level.name === 'string' ? level.name : Object.values(level.name)[0] ?? '')
                        : '';
                      const leftCalc = gauge.trackLeft(fraction);

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
                          left: gauge.trackLeft(fraction),
                          top: gauge.insetY,
                          height: gauge.trackHeight,
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

              {/* Element frame images, drawn behind the author-placed text at
                  the rectangles stored in `ingame_frames`. */}
              {(() => {
                const frameUrls: Partial<Record<IngameRoleKey, string>> = {};
                for (const role of INGAME_ROLES) {
                  const file = role.frameImageKey ? gameMeta[role.frameImageKey] : undefined;
                  if (file) frameUrls[role.key] = resolveMediaUrl(file);
                }
                return <MysteryFixedFrames frameUrls={frameUrls} frames={gameMeta.ingame_frames} />;
              })()}

              {/* Author-placed text overlays - the 4 in-game roles positioned
                  via game_meta.ingame_layout, each auto-fitting its box. */}
              {(() => {
                const layout = resolveIngameLayout(gameMeta.ingame_layout);
                const overlayFont = fontFamily || 'Arial Black, Arial, sans-serif';
                const overlayColor = gameMeta.font_color || '#ffffff';
                const featured = enigmas[selectedEnigmaIndex];
                // The end-of-run summary has taken the centre column, so the
                // last-walked enigma's title no longer names anything on screen
                // and used to sit there over the final score (retour #98).
                const enigmaName = summary
                  ? ''
                  : featured
                    ? featured.text || `Enigma ${featured.number ?? selectedEnigmaIndex + 1}`
                    : '';
                const scoreText = `${score}${pointsUnits === 'percentage' ? '%' : ''}`;
                const textByRole: Record<string, string> = {
                  enigma_name: enigmaName,
                  timer: timerText,
                  score: scoreText,
                  team_name: teamName,
                };
                return INGAME_ROLES.map((role) => (
                  <MysteryLayoutBox
                    key={role.key}
                    box={layout[role.key]}
                    stageWidth={stage.width}
                    stageHeight={stage.height}
                    text={textByRole[role.key]}
                    fontFamily={overlayFont}
                    color={overlayColor}
                  />
                ));
              })()}
            </>
          )}

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
