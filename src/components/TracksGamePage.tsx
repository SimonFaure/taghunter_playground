import { useState, useEffect, useRef, useCallback } from 'react';
import { GameConfig } from './LaunchGameModal';
import { sportidentService as siReader, CardData, StationData, detectReaderPort } from '../services/sportidentService';
import { useDetectedReaderPort } from '../services/useDetectedReaderPort';
import { CardDetectionAlert } from './CardDetectionAlert';
import { GameMessageOverlay } from './GameMessageOverlay';
import { localizedStatus, type GameMessageType } from '../services/gameMessages';
import {
  getLaunchedGameState,
  recordPunch,
  updateTeam,
  deleteTeam,
  getLaunchedGameMeta,
  mergeLaunchedGameMeta,
  removeLaunchedGameMetaKeys,
} from '../services/launchedGames';
import { ensureTeamForCard } from '../services/teamRegistration';
import * as patternStore from '../services/patternStore';
import * as scenarioStore from '../services/scenarioStore';
import { scenarioAssetUrl } from '../services/contentFs';
import { resolveFontFamily } from '../fonts/resolveFontFamily';
import { registerScenarioFonts } from '../fonts/registerScenarioFonts';
import { useGameStatePolling } from '../hooks/useGameStatePolling';
import { FirstBipVideoOverlay } from './FirstBipVideoOverlay';
import { SelfRegisterOverlay } from './SelfRegisterOverlay';
import { resolveFirstBipVideos, type VideoSource } from '../services/firstBipVideos';
import {
  TracksGameRenderer,
  readLocalized,
  type TracksScreen,
  type TracksDisplayMode,
  type TracksBigReveal,
} from './TracksGameRenderer';
import {
  checkpointsForRoute,
  computeScore,
  orderedHitCheckpointIds,
  sortTracksTeams,
  rankTier,
  type TracksCheckpoint,
  type TracksScoreType,
} from '../services/tracksScoring';

interface TracksGamePageProps {
  config: GameConfig;
  gameUniqid: string;
  launchedGameId: number | null;
  onBack: () => void;
  onGameEnd?: () => void;
}

interface TracksGameData {
  title: string;
  font?: string;
  font_color?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  custom_fonts?: any[];
  checkpoints: TracksCheckpoint[];
  checkpoints_unique_image: boolean;
  // resolved image filenames (bare) keyed by logical slot
  images: Record<string, string>;
  // checkpoint_id → image filename
  checkpointImages: Record<string, string>;
  // logical sound slot → filename
  sounds: Record<string, string>;
  iconSizePercent: number;
  clues: { enabled: boolean; show_title: boolean; show_text: boolean; show_image: boolean };
  showScore: boolean;
  autoReset: boolean;
}

const SOUND_SLOTS = [
  'checkpoint_success',
  'checkpoint_error',
  'checkpoint_no_answer',
  'top_1_sound',
  'top_3_sound',
  'top_10_sound',
] as const;

const IMAGE_SLOTS = [
  'background_image',
  'map_image',
  'team_name_background_image',
  'timer_background_image',
  'score_background_image',
  'time_background_image',
  'wrong_order_image',
  'missing_checkpoint_image',
  'checkpoints_unique_image_id',
  'top_1_image',
  'top_3_image',
  'top_10_image',
] as const;

