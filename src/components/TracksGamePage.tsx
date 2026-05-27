import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
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
  type TracksScreen,
  type TracksDisplayMode,
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
  // Re-render tick (1s) so the live HUD timer recomputes; holds wall-clock ms.
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [audioElements, setAudioElements] = useState<Record<string, HTMLAudioElement>>({});
  const [lastCardData, setLastCardData] = useState<CardData | null>(null);
  const [showCardAlert, setShowCardAlert] = useState(false);
  const [gameMessage, setGameMessage] = useState('');
  const [gameMessageType, setGameMessageType] = useState<GameMessageType>('info');
  const msgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focused-team display state — driven by the most recent bip.
  const [screen, setScreen] = useState<TracksScreen>('ingame');
  const [focusTeamName, setFocusTeamName] = useState('');
  const [focusHits, setFocusHits] = useState<Set<string>>(new Set());
  const [focusReveal, setFocusReveal] = useState<string | null>(null);
  const [focusScoreText, setFocusScoreText] = useState('');
  const [topRevealUrl, setTopRevealUrl] = useState('');
  // Full-screen feedback cue image (legacy maximus): shown on an itinerary
  // wrong-order break (wrong_order_image) or a zero-checkpoint run
  // (missing_checkpoint_image). '' = hidden.
  const [feedbackImageUrl, setFeedbackImageUrl] = useState('');
  // The focused team's resolved route (per-team meta override else launch
  // default) — drives which markers render and which checkpoints score.
  const [focusRoute, setFocusRoute] = useState(config.route ?? 'default');
  // HUD timer is the FOCUSED team's run time: ticks live from start_time during
  // the run, freezes at the final duration on the reveal, blank when idle.
  const [focusStartTime, setFocusStartTime] = useState<number | null>(null);
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

  // 1s tick driving the live HUD timer recompute.
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

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
              const allCps2 = gd.checkpoints;
              // Show the finished team's own route on the clues review.
              try {
                const m = await getLaunchedGameMeta(launchedGameId);
                setFocusRoute(m[`route:${finishedTeam.id}`] || route);
              } catch {
                setFocusRoute(route);
              }
              setFocusTeamName(finishedTeam.team_name ?? '');
              setFocusHits(new Set(allCps2.map((c) => c.id)));
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
              try {
                const stale = (card.punches ?? []).filter((p) => p.time && p.time !== '00:00:00');
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
              setFocusTeamName(effectiveName);
              setFocusRoute(teamRoute);
              setFocusHits(new Set());
              setFocusReveal(null);
              setFocusScoreText(scoreType === 'percentage' ? '0%' : '0 pts');
              // Start the focused-team HUD clock ticking from now.
              setFocusStartTime(startSec);
              setFocusFrozenSec(null);
              setScreen('ingame');
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
        let deviated = false;
        if (trackPlayMode === 'itinerary') {
          const ordered = orderedHitCheckpointIds(routeCps, hitTimeByCp);
          hitIds = ordered.hitIds;
          deviated = ordered.deviated;
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

        // --- Reveal animation -------------------------------------------------
        setFocusTeamName(teamName);
        setFocusRoute(teamRoute);
        // Freeze the HUD clock at this team's final run duration.
        setFocusStartTime(team.start_time);
        setFocusFrozenSec(endTime - team.start_time);
        setScreen('ingame');
        // Announce the scored outcome: success when checkpoints were found,
        // neutral info when the run scored nothing.
        showMessage(
          (teamName ? `${teamName} — ` : '') +
            localizedStatus(hitIds.size > 0 ? 'track_finished' : 'no_checkpoints', language),
          hitIds.size > 0 ? 'success' : 'info',
        );
        // In itinerary mode a shorter-than-route credited prefix means the team
        // skipped or went out of order → mark the break with checkpoint_error.
        const itineraryDeviation = trackPlayMode === 'itinerary' && deviated;
        // Surface the matching full-screen feedback cue image (legacy maximus),
        // if one is configured for this scenario. No-op when the slot is empty.
        const showFeedbackImage = (slot: string) => {
          const url = getImageUrl(gd.images[slot]);
          if (url) setFeedbackImageUrl(url);
        };
        if (displayMode === 'full') {
          // Walk hits one at a time, lighting each marker + reveal panel.
          const built = new Set<string>();
          for (const cp of routeCps) {
            if (!hitIds.has(cp.id)) continue;
            built.add(cp.id);
            setFocusHits(new Set(built));
            setFocusReveal(cp.id);
            playSound('checkpoint_success');
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, REVEAL_STEP_MS));
          }
          // Fire the error cue right after the last lit prefix checkpoint.
          if (itineraryDeviation) {
            playSound('checkpoint_error');
            showFeedbackImage('wrong_order_image');
          } else if (hitIds.size === 0) {
            playSound('checkpoint_no_answer');
            showFeedbackImage('missing_checkpoint_image');
          }
        } else {
          // map / simple — light everything at once.
          setFocusHits(new Set(hitIds));
          setFocusReveal(null);
          if (itineraryDeviation) {
            playSound('checkpoint_error');
            showFeedbackImage('wrong_order_image');
          } else if (hitIds.size > 0) {
            playSound('checkpoint_success');
          } else {
            playSound('checkpoint_no_answer');
            showFeedbackImage('missing_checkpoint_image');
          }
        }
        setFocusScoreText(scoreText(finalScore));

        // --- Top-X reveal: rank the team among all teams ----------------------
        const refreshed = await getLaunchedGameState(launchedGameId, 0);
        const ranked = sortTracksTeams(refreshed.teams.filter((t) => t.end_time));
        const rank = ranked.findIndex((t) => t.id === team.id) + 1;
        const tier = rank > 0 ? rankTier(rank) : null;
        if (tier) {
          const url = getImageUrl(gd.images[`${tier}_image`]);
          setTopRevealUrl(url);
          setGameMessage(''); // clear the scored-outcome wash before the top-X celebration
          setFeedbackImageUrl(''); // and any wrong-order / missing-checkpoint cue
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
    [launchedGameId, route, scoreType, trackPlayMode, timeLimitMin, malusPerMinute, displayMode, config.pattern, config.autoRegisterTeam, config.selfRegisterTeam, config.reuseCards, config.reuseDelayMinutes, config.playTutorialOnBip, config.playIntroOnBip, gameUniqid, playSound, scoreText, showMessage, language],
  );

  const resetDisplay = () => {
    setScreen('ingame');
    setFocusHits(new Set());
    setFocusReveal(null);
    setTopRevealUrl('');
    setGameMessage('');
    setFeedbackImageUrl('');
    // Blank the HUD clock until the next team interacts.
    setFocusStartTime(null);
    setFocusFrozenSec(null);
    // Back to the launch-default route when idle.
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
        await recordPunch(launchedGameId, JSON.parse(JSON.stringify(card)));
        await handleCardPunchLogic(card);
      } catch (err) {
        console.error('[TracksGamePage] saveCardData error:', err);
      }
    },
    [launchedGameId, handleCardPunchLogic],
  );

  // Reader binding — mirrors MysteryGamePage.
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
          void saveCardData(card);
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
  }, [saveCardData]);

  // Test/simulation bips arrive through the state poll.
  const handleNewBip = useCallback(
    (row: { raw_data: unknown }) => {
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

  // Focused team's clock: frozen final duration on reveal, else live elapsed
  // from start_time, else blank when idle.
  const timerDisplay =
    focusFrozenSec != null
      ? formatTime(focusFrozenSec)
      : focusStartTime != null
        ? formatTime(Math.max(0, Math.floor(nowTick / 1000) - focusStartTime))
        : '';

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

      {/* Full-screen wrong-order / missing-checkpoint cue image (legacy maximus).
          Sits above the message wash (z-90) so the configured image dominates. */}
      {feedbackImageUrl && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 95,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.85)',
            pointerEvents: 'none',
          }}
        >
          <img
            src={feedbackImageUrl}
            alt=""
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        </div>
      )}

      <header className="fixed top-0 left-0 right-0 z-50 bg-slate-900/40 backdrop-blur-sm">
        <div className="px-4 py-2 flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 text-slate-300 hover:text-white hover:bg-white/10 rounded-lg transition"
          >
            <ArrowLeft size={22} />
          </button>
          <span className="text-white/80 text-sm">{config.name}</span>
        </div>
        {siReader.isAvailable() && !detectedReader.isPresent && (
          <div className="flex items-center justify-center gap-3 px-4 py-1.5 bg-orange-500/20">
            <div className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
            <span className="text-orange-200 text-xs">
              Reader not connected — punches start landing as soon as you plug in the dongle.
            </span>
          </div>
        )}
      </header>

      <TracksGameRenderer
        screen={screen}
        displayMode={displayMode}
        mapUrl={getImageUrl(data.images.map_image)}
        routeCheckpoints={routeCheckpoints}
        hitCheckpointIds={focusHits}
        revealCheckpointId={focusReveal}
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
        language={language}
        clues={data.clues}
        topRevealUrl={topRevealUrl}
        fontFamily={fontFamily}
        fontColor={data.font_color}
      />
    </div>
  );
}