/** Normalize the on-disk game-data.json (envelope or flat) into TracksGameData. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeTracksGameData(raw: any): TracksGameData {
  const gm = raw?.game_data?.game_meta ?? raw?.game_meta ?? {};
  const medias = raw?.game_data?.medias ?? raw?.medias ?? {};

  // Image fields: prefer the value inlined on game_meta (importer merges them),
  // else fall back to medias.images.<slot>.
  const images: Record<string, string> = {};
  for (const slot of IMAGE_SLOTS) {
    const fromMeta = typeof gm[slot] === 'string' ? gm[slot] : '';
    const fromMedias = typeof medias?.images?.[slot] === 'string' ? medias.images[slot] : '';
    const v = fromMeta || fromMedias;
    if (v) images[slot] = v;
  }

  // Sounds: medias.sounds may be an array [{sound_type, sound_file}] or an
  // object {slot: filename}. Also accept inline game_meta.<slot>.
  const sounds: Record<string, string> = {};
  const ms = medias?.sounds;
  if (Array.isArray(ms)) {
    for (const s of ms) {
      if (s?.sound_type && s?.sound_file) sounds[s.sound_type] = s.sound_file;
    }
  } else if (ms && typeof ms === 'object') {
    for (const [k, v] of Object.entries(ms)) {
      if (typeof v === 'string' && v) sounds[k] = v;
    }
  }
  for (const slot of SOUND_SLOTS) {
    if (!sounds[slot] && typeof gm[slot] === 'string' && gm[slot]) sounds[slot] = gm[slot];
  }

  // Per-checkpoint images: medias.checkpoints[] (by checkpoint_id) overlaid on
  // any inline checkpoint.image.
  const checkpoints: TracksCheckpoint[] = Array.isArray(gm.checkpoints) ? gm.checkpoints : [];
  const checkpointImages: Record<string, string> = {};
  for (const cp of checkpoints) {
    if (typeof cp.image === 'string' && cp.image) checkpointImages[cp.id] = cp.image;
  }
  if (Array.isArray(medias?.checkpoints)) {
    for (const mc of medias.checkpoints) {
      if (mc?.checkpoint_id && typeof mc.image === 'string' && mc.image) {
        checkpointImages[mc.checkpoint_id] = mc.image;
      }
    }
  }

  const cluesRaw = gm.clues_page ?? {};
  const iconPct = parseFloat(gm.checkpoint_image_width_percentage ?? '3');

  return {
    title:
      (typeof gm.title === 'string' ? gm.title : gm.title?.fr) ||
      raw?.scenario?.name ||
      'Tracks',
    font: gm.font,
    font_color: gm.font_color,
    custom_fonts: gm.custom_fonts,
    checkpoints,
    checkpoints_unique_image: !!gm.checkpoints_unique_image,
    images,
    checkpointImages,
    sounds,
    iconSizePercent: Number.isFinite(iconPct) ? iconPct : 3,
    clues: {
      enabled: !!cluesRaw.enabled,
      show_title: cluesRaw.show_title !== false,
      show_text: cluesRaw.show_text !== false,
      show_image: cluesRaw.show_image !== false,
    },
    showScore: gm.display_score !== false,
    autoReset: gm.auto_reset !== false,
  };
}

const AUTO_RESET_SECONDS = 5;
const REVEAL_STEP_MS = 700;

export function TracksGamePage({ config, gameUniqid, launchedGameId, onBack, onGameEnd }: TracksGamePageProps) {
  const [data, setData] = useState<TracksGameData | null>(null);
  const dataRef = useRef<TracksGameData | null>(null);
  // Punches read by THIS device's USB reader are processed immediately in
  // saveCardData; the 1s state poll then echoes those same raw_data rows back.
  // Track the row ids handled locally so the poll skips them — otherwise each
  // own-reader bip runs twice (now + ~1s later), which would start AND reveal a
  // team on its very first bip.
  const processedRawIdsRef = useRef<Set<number>>(new Set());
  const [audioElements, setAudioElements] = useState<Record<string, HTMLAudioElement>>({});
  const [lastCardData, setLastCardData] = useState<CardData | null>(null);
  const [showCardAlert, setShowCardAlert] = useState(false);
  const [gameMessage, setGameMessage] = useState('');
  const [gameMessageType, setGameMessageType] = useState<GameMessageType>('info');
  const msgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focused-team display state — driven by the most recent bip.
  // Default screen is the resting background image; the map only appears for the
  // second-bip reveal (see tracks-reveal-redesign.md).
  const [screen, setScreen] = useState<TracksScreen>('background');
  const [focusTeamName, setFocusTeamName] = useState('');
  const [focusScoreText, setFocusScoreText] = useState('');
  const [focusHitCount, setFocusHitCount] = useState(0);
  const [topRevealUrl, setTopRevealUrl] = useState('');
  // Reveal state: checkpoints already placed on the map (cpId → per-status image
  // URL, accumulates during the walk) + the full-mode big-center reveal.
  const [placedCheckpoints, setPlacedCheckpoints] = useState<Map<string, string>>(new Map());
  const [bigReveal, setBigReveal] = useState<TracksBigReveal | null>(null);
  // The focused team's resolved route (per-team meta override else launch
  // default) — drives which markers render and which checkpoints score.
  const [focusRoute, setFocusRoute] = useState(config.route ?? 'default');
  // HUD timer shows the focused team's frozen final run duration during the
  // reveal; blank otherwise (no HUD over the background during the run).
  const [focusFrozenSec, setFocusFrozenSec] = useState<number | null>(null);

  // First-bip video overlay state. Captures the start to finalize once all
  // videos have played (mirrors MysteryGamePage).
  const [firstBipVideos, setFirstBipVideos] = useState<VideoSource[] | null>(null);
  const pendingFirstBipFinalizeRef = useRef<(() => Promise<void>) | null>(null);
  // Self-register overlay state. Shown on a team's first bip when enabled, BEFORE
  // any videos. `finalize(name)` persists the name + proceeds; `abort()` cancels
  // the start (and deletes the team if this bip created it).
  const [selfReg, setSelfReg] = useState<{
    finalize: (name: string) => Promise<void>;
    abort: () => Promise<void>;
  } | null>(null);

  const detectedReader = useDetectedReaderPort();

  // Launch selections (from in-memory config; satellites read launched_games.meta).
  const route = config.route ?? 'default';
  const displayMode = (config.displayMode ?? 'map') as TracksDisplayMode;
  const trackPlayMode = (config.trackPlayMode ?? 'free') as 'itinerary' | 'free';
  const scoreType = (config.scoreType ?? 'percentage') as TracksScoreType;
  const timeLimitMin = config.duration || 60;
  const malusPerMinute = config.malusPerMinute ?? 1;
  const language = config.language ?? 'fr';

  useEffect(() => {
    const load = async () => {
      try {
        const raw = await scenarioStore.getGameData(gameUniqid);
        if (!raw) {
          console.error('[TracksGamePage] no game-data.json for', gameUniqid);
          return;
        }
        const normalized = normalizeTracksGameData(raw);
        setData(normalized);
        dataRef.current = normalized;
        void registerScenarioFonts(gameUniqid, normalized.custom_fonts);

        const loaded: Record<string, HTMLAudioElement> = {};
        for (const [slot, filename] of Object.entries(normalized.sounds)) {
          if (filename) loaded[slot] = new Audio(scenarioAssetUrl(gameUniqid, filename));
        }
        setAudioElements(loaded);
      } catch (err) {
        console.error('[TracksGamePage] load error:', err);
      }
    };
    void load();
  }, [gameUniqid]);

  // No on-screen back button on the kiosk display — Esc exits (operator keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const playSound = useCallback(
    (slot: string) => {
      const a = audioElements[slot];
      if (a) {
        a.currentTime = 0;
        a.play().catch((e) => console.error('[TracksGamePage] sound error:', e));
      }
    },
    [audioElements],
  );

  const scoreText = useCallback(
    (value: number) => (scoreType === 'percentage' ? `${Math.round(value)}%` : `${Math.round(value)} pts`),
    [scoreType],
  );

  // Transient full-screen status message (shared <GameMessageOverlay>). Used to
  // surface scored-run outcomes + the otherwise-silent failure paths below.
  const showMessage = useCallback(
    (message: string, type: GameMessageType = 'info') => {
      setGameMessage(message);
      setGameMessageType(type);
      if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
      msgTimerRef.current = setTimeout(
        () => setGameMessage(''),
        config.messageDisplayDuration * 1000,
      );
    },
    [config.messageDisplayDuration],
  );

  const getImageUrl = (filename: string | undefined) => {
    if (!filename || filename === 'undefined' || filename === 'null') return '';
    return scenarioAssetUrl(gameUniqid, filename);
  };

  const handleCardPunchLogic = useCallback(
    async (card: CardData) => {
      const gd = dataRef.current;
      if (!launchedGameId || !gd) return;

      try {
        // Resolve the team for this card per the auto-register / reuse rule.
        // Active run = the card's team with no end_time.
        const state = await getLaunchedGameState(launchedGameId, 0);
        const teamsForCard = state.teams.filter((t) => t.key_id === card.id);
        let team = teamsForCard.find((t) => t.end_time == null) ?? null;
        // True when *this* bip created the team — drives the self-register abort
        // cleanup (delete a just-created team, never a rostered one).
        let createdNow = false;

        if (!team) {
          const finished = teamsForCard.length > 0;
          if (!finished) {
            // Card has never had a team in this game.
            if (!config.autoRegisterTeam && !config.selfRegisterTeam) {
              console.warn('[TracksGamePage] no team for card', card.id);
              showMessage(localizedStatus('card_not_registered', language), 'warning');
              return;
            }
            team = await ensureTeamForCard(launchedGameId, card.id, state, !!config.useNamePool);
            if (!team) {
              showMessage(localizedStatus('chip_not_recognized', language), 'warning'); // unknown chip
              return;
            }
            createdNow = true;
          } else {
            // Card already finished a run.
            const lastEnd = Math.max(...teamsForCard.map((t) => t.end_time ?? 0));
            const cooldownSec = (config.reuseDelayMinutes ?? 5) * 60;
            const cooled = !!config.reuseCards && Date.now() / 1000 >= lastEnd + cooldownSec;
            if (cooled) {
              team = await ensureTeamForCard(launchedGameId, card.id, state, !!config.useNamePool);
              if (!team) {
                showMessage(localizedStatus('chip_not_recognized', language), 'warning'); // unknown chip
                return;
              }
              createdNow = true;
            } else {
              // reuse off OR within cooldown → existing clues-review behavior:
              // show the map with every checkpoint revealed, then reset.
              if (!gd.clues.enabled) {
                // No clues review to show — surface why the bip did nothing.
                if (config.reuseCards) {
                  const remainingMin = Math.max(
                    1,
                    Math.ceil((lastEnd + cooldownSec - Date.now() / 1000) / 60),
                  );
                  showMessage(
                    localizedStatus('reuse_cooldown', language).replace('{n}', String(remainingMin)),
                    'warning',
                  );
                } else {
                  showMessage(localizedStatus('team_already_finished', language), 'warning');
                }
                return;
              }
              const finishedTeam = teamsForCard[teamsForCard.length - 1];
              // Show the finished team's own route on the clues review.
              try {
                const m = await getLaunchedGameMeta(launchedGameId);
                setFocusRoute(m[`route:${finishedTeam.id}`] || route);
              } catch {
                setFocusRoute(route);
              }
              setFocusTeamName(finishedTeam.team_name ?? '');
              setScreen('clues');
              if (gd.autoReset) {
                await new Promise((r) => setTimeout(r, 6000));
                resetDisplay();
              } else {
                await waitForEnter();
                resetDisplay();
              }
              return;
            }
          }
        }
        const teamName = team.team_name ?? '';

        // Resolve this team's route: per-team override (manual Add Team) else the
        // launch default. Drives both the markers shown and the scored subset.
        // The same meta read also carries the second-bip scoring baseline.
        let teamRoute = route;
        let metaForBip: Record<string, string> = {};
        try {
          metaForBip = await getLaunchedGameMeta(launchedGameId);
          teamRoute = metaForBip[`route:${team.id}`] || route;
        } catch (err) {
          console.error('[TracksGamePage] route resolve error:', err);
        }

        // First bip → (self-register name) → (videos) → start the team's clock.
        if (!team.start_time) {
          // The start sequence, parameterised by the effective team name: persist
          // a self-registered rename, then gate the clock on any first-bip videos.
          const proceedAfterName = async (effectiveName: string) => {
            if (effectiveName && effectiveName !== teamName) {
              try {
                await updateTeam(team.id, { team_name: effectiveName });
              } catch (err) {
                console.error('[TracksGamePage] error saving self-registered name:', err);
              }
            }

            const finalizeStart = async () => {
              const startSec = Math.floor(Date.now() / 1000);
              await updateTeam(team.id, { start_time: startSec });
              // Snapshot the punches already on the card so a forgotten wipe or a
              // card reuse does not re-score stale punches. Persisted to meta
              // (durable across reload — tracks runs are long). Matched on
              // code+time so a legit re-punch (new time) still counts at scoring.
              let staleCount = 0;
              try {
                const stale = (card.punches ?? []).filter((p) => p.time && p.time !== '00:00:00');
                staleCount = stale.length;
                if (stale.length > 0) {
                  await mergeLaunchedGameMeta(launchedGameId, {
                    [`baseline:${team.id}`]: JSON.stringify(stale.map((p) => `${p.code}@${p.time}`)),
                  });
                  console.warn(
                    `[TracksGamePage] card ${card.id} not empty at start: ${stale.length} pre-existing punch(es) will be ignored`,
                  );
                } else {
                  await removeLaunchedGameMetaKeys(launchedGameId, [`baseline:${team.id}`]);
                }
              } catch (err) {
                console.error('[TracksGamePage] baseline snapshot error:', err);
              }
              // First bip → confirm the start (like mystery's "C'est parti !").
              // The resting background stays up; this transient message is the
              // only first-bip feedback the operator/team gets.
              const warn =
                staleCount > 0 ? ` — ⚠️ Carte non vide : ${staleCount} passage(s) ignoré(s)` : '';
              showMessage(`C'est parti ! ${effectiveName}${warn}`, warn ? 'warning' : 'success');
              setScreen('background');
              setBigReveal(null);
              setPlacedCheckpoints(new Map());
            };

            // Gate the start on the first-bip video overlay when enabled.
            const wantsVideos = !!(config.playTutorialOnBip || config.playIntroOnBip);
            if (wantsVideos) {
              const rawForResolve = await scenarioStore.getGameData(gameUniqid);
              const videos = await resolveFirstBipVideos(config, gameUniqid, 'tracks', rawForResolve);
              if (videos.length > 0) {
                pendingFirstBipFinalizeRef.current = finalizeStart;
                setFirstBipVideos(videos);
                return;
              }
            }

            await finalizeStart();
          };

          // Self-register: prompt for the name first (before videos). On submit we
          // proceed with the entered name; on abort we cancel the start and delete
          // the team if this bip created it.
          if (config.selfRegisterTeam) {
            setSelfReg({
              finalize: (name: string) => proceedAfterName(name),
              abort: async () => {
                setSelfReg(null);
                if (createdNow) {
                  try {
                    await deleteTeam(team.id);
                  } catch (err) {
                    console.error('[TracksGamePage] error deleting team on self-register abort:', err);
                  }
                }
              },
            });
            return;
          }

          await proceedAfterName(teamName);
          return;
        }

        // Second bip → score the run from the card's punch codes.
        const endTime = Math.floor(Date.now() / 1000);
        const allCps = gd.checkpoints;
        const routeCps = checkpointsForRoute(allCps, teamRoute);
        const stations = await patternStore.getTracksCheckpointStations(config.pattern);

        // Drop punches that were already on the card at the first bip (matched on
        // code+time, so a station legitimately re-punched during the run — new
        // time — still counts). Keeps a forgotten-to-wipe or reused card from
        // re-scoring its leftover punches. Reuses the route-resolution meta read.
        let baseline = new Set<string>();
        try {
          const raw = metaForBip[`baseline:${team.id}`];
          if (raw) baseline = new Set<string>(JSON.parse(raw) as string[]);
        } catch (err) {
          console.error('[TracksGamePage] baseline read error:', err);
        }
        const livePunches = (card.punches ?? []).filter(
          (p) => !baseline.has(`${p.code}@${p.time}`),
        );

        const numberOf = (cp: TracksCheckpoint) => allCps.findIndex((c) => c.id === cp.id) + 1;
        // Parse an SI clock time "HH:MM:SS" to seconds-of-day for ordering.
        const secondsOfDay = (t: string) => {
          const [h, m, s] = (t ?? '').split(':').map(Number);
          return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
        };
        // Earliest live-punch time at which each route checkpoint was reached
        // (undefined = never reached).
        const hitTimeByCp = new Map<string, number | undefined>();
        for (const cp of routeCps) {
          const cpStations = stations.get(numberOf(cp)) ?? [];
          if (import.meta.env.DEV && cpStations.length === 0) {
            console.warn(
              `[TracksGamePage] checkpoint #${numberOf(cp)} resolves to NO pattern stations — it can never be scored as hit. Check the pattern row count matches the checkpoint count.`,
            );
          }
          let earliest: number | undefined;
          for (const p of livePunches) {
            if (cpStations.includes(p.code)) {
              const ts = secondsOfDay(p.time);
              if (earliest === undefined || ts < earliest) earliest = ts;
            }
          }
          hitTimeByCp.set(cp.id, earliest);
        }

        // Itinerary = strict in-order prefix; free = any reached checkpoint.
        let hitIds: Set<string>;
        if (trackPlayMode === 'itinerary') {
          hitIds = orderedHitCheckpointIds(routeCps, hitTimeByCp).hitIds;
        } else {
          hitIds = new Set<string>();
          for (const cp of routeCps) {
            if (hitTimeByCp.get(cp.id) !== undefined) hitIds.add(cp.id);
          }
        }

        const elapsedMin = (endTime - team.start_time) / 60;
        const finalScore = computeScore({
          routeCheckpoints: routeCps,
          hitCheckpointIds: hitIds,
          scoreType,
          elapsedMinutes: elapsedMin,
          timeLimitMinutes: timeLimitMin,
          malusPerMinute,
        });

        await updateTeam(team.id, { end_time: endTime, score: finalScore });
        // Run scored — drop the start-time baseline so a later reuse starts clean.
        try {
          await removeLaunchedGameMetaKeys(launchedGameId, [`baseline:${team.id}`]);
        } catch (err) {
          console.error('[TracksGamePage] baseline clear error:', err);
        }

        // --- Reveal -----------------------------------------------------------
        // The map is the reveal surface; per-checkpoint status images accumulate
        // on it. Free → correct/missing; itinerary → correct/wrong/missing.
        setFocusTeamName(teamName);
        setFocusRoute(teamRoute);
        setFocusFrozenSec(endTime - team.start_time); // frozen run duration
        setFocusHitCount(hitIds.size);
        setBigReveal(null);
        setPlacedCheckpoints(new Map());
        setScreen('reveal');

        const statusOf = (cp: TracksCheckpoint): 'correct' | 'wrong' | 'missing' => {
          if (hitIds.has(cp.id)) return 'correct';
          if (hitTimeByCp.get(cp.id) !== undefined) return 'wrong'; // punched, not credited
          return 'missing';
        };
        const correctImage = (cp: TracksCheckpoint) =>
          gd.checkpoints_unique_image
            ? getImageUrl(gd.images.checkpoints_unique_image_id)
            : getImageUrl(gd.checkpointImages[cp.id]);
        const statusImage = (cp: TracksCheckpoint, status: 'correct' | 'wrong' | 'missing') =>
          status === 'correct'
            ? correctImage(cp)
            : status === 'wrong'
              ? getImageUrl(gd.images.wrong_order_image)
              : getImageUrl(gd.images.missing_checkpoint_image);
        const statusSound = (status: 'correct' | 'wrong' | 'missing') =>
          status === 'correct'
            ? 'checkpoint_success'
            : status === 'wrong'
              ? 'checkpoint_error'
              : 'checkpoint_no_answer';

        if (displayMode === 'simple') {
          // No per-checkpoint walk — settle straight onto the summary HUD, then
          // hold it long enough to read before top-X / reset (otherwise it would
          // flash past instantly).
          setFocusScoreText(scoreText(finalScore));
          playSound(hitIds.size > 0 ? 'checkpoint_success' : 'checkpoint_no_answer');
          await new Promise((r) => setTimeout(r, Math.max(1, config.messageDisplayDuration) * 1000));
        } else {
          // full + map: walk every route checkpoint in order, accumulating its
          // status image on the map; correct checkpoints count the score up.
          const denom = routeCps.length || 1;
          const rawIncrement = (cp: TracksCheckpoint) =>
            scoreType === 'percentage' ? 100 / denom : typeof cp.points === 'number' ? cp.points : 1;
          let runningRaw = 0;
          const placed = new Map<string, string>();
          setFocusScoreText(scoreType === 'percentage' ? '0%' : '0 pts');
          for (const cp of routeCps) {
            const status = statusOf(cp);
            const url = statusImage(cp, status);
            const bump = () => {
              if (status !== 'correct') return;
              runningRaw =
                scoreType === 'percentage'
                  ? Math.min(100, runningRaw + rawIncrement(cp))
                  : runningRaw + rawIncrement(cp);
              setFocusScoreText(scoreText(runningRaw));
            };
            if (displayMode === 'full') {
              // Phase A — big centered status image (name/description only for correct).
              setBigReveal({
                imageUrl: url,
                title: status === 'correct' ? readLocalized(cp.title as Record<string, string> | string | undefined, language) : '',
                description:
                  status === 'correct' ? readLocalized(cp.description as Record<string, string> | string | undefined, language) : '',
              });
              playSound(statusSound(status));
              bump();
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, Math.max(1, config.messageDisplayDuration) * 1000));
              // Phase B — the image lands on the map and stays.
              setBigReveal(null);
              placed.set(cp.id, url);
              setPlacedCheckpoints(new Map(placed));
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, 500));
            } else {
              // map mode — Phase B only: place each status image sequentially.
              placed.set(cp.id, url);
              setPlacedCheckpoints(new Map(placed));
              playSound(statusSound(status));
              bump();
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, REVEAL_STEP_MS));
            }
          }
          // Apply the time malus as a visible drop to the final score.
          setFocusScoreText(scoreText(finalScore));
        }

        // --- Top-X reveal: rank the team among all teams ----------------------
        const refreshed = await getLaunchedGameState(launchedGameId, 0);
        const ranked = sortTracksTeams(refreshed.teams.filter((t) => t.end_time));
        const rank = ranked.findIndex((t) => t.id === team.id) + 1;
        const tier = rank > 0 ? rankTier(rank) : null;
        if (tier) {
          const url = getImageUrl(gd.images[`${tier}_image`]);
          setTopRevealUrl(url);
          setGameMessage(''); // clear any lingering warning before the celebration
          setScreen('topreveal');
          playSound(`${tier}_sound`);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 4000));
        }

        // --- Reset back to the map -------------------------------------------
        if (gd.autoReset) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, AUTO_RESET_SECONDS * 1000));
          resetDisplay();
        } else {
          await waitForEnter();
          resetDisplay();
        }
      } catch (err) {
        console.error('[TracksGamePage] punch logic error:', err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [launchedGameId, route, scoreType, trackPlayMode, timeLimitMin, malusPerMinute, displayMode, config.pattern, config.messageDisplayDuration, config.autoRegisterTeam, config.selfRegisterTeam, config.reuseCards, config.reuseDelayMinutes, config.playTutorialOnBip, config.playIntroOnBip, gameUniqid, playSound, scoreText, showMessage, language],
  );

  const resetDisplay = () => {
    // Back to the resting background screen until the next team interacts.
    setScreen('background');
    setPlacedCheckpoints(new Map());
    setBigReveal(null);
    setTopRevealUrl('');
    setGameMessage('');
    setFocusFrozenSec(null);
    setFocusScoreText('');
    setFocusHitCount(0);
    setFocusRoute(route);
  };

  const waitForEnter = () =>
    new Promise<void>((resolve) => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          window.removeEventListener('keydown', onKey);
          resolve();
        }
      };
      window.addEventListener('keydown', onKey);
    });

  const saveCardData = useCallback(
    async (card: CardData) => {
      if (!launchedGameId) return;
      try {
        // Remember the row id we just created so the poll's echo of it is
        // skipped in handleNewBip (own-reader de-dupe).
        const { id } = await recordPunch(launchedGameId, JSON.parse(JSON.stringify(card)));
        if (typeof id === 'number') processedRawIdsRef.current.add(id);
        await handleCardPunchLogic(card);
      } catch (err) {
        console.error('[TracksGamePage] saveCardData error:', err);
      }
    },
    [launchedGameId, handleCardPunchLogic],
  );
  // Always dispatch to the LATEST saveCardData without re-binding the reader.
  // Binding the effect to `saveCardData` (which changes whenever the punch logic
  // does) tore the USB reader down + re-initialized it repeatedly, dropping
  // punches. Mirror MysteryGamePage: bind once per game, call through a ref.
  const saveCardDataRef = useRef(saveCardData);
  useEffect(() => {
    saveCardDataRef.current = saveCardData;
  }, [saveCardData]);

  // Reader binding — bind once per launched game (mirrors MysteryGamePage).
  useEffect(() => {
    let cancelled = false;
    const initUSB = async () => {
      if (!siReader.isAvailable()) return;
      const detected = await detectReaderPort();
      if (cancelled || !detected) return;
      try {
        const ok = await siReader.initializePort(detected.path);
        if (!ok) return;
        siReader.setCardDetectedCallback((card: CardData) => {
          void saveCardDataRef.current(card);
          setLastCardData(card);
          setShowCardAlert(true);
          setTimeout(() => setShowCardAlert(false), 5000);
        });
        siReader.setCardRemovedCallback(() => setShowCardAlert(false));
        siReader.setStationsDetectedCallback((_s: StationData[]) => {});
        await siReader.start();
      } catch (err) {
        console.error('[TracksGamePage] USB init error:', err);
      }
    };
    const onReaderStatus = () => void initUSB();
    void initUSB();
    window.addEventListener('reader:status', onReaderStatus);
    return () => {
      cancelled = true;
      window.removeEventListener('reader:status', onReaderStatus);
      if (siReader.isAvailable()) siReader.stop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchedGameId]);

  // Test/simulation bips arrive through the state poll.
  const handleNewBip = useCallback(
    (row: { id?: number; raw_data: unknown }) => {
      // Skip rows this device already processed via its own USB reader (the poll
      // echoes them back ~1s later). Remote/test punches aren't in the set.
      if (row.id != null && processedRawIdsRef.current.has(row.id)) return;
      const card = row.raw_data as CardData;
      if (card && dataRef.current) {
        setLastCardData(card);
        setShowCardAlert(true);
        setTimeout(() => setShowCardAlert(false), 5000);
        void handleCardPunchLogic(card);
      }
    },
    [handleCardPunchLogic],
  );

  useGameStatePolling({
    launchedGameId,
    numberOfTeams: config.numberOfTeams,
    onGameEnded: () => onGameEnd?.(),
    onAllTeamsFinished: () => onGameEnd?.(),
    onNewBip: handleNewBip,
    disableAllFinishedEnd: !!(config.autoRegisterTeam || config.reuseCards || config.selfRegisterTeam),
  });

  if (!data) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading game...</div>
      </div>
    );
  }

  const fontFamily = resolveFontFamily(data.font) || undefined;
  const routeCheckpoints = checkpointsForRoute(data.checkpoints, focusRoute);

  // Focused team's clock: the frozen final run duration during the reveal,
  // blank otherwise (no HUD over the background during the run).
  const timerDisplay = focusFrozenSec != null ? formatTime(focusFrozenSec) : '';

  const resolveCheckpointImage = (cp: TracksCheckpoint) => {
    if (data.checkpoints_unique_image) return getImageUrl(data.images.checkpoints_unique_image_id);
    return getImageUrl(data.checkpointImages[cp.id]);
  };

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      {selfReg && (
        <SelfRegisterOverlay
          language={language}
          onSubmit={(name) => {
            const s = selfReg;
            setSelfReg(null);
            void s.finalize(name);
          }}
          onAbort={() => {
            void selfReg.abort();
          }}
        />
      )}
      {firstBipVideos && (
        <FirstBipVideoOverlay
          videos={firstBipVideos}
          onComplete={async () => {
            const finalize = pendingFirstBipFinalizeRef.current;
            pendingFirstBipFinalizeRef.current = null;
            setFirstBipVideos(null);
            if (finalize) await finalize();
          }}
        />
      )}
      {/* Dev-only punch/hardware debug indicator — removed from production builds. */}
      {import.meta.env.DEV && (
        <CardDetectionAlert cardData={lastCardData} show={showCardAlert} />
      )}

      <GameMessageOverlay
        message={gameMessage || null}
        type={gameMessageType}
        fontFamily={fontFamily}
      />

      {/* No top nav on the in-game (kiosk) display. Exit is via Esc (operator
          keyboard) — see the keydown handler. The reader-not-connected banner is
          kept as a thin diagnostic strip since it explains missing punches. */}
      {siReader.isAvailable() && !detectedReader.isPresent && (
        <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-3 px-4 py-1.5 bg-orange-500/20">
          <div className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
          <span className="text-orange-200 text-xs">
            Reader not connected — punches start landing as soon as you plug in the dongle.
          </span>
        </div>
      )}

      <TracksGameRenderer
        screen={screen}
        displayMode={displayMode}
        backgroundUrl={getImageUrl(data.images.background_image)}
        mapUrl={getImageUrl(data.images.map_image)}
        routeCheckpoints={routeCheckpoints}
        placedCheckpoints={placedCheckpoints}
        bigReveal={bigReveal}
        resolveCheckpointImage={resolveCheckpointImage}
        iconSizePercent={data.iconSizePercent}
        hud={{
          teamNameFrame: getImageUrl(data.images.team_name_background_image),
          timerFrame: getImageUrl(data.images.timer_background_image),
          scoreFrame: getImageUrl(data.images.score_background_image),
          timeFrame: getImageUrl(data.images.time_background_image),
        }}
        teamName={focusTeamName || config.name}
        timerText={timerDisplay}
        scoreText={focusScoreText || (scoreType === 'percentage' ? '0%' : '0 pts')}
        showScore={data.showScore}
        hitCount={focusHitCount}
        language={language}
        clues={data.clues}
        topRevealUrl={topRevealUrl}
        fontFamily={fontFamily}
        fontColor={data.font_color}
      />
    </div>
  );
}
