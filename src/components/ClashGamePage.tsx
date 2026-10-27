// Clash runtime - the live territory dashboard + local validation.
//
// Validation runs ONLY from the local SportIdent reader callback (not the state
// poll), so the combo reveal plays on the station that took the bip while every
// other screen just reflects the standings change via the getClashState poll.
// The mother is the validation authority; this page shuttles card-reads to it.
//
// Design: project_clash_game_type_design.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameConfig } from './LaunchGameModal';
import { sportidentService as usbReaderService, CardData, detectReaderPort, isReaderConnected } from '../services/sportidentService';
import { GameMessageOverlay } from './GameMessageOverlay';
import { PendingTeamsBar } from './PendingTeamsBar';
import { usePresentationQueue } from '../hooks/usePresentationQueue';
import { useGameSounds } from '../hooks/useGameSounds';
import type { GameMessageType } from '../services/gameMessages';
import * as scenarioStore from '../services/scenarioStore';
import { scenarioAssetUrl } from '../services/contentFs';
import { recordPunch, startLaunchedGame, endLaunchedGame, getLaunchedGameState, getLaunchedGameMeta } from '../services/launchedGames';
import { useGameStatePolling } from '../hooks/useGameStatePolling';
import { clashValidate, clashRegister, getClashState, type ClashStandings } from '../services/clash';
import { onPendingConfigReload, onPendingStart } from '../services/pendingJoinStore';
import { refineInGame, clearInGameRefinement } from '../services/screenState';
import { tIngame } from '../i18n/ingame';
// Station-based registration assignment: this device may be hard-locked to
// specific clan(s) during self-registration (meta.regAssignments, keyed by
// device_id). Design: project_selfregister_team_device_assignment.
import {
  parseRegAssignments,
  assignedTeamNumbersFor,
  getSelfDeviceId,
  REG_ASSIGNMENTS_META_KEY,
  type RegAssignmentMap,
} from '../services/regAssignments';
import { ClashGameRenderer, type ClashClanVisual, type ClashSizes } from './ClashGameRenderer';
import { ClashRegistrationScreen } from './ClashRegistrationScreen';
import { ClashResultsScreen } from './ClashResultsScreen';
import { renderEventSentence } from './clashEventFeed';
import { parseDbTs } from '../utils/dbTime';
import { pickGameVisual } from '../utils/coverVisual';
import { useAuth } from './auth/AuthProvider';
import { gameClock } from '../services/gameClock';

interface ClashGamePageProps {
  config: GameConfig;
  gameUniqid: string;
  launchedGameId: number | null;
  onBack: () => void;
  onGameEnd?: () => void;
}

interface ClashClanMeta {
  id?: string;
  name?: Record<string, string> | string;
  color?: string;
  banner?: string;
  logo?: string;
  score_card?: string;
}
interface ClashTerritoryMeta {
  id?: string;
  name?: Record<string, string> | string;
  points?: string;
  balises?: number[];
  banner_position?: { top: number; left: number };
  label_position?: { top: number; left: number };
  purge_position?: { top: number; left: number };
}
interface ClashTextElementMeta {
  id: string;
  text?: Record<string, string> | string;
  position?: { left: number; top: number; width: number; height: number };
  font?: string;
  font_color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right';
  shadow?: boolean;
  background?: boolean;
}
interface ClashGameMetaRuntime {
  game_visual?: string;
  map_image?: string;
  /** Timer plate: centre anchor + (since retours #52/#54) its box. */
  timer_position?: { top: number; left: number; width?: number; height?: number };
  /** Clock nudge inside the plate, % of the plate box (retours #54). */
  timer_text_offset?: { x: number; y: number };
  /** Clan-ranking panel box, % of the map box (retours #52). */
  ranking_position?: { left: number; top: number; width: number; height: number };
  /* On-map sizes (retours #57) - % of map width, or % scale for text. */
  banner_size_percentage?: number;
  purge_size_percentage?: number;
  gauge_size_percentage?: number;
  territory_name_scale?: number;
  timer_scale?: number;
  /* Per-element text colours (retours #53). */
  timer_color?: string;
  ranking_color?: string;
  territory_name_color?: string;
  event_color?: string;
  /* Scenario-authored event-banner sentences (retours #56). */
  event_text_conquest?: Record<string, string> | string;
  event_text_attack?: Record<string, string> | string;
  event_text_neutralized?: Record<string, string> | string;
  event_text_purge?: Record<string, string> | string;
  purge_text_already_used?: Record<string, string> | string;
  purge_text_own_territory?: Record<string, string> | string;
  purge_text_no_target?: Record<string, string> | string;
  ranking_title?: Record<string, string> | string;
  clans?: ClashClanMeta[];
  territories?: ClashTerritoryMeta[];
  text_elements?: ClashTextElementMeta[];
  font?: string;
  font_color?: string;
  frame_separator?: string;
  frame_ranking?: string;
  frame_territory_name?: string;
  frame_gauge?: string;
  frame_event?: string;
  frame_timer?: string;
  /** The Purge marker/announcement image (its presence gates the launch toggle). */
  purge_image?: string;
  /** Sound played on every in-game device when a purge fires (optional). */
  purge_sound?: string;
}

const FALLBACK_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad'];

// Self-register: pick the station's selected clan. Keeps the current selection
// while it has room; when it's full (or nothing is selected yet) advance to the
// next clan with room, scanning forward from the current position and wrapping.
// All-full keeps the current selection (the server rejects further joins with
// clan_full anyway). Mirrors TagQuest's nextRegSelection.
// Station assignment: restrict the pickable clans to this device's assigned
// team_numbers (null ⇒ unrestricted - the legacy full grid).
function filterAssignedClans<T extends { team_number: number }>(
  clans: T[],
  assigned: number[] | null,
): T[] {
  return assigned ? clans.filter((c) => assigned.includes(c.team_number)) : clans;
}

function nextClanSelection(
  clans: Array<{ team_id: number; member_count: number }>,
  currentId: number | null,
  maxPerClan: number,
): number | null {
  if (clans.length === 0) return null;
  const isFull = (c: { member_count: number }) => maxPerClan > 0 && c.member_count >= maxPerClan;
  const curIdx = currentId != null ? clans.findIndex((c) => c.team_id === currentId) : -1;
  if (curIdx >= 0 && !isFull(clans[curIdx])) return currentId;
  // No/invalid selection scans from the first clan; a full selection scans
  // from the clan after it.
  const start = curIdx >= 0 ? curIdx : clans.length - 1;
  for (let k = 1; k <= clans.length; k++) {
    const cand = clans[(start + k) % clans.length];
    if (!isFull(cand)) return cand.team_id;
  }
  return currentId ?? clans[0].team_id;
}

function pickLocalized(v: Record<string, string> | string | undefined, lang: string): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v[lang] || Object.values(v)[0] || '';
}

export function ClashGamePage({ config, gameUniqid, launchedGameId, onBack }: ClashGamePageProps) {
  const lang = config.language || 'fr';
  const { user } = useAuth();
  // Every player-facing Clash string resolves against the LAUNCH language, not
  // the operator's chrome language. Scenario-authored names (clans,
  // territories) go through pickLocalized with the same `lang`.
  const tc = useCallback(
    (key: string, vars?: Record<string, string | number>) => tIngame('ingame_clash', key, lang, vars),
    [lang],
  );
  const registrationMode: 'self' | 'bulk' = config.clashRegistrationMode ?? 'self';
  const [meta, setMeta] = useState<ClashGameMetaRuntime | null>(null);
  const [standings, setStandings] = useState<ClashStandings | null>(null);
  const [phase, setPhase] = useState<'register' | 'playing' | 'ended'>('register');
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
  const [lastJoin, setLastJoin] = useState<{ teamId: number; status: string } | null>(null);
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  // Station assignment: meta.regAssignments + this device's paired id. When
  // this device has an entry, registration hard-locks to those clan
  // team_numbers (no entry ⇒ the legacy pick-any-clan grid). Self mode only.
  const [regAssignMap, setRegAssignMap] = useState<RegAssignmentMap>({});
  const [selfDeviceId, setSelfDeviceId] = useState<number | null>(null);
  const assignedTeamNumbers =
    registrationMode === 'self' ? assignedTeamNumbersFor(regAssignMap, selfDeviceId) : null;
  const endMsRef = useRef<number | null>(null);
  const phaseRef = useRef(phase);
  const selectedTeamIdRef = useRef(selectedTeamId);
  const standingsRef = useRef(standings);
  const assignedTeamNumbersRef = useRef(assignedTeamNumbers);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { selectedTeamIdRef.current = selectedTeamId; }, [selectedTeamId]);
  useEffect(() => { standingsRef.current = standings; }, [standings]);
  useEffect(() => { assignedTeamNumbersRef.current = assignedTeamNumbers; });

  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<GameMessageType>('info');
  const msgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local message presentation queue (this station only). A bip landing while a
  // message is on screen waits its turn; the waiting clans show in the bottom
  // line. There is no combo/piece art in V2 - feedback is a status message.
  const queue = usePresentationQueue();
  // Stops the purge announcement when the page is left (quit / rankings).
  const playAudio = useGameSounds();

  const resolveMedia = useCallback(
    (filename: string) => (filename ? scenarioAssetUrl(gameUniqid, filename.replace(/^media\//, '')) : ''),
    [gameUniqid],
  );

  // ── load scenario meta ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const gd = (await scenarioStore.getGameData(gameUniqid)) as { game_data?: any } | any | null;
        const raw = gd?.game_data ?? gd;
        const gm = (raw?.game_meta ?? raw) as ClashGameMetaRuntime | undefined;
        if (!cancelled && gm) setMeta(gm);
      } catch (err) {
        console.error('[Clash] failed to load game meta', err);
      }
    })();
    return () => { cancelled = true; };
  }, [gameUniqid]);

  // ── derived lookups ────────────────────────────────────────────────────────
  const clanByTeamId = useMemo(() => {
    const map: Record<number, ClashClanVisual> = {};
    const clans = meta?.clans ?? [];
    for (const s of standings?.clans ?? []) {
      const idx = s.team_number - 1;
      const sc = clans[idx];
      map[s.team_id] = {
        team_id: s.team_id,
        team_number: s.team_number,
        name: s.team_name || pickLocalized(sc?.name, lang) || tc('clan_fallback', { n: s.team_number }),
        color: sc?.color || FALLBACK_COLORS[idx % FALLBACK_COLORS.length],
        banner: sc?.banner || '',
        logo: sc?.logo || '',
        scoreCard: sc?.score_card || '',
      };
    }
    return map;
  }, [standings, meta, lang, tc]);

  const territoryNames = useMemo(() => {
    const names: Record<number, string> = {};
    (meta?.territories ?? []).forEach((t, i) => {
      names[i] = pickLocalized(t.name, lang) || tc('territory_fallback', { n: i + 1 });
    });
    return names;
  }, [meta, lang, tc]);

  // Authored anchors (percent of map) keyed by territory index: the banner
  // plants at banner_position, the name+gauge cluster at label_position. Missing
  // entries fall back to the renderer's grid.
  const anchors = useMemo(() => {
    const out: Record<
      number,
      {
        index: number;
        bannerLeftPct: number;
        bannerTopPct: number;
        labelLeftPct: number;
        labelTopPct: number;
        purgeLeftPct?: number;
        purgeTopPct?: number;
      }
    > = {};
    (meta?.territories ?? []).forEach((t, i) => {
      if (t.banner_position || t.label_position) {
        const label = t.label_position ?? t.banner_position!;
        const banner = t.banner_position ?? t.label_position!;
        out[i] = {
          index: i,
          bannerLeftPct: banner.left,
          bannerTopPct: banner.top,
          labelLeftPct: label.left,
          labelTopPct: label.top,
          // Purge anchor rides along when placed; the renderer derives a spot
          // below the label cluster otherwise.
          ...(t.purge_position
            ? { purgeLeftPct: t.purge_position.left, purgeTopPct: t.purge_position.top }
            : {}),
        };
      }
    });
    return out;
  }, [meta]);

  // The Purge - resolved marker image ('' ⇒ purge visuals off) + preloaded
  // announcement sound (played on EVERY device when any clan's purge fires).
  const purgeImageUrl = useMemo(
    () => (meta?.purge_image ? resolveMedia(meta.purge_image) : ''),
    [meta, resolveMedia],
  );
  const purgeAudioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    purgeAudioRef.current = meta?.purge_sound ? new Audio(resolveMedia(meta.purge_sound)) : null;
  }, [meta, resolveMedia]);

  // Authored timer plate (percent of map); null ⇒ renderer default (top-centre
  // at its natural size). width/height are absent on pre-#52 scenarios, which
  // the renderer reads as "no box".
  const timerPos = useMemo(
    () =>
      meta?.timer_position
        ? {
            leftPct: meta.timer_position.left,
            topPct: meta.timer_position.top,
            widthPct: meta.timer_position.width,
            heightPct: meta.timer_position.height,
          }
        : null,
    [meta],
  );
  // Clock nudge inside the timer plate (retours #54).
  const timerTextOffset = useMemo(
    () =>
      meta?.timer_text_offset
        ? { x: Number(meta.timer_text_offset.x) || 0, y: Number(meta.timer_text_offset.y) || 0 }
        : null,
    [meta],
  );
  // Authored clan-ranking panel box (retours #52); null ⇒ renderer fallback.
  const rankingPos = useMemo(() => {
    const rp = meta?.ranking_position;
    if (!rp) return null;
    return { leftPct: rp.left, topPct: rp.top, widthPct: rp.width, heightPct: rp.height };
  }, [meta]);

  // On-map element sizes (retours #57). Undefined entries fall back to the
  // renderer's defaults, so a pre-#57 scenario looks exactly as it did.
  const sizes = useMemo(() => {
    // Only DEFINED entries are handed over: the renderer spreads this over its
    // defaults, so an explicit `undefined` would wipe one out.
    const out: Partial<ClashSizes> = {};
    const put = (key: keyof ClashSizes, v: unknown) => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[key] = n;
    };
    put('bannerPct', meta?.banner_size_percentage);
    put('purgePct', meta?.purge_size_percentage);
    put('gaugePct', meta?.gauge_size_percentage);
    put('territoryNameScale', meta?.territory_name_scale);
    put('timerScale', meta?.timer_scale);
    return out;
  }, [meta]);

  // Per-element text colours (retours #53); '' ⇒ the renderer's white.
  const colors = useMemo(
    () => ({
      timer: meta?.timer_color || '',
      ranking: meta?.ranking_color || '',
      territoryName: meta?.territory_name_color || '',
      event: meta?.event_color || '',
    }),
    [meta],
  );

  // Scenario-authored event-banner sentences (retours #56), resolved against
  // the LAUNCH language like every other player-facing Clash string.
  const eventTexts = useMemo(
    () => ({
      conquest: pickLocalized(meta?.event_text_conquest, lang),
      attack: pickLocalized(meta?.event_text_attack, lang),
      neutralized: pickLocalized(meta?.event_text_neutralized, lang),
      purge: pickLocalized(meta?.event_text_purge, lang),
      rankingTitle: pickLocalized(meta?.ranking_title, lang),
    }),
    [meta, lang],
  );

  // Scenario-authored purge refusal messages (retours sept. #68); blank ⇒ the
  // app's translated default.
  const purgeTexts = useMemo(
    () => ({
      alreadyUsed: pickLocalized(meta?.purge_text_already_used, lang),
      ownTerritory: pickLocalized(meta?.purge_text_own_territory, lang),
      noTarget: pickLocalized(meta?.purge_text_no_target, lang),
    }),
    [meta, lang],
  );

  // Optional dashboard chrome frame images (resolved; '' ⇒ default styling).
  const frames = useMemo(
    () => ({
      ranking: meta?.frame_ranking ? resolveMedia(meta.frame_ranking) : '',
      timer: meta?.frame_timer ? resolveMedia(meta.frame_timer) : '',
      event: meta?.frame_event ? resolveMedia(meta.frame_event) : '',
      gauge: meta?.frame_gauge ? resolveMedia(meta.frame_gauge) : '',
      territoryName: meta?.frame_territory_name ? resolveMedia(meta.frame_territory_name) : '',
      separator: meta?.frame_separator ? resolveMedia(meta.frame_separator) : '',
    }),
    [meta, resolveMedia],
  );

  // Placed, translatable map labels (authored in the LayoutEditor). Style:
  // element override → scenario default.
  const textElements = useMemo(() => {
    const sFont = meta?.font;
    const sColor = meta?.font_color;
    return (meta?.text_elements ?? [])
      .filter((te) => te.position)
      .map((te) => ({
        id: te.id,
        text: pickLocalized(te.text, lang),
        leftPct: te.position!.left,
        topPct: te.position!.top,
        widthPct: te.position!.width,
        heightPct: te.position!.height,
        fontFamily: te.font || sFont,
        color: te.font_color || sColor,
        bold: te.bold,
        italic: te.italic,
        underline: te.underline,
        align: te.align ?? 'center',
        shadow: te.shadow,
        background: te.background,
      }));
  }, [meta, lang]);

  // ── The Purge: game-wide announcement (sound + full-screen flash) ─────────
  // Fired locally from the validate response on the bipping station, and on
  // every other device by spotting a NEW 'purge' event in the polled standings.
  // The first standings snapshot is a silent BASELINE so a station joining
  // mid-match doesn't replay historical purges.
  const [purgeFlash, setPurgeFlash] = useState<{
    clanName: string;
    clanColor: string;
    terrName: string;
  } | null>(null);
  const purgeFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenPurgeKeysRef = useRef<Set<string>>(new Set());
  const purgeBaselineDoneRef = useRef(false);

  const firePurgeAnnouncement = useCallback(
    (teamId: number | null, terrIndex: number) => {
      const clan = teamId != null ? clanByTeamId[teamId] : undefined;
      setPurgeFlash({
        clanName: clan?.name ?? tc('clan_fallback', { n: '' }).trim(),
        clanColor: clan?.color ?? '#fff',
        terrName: territoryNames[terrIndex] || tc('territory_fallback', { n: terrIndex + 1 }),
      });
      void playAudio(purgeAudioRef.current).catch(() => {});
      if (purgeFlashTimerRef.current) clearTimeout(purgeFlashTimerRef.current);
      purgeFlashTimerRef.current = setTimeout(() => setPurgeFlash(null), 4000);
    },
    [clanByTeamId, territoryNames, tc, playAudio],
  );

  useEffect(() => {
    if (!standings) return;
    const purgeEvents = (standings.events ?? []).filter((e) => e.kind === 'purge');
    if (!purgeBaselineDoneRef.current) {
      purgeEvents.forEach((e) =>
        seenPurgeKeysRef.current.add(`${e.team_id}-${e.territory_index}-${e.at}`),
      );
      purgeBaselineDoneRef.current = true;
      return;
    }
    for (const e of purgeEvents) {
      const key = `${e.team_id}-${e.territory_index}-${e.at}`;
      if (seenPurgeKeysRef.current.has(key)) continue;
      seenPurgeKeysRef.current.add(key);
      if (phaseRef.current === 'playing') firePurgeAnnouncement(e.team_id, e.territory_index);
    }
  }, [standings, firePurgeAnnouncement]);

  // ── standings poll (registration counts + live dashboard) ──────────────────
  useEffect(() => {
    if (!launchedGameId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await getClashState(launchedGameId);
        if (!cancelled) setStandings(s);
      } catch { /* transient - next tick retries */ }
    };
    void tick();
    const h = setInterval(tick, 1000);
    return () => { cancelled = true; clearInterval(h); };
  }, [launchedGameId]);

  // ── Station assignment: while registering (self mode), resolve this device's
  // paired id + read meta.regAssignments, and re-read it on a reload_config
  // push so a Devices-modal reassignment re-locks this kiosk live. ────────────
  useEffect(() => {
    if (!launchedGameId || phase !== 'register' || registrationMode !== 'self') return;
    let cancelled = false;
    void getSelfDeviceId(launchedGameId).then((id) => {
      if (!cancelled) setSelfDeviceId(id);
    });
    const readMap = async () => {
      try {
        const meta = await getLaunchedGameMeta(launchedGameId);
        if (!cancelled) setRegAssignMap(parseRegAssignments(meta[REG_ASSIGNMENTS_META_KEY]));
      } catch (err) {
        console.error('[Clash] regAssignments read failed', err);
      }
    };
    void readMap();
    const off = onPendingConfigReload((gid) => {
      if (gid === launchedGameId) void readMap();
    });
    return () => { cancelled = true; off(); };
  }, [launchedGameId, phase, registrationMode]);

  // Registration selection: default to the first clan with room once standings
  // load, and hop off a clan that filled up (possibly from another station) so
  // the next bip lands on a clan with room. An assigned station only ever
  // scans within its own clan(s) - a hard lock, not a preference.
  useEffect(() => {
    if (phase !== 'register' || !standings?.clans?.length) return;
    setSelectedTeamId((cur) =>
      nextClanSelection(
        filterAssignedClans(standings.clans, assignedTeamNumbers),
        cur,
        standings.max_per_clan ?? 0,
      ),
    );
  }, [standings, phase, assignedTeamNumbers]);

  // Lifecycle: a server `ended` flip (operator End, or another station's
  // expiry) drives us to the results screen rather than straight out.
  useGameStatePolling({
    launchedGameId,
    numberOfTeams: config.numberOfTeams,
    onGameEnded: () => { queue.clear(); setPhase('ended'); },
    onAllTeamsFinished: () => {},
    onNewBip: () => {},
    // A station left on the self-register inscription screen follows the device
    // that pressed "Start game" into play. Enabled during register too (not just
    // playing) so the poll is live to catch the mother's start flag flip;
    // idempotent for the device that started the game itself.
    onGameStarted: () => setPhase('playing'),
    enabled: phase !== 'ended',
    disableAllFinishedEnd: true,
  });

  // Timer + expiry lock. Captures start_time + duration once the match starts,
  // counts down, and at expiry ends the game on the mother (idempotent - the
  // first writer wins; clash_validate then rejects late bips) and shows results.
  useEffect(() => {
    if (!launchedGameId || phase !== 'playing') return;
    let cancelled = false;

    const prime = async () => {
      try {
        const st = await getLaunchedGameState(launchedGameId, 0);
        if (cancelled) return;
        const startMs = st.start_time ? parseDbTs(st.start_time) : NaN;
        const durationSec = (st.duration ?? 0) * 60; // duration is stored in minutes
        if (!Number.isNaN(startMs) && durationSec > 0) {
          endMsRef.current = startMs + durationSec * 1000;
        }
      } catch { /* retry on next tick */ }
    };

    let ticks = 0;
    const tick = () => {
      // Re-prime every ~5s so an operator "add time" (a server duration bump on
      // any station) extends the countdown on every screen.
      if (endMsRef.current == null || ticks % 5 === 0) void prime();
      ticks += 1;
      if (endMsRef.current == null) return;
      const remaining = Math.max(0, Math.round((endMsRef.current - gameClock.now()) / 1000));
      setRemainingSec(remaining);
      if (remaining <= 0) {
        void endLaunchedGame(launchedGameId).catch(() => {});
        queue.clear();
        setPhase('ended');
      }
    };

    void prime();
    const h = setInterval(tick, 1000);
    return () => { cancelled = true; clearInterval(h); };
  }, [launchedGameId, phase]);

  // Messages serialise through the shared queue (label = null: Clash messages
  // aren't team chips - the combo reveal already carries the clan chip).
  // `minSeconds` keeps an important line up even when the operator set a very
  // short message duration (purge refusals: 2 s was missed in the field).
  const showMessage = useCallback((text: string, type: GameMessageType = 'info', label: string | null = null, minSeconds = 0) => {
    void queue.enqueue(label, () => new Promise<void>((resolve) => {
      setMessage(text);
      setMessageType(type);
      if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
      msgTimerRef.current = setTimeout(() => {
        setMessage('');
        msgTimerRef.current = null;
        resolve();
      }, Math.max(config.messageDisplayDuration || 5, minSeconds) * 1000);
    }));
  }, [config.messageDisplayDuration, queue.enqueue]);

  // ── local reader → register (pre-start) or validate (in-match) ─────────────
  const handleLocalCard = useCallback(async (card: CardData) => {
    if (!launchedGameId) return;

    // Registration phase: bind the chip to the station's selected clan.
    if (phaseRef.current === 'register') {
      if (registrationMode !== 'self') return; // predetermined clans were dealt at launch
      const teamId = selectedTeamIdRef.current;
      if (teamId == null) return;
      try {
        // The card's current punches go along: the mother ignores them in the
        // match (leftovers from an earlier game, e.g. a station-25 punch).
        const res = await clashRegister(launchedGameId, teamId, card.id, card.punches ?? []);
        setLastJoin({ teamId, status: res.status });
        // Reflect the server's authoritative count immediately (the 1s poll
        // would lag one bip behind), then hop the station's selection to the
        // next clan with room when this bip filled the clan - or when it had
        // already filled from another station (clan_full race).
        const prev = standingsRef.current;
        if (prev && (res.status === 'ok' || res.status === 'clan_full')) {
          const clans = prev.clans.map((c) =>
            c.team_id === teamId ? { ...c, member_count: res.member_count } : c,
          );
          setStandings({ ...prev, clans });
          setSelectedTeamId((cur) =>
            nextClanSelection(
              filterAssignedClans(clans, assignedTeamNumbersRef.current),
              cur,
              prev.max_per_clan ?? 0,
            ),
          );
        }
      } catch (err) {
        console.error('[Clash] register failed', err);
      }
      return;
    }

    // Best-effort audit trail (also surfaces the bip in raw_data for other tools).
    void recordPunch(launchedGameId, card).catch(() => {});
    try {
      const res = await clashValidate(launchedGameId, card.id, card.punches ?? []);
      if (res.status === 'not_registered') {
        showMessage(tc('msg_not_registered'), 'warning');
        return;
      }
      if (res.status === 'game_over') {
        showMessage(tc('msg_game_over'), 'info');
        return;
      }
      if (res.status !== 'ok') return;
      // The Purge - this read carried an unspent purge-station punch. Success
      // flashes the game-wide announcement immediately on this station (other
      // devices pick it up from the poll ≤1s later). A "no target" / "own
      // territory" refusal leaves the punch pending (retried on every later
      // read), so it is announced once, held ≥5 s, then the station stays quiet.
      if (res.purge?.attempted && !(res.purge.status !== 'ok' && res.purge.repeat)) {
        if (res.purge.status === 'ok' && res.purge.territory_index != null) {
          // Mark the server-authored purge event(s) as seen so the standings
          // effect doesn't double-fire the announcement on the next poll.
          (res.standings?.events ?? [])
            .filter((e) => e.kind === 'purge')
            .forEach((e) =>
              seenPurgeKeysRef.current.add(`${e.team_id}-${e.territory_index}-${e.at}`),
            );
          firePurgeAnnouncement(res.team_id ?? null, res.purge.territory_index);
        } else if (res.purge.status === 'already_used') {
          showMessage(purgeTexts.alreadyUsed || tc('msg_purge_already_used'), 'warning', null, 5);
        } else if (res.purge.status === 'own_territory') {
          showMessage(purgeTexts.ownTerritory || tc('msg_purge_own_territory'), 'warning', null, 5);
        } else if (res.purge.status === 'no_target') {
          showMessage(purgeTexts.noTarget || tc('msg_purge_no_target'), 'warning', null, 5);
        }
      }
      if (res.credited.length === 0) {
        // A purge attempt already produced its own feedback - skip the
        // "keep going" filler in that case. A quiet repeat of a pending purge
        // punch did not, so the normal line applies.
        if (!res.purge?.attempted || (res.purge.status !== 'ok' && res.purge.repeat)) {
          // Name the territory the read got closest to ("Hélico incomplet")
          // rather than a generic line - the operator sees WHICH lot is short.
          // No partial at all ⇒ every punch on the badge was already spent on
          // an earlier validation, so say that instead.
          const partialName =
            res.partial != null ? territoryNames[res.partial.territory_index] : undefined;
          const base = partialName
            ? tc('msg_territory_incomplete', { territory: partialName })
            : res.partial != null
              ? tc('msg_territory_incomplete_generic')
              : tc('msg_no_fresh_punch');
          // Say WHICH balises are still missing, in the numbers printed on them.
          // "incomplete" on its own gave a team nothing to act on (retours #96).
          // Absent on a pre-2026-09 mother ⇒ the bare sentence, as before.
          const missing = res.partial?.missing ?? [];
          const detail = missing.length
            ? ` - ${tc('msg_missing_balises', { count: missing.length, list: missing.join(', ') })}`
            : '';
          showMessage(`${base}${detail}`, 'info');
        }
        return;
      }
      // V2: at most one territory credited per read (no combo/piece art).
      const clan = res.team_id != null ? clanByTeamId[res.team_id] : undefined;
      const terrName = territoryNames[res.credited[0].territory_index];
      showMessage(
        terrName
          ? tc('msg_territory_captured', { territory: terrName })
          : tc('msg_territory_captured_generic'),
        'success',
        clan?.name ?? null,
      );
    } catch (err) {
      console.error('[Clash] validate failed', err);
    }
  }, [launchedGameId, registrationMode, clanByTeamId, territoryNames, queue.enqueue, showMessage, firePurgeAnnouncement, tc]);

  const handleLocalCardRef = useRef(handleLocalCard);
  useEffect(() => { handleLocalCardRef.current = handleLocalCard; });

  // ── USB reader wiring (active in both registration + play phases) ──────────
  useEffect(() => {
    if (!launchedGameId) return;
    let cancelled = false;

    const initUSB = async () => {
      if (!usbReaderService.isAvailable()) return;
      // Bound before reader detection so the game simulator's injected reads
      // (no physical reader) reach the page too; harmless without events.
      usbReaderService.setCardDetectedCallback((card: CardData) => {
        handleLocalCardRef.current(card);
      });
      const detected = await detectReaderPort();
      if (cancelled || !detected) return;
      try {
        const ok = await usbReaderService.initializePort(detected.path);
        if (!ok) return;
        await usbReaderService.start();
      } catch (err) {
        console.error('[Clash] USB init failed', err);
      }
    };

    const onReaderStatus = () => { void initUSB(); };
    void initUSB();
    window.addEventListener('reader:status', onReaderStatus);
    return () => {
      usbReaderService.setCardDetectedCallback(undefined);
      cancelled = true;
      window.removeEventListener('reader:status', onReaderStatus);
      if (usbReaderService.isAvailable()) usbReaderService.stop().catch(() => {});
    };
  }, [launchedGameId]);

  // ── Fast reader hotplug on the inscription screen ──────────────────────────
  // The reader effect above (re)binds on the global 'reader:status' event, but
  // that only fires off the footer's 10s poll - a dongle plugged in mid-
  // registration then takes up to 10s to come alive, which reads as broken.
  // While registering, actively probe every 2s and re-emit 'reader:status' as
  // soon as a reader appears so the bind path fires within ~2s. Once bound,
  // initializePort no-ops, so re-emitting is cheap. Scoped to the register
  // phase so reader-less devices don't probe serial forever during play.
  useEffect(() => {
    if (!launchedGameId || phase !== 'register') return;
    if (!usbReaderService.isAvailable()) return;
    let cancelled = false;
    const id = setInterval(() => {
      void isReaderConnected().then((ok) => {
        if (ok && !cancelled) {
          window.dispatchEvent(new CustomEvent('reader:status', { detail: { state: 'ok' } }));
        }
      });
    }, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [launchedGameId, phase]);

  // Resume an already-started game (e.g. a station joining mid-match) → skip
  // registration and go straight to the live dashboard.
  useEffect(() => {
    if (!launchedGameId) return;
    let cancelled = false;
    (async () => {
      try {
        const st = await getLaunchedGameState(launchedGameId, 0);
        if (!cancelled && (st.started || st.start_time)) setPhase('playing');
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [launchedGameId]);

  const handleStart = useCallback(async () => {
    if (!launchedGameId) return;
    try {
      await startLaunchedGame(launchedGameId, gameClock.date().toISOString());
    } catch (err) {
      console.error('[Clash] start failed', err);
    } finally {
      setPhase('playing');
    }
  }, [launchedGameId]);

  // The operator's remote Start (Devices modal / game card): same as the
  // registration screen's Start button.
  const handleStartRef = useRef(handleStart);
  handleStartRef.current = handleStart;
  useEffect(() => {
    if (!launchedGameId) return;
    return onPendingStart((gid) => {
      if (gid !== launchedGameId || phaseRef.current !== 'register') return false;
      phaseRef.current = 'playing';
      void handleStartRef.current();
      return true;
    });
  }, [launchedGameId]);

  // Tell the Devices modals this screen waits on its registration Start.
  useEffect(() => {
    if (!launchedGameId) return;
    refineInGame(launchedGameId, { sub: phase === 'register' ? 'register' : undefined });
  }, [launchedGameId, phase]);
  useEffect(() => {
    if (!launchedGameId) return;
    return () => clearInGameRefinement(launchedGameId);
  }, [launchedGameId]);

  const fontFamily = meta?.font;

  if (phase === 'register' && launchedGameId) {
    // Scenario visual shown as the registration background; the screen falls
    // back to the clan banners when the scenario has none. Clash has no
    // `background_image` any more (retours #49) - `game_visual` is the only
    // cover art it carries, in the licensee's language when the scenario has
    // that version.
    const regVisualUrl = resolveMedia(pickGameVisual(meta, user?.language) || '');
    return (
      <ClashRegistrationScreen
        standings={standings}
        clanByTeamId={clanByTeamId}
        mode={registrationMode}
        selectedTeamId={selectedTeamId}
        onSelectClan={setSelectedTeamId}
        onStart={handleStart}
        onBack={onBack}
        lastJoin={lastJoin}
        visualUrl={regVisualUrl}
        resolveMedia={resolveMedia}
        assignedTeamNumbers={assignedTeamNumbers}
        lang={lang}
      />
    );
  }

  if (phase === 'ended') {
    return (
      <ClashResultsScreen
        standings={standings}
        clanByTeamId={clanByTeamId}
        territoryNames={territoryNames}
        resolveMedia={resolveMedia}
        fontFamily={fontFamily}
        lang={lang}
        onBack={onBack}
      />
    );
  }

  return (
    <>
      <ClashGameRenderer
        standings={standings}
        territoryNames={territoryNames}
        clanByTeamId={clanByTeamId}
        resolveMedia={resolveMedia}
        mapImage={meta?.map_image ?? ''}
        anchors={anchors}
        textElements={textElements}
        frames={frames}
        fontFamily={fontFamily}
        remainingSec={remainingSec}
        timerPos={timerPos}
        timerTextOffset={timerTextOffset}
        rankingPos={rankingPos}
        sizes={sizes}
        colors={colors}
        eventTexts={eventTexts}
        purge={standings?.purge ?? null}
        purgeImageUrl={purgeImageUrl}
        lang={lang}
      />

      {/* The Purge announcement - the game's biggest twist moment, flashed on
          EVERY in-game device (locally on the bipping station, poll-detected on
          the others) alongside the scenario purge sound. */}
      {purgeFlash && purgeImageUrl && (
        <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-black/75 pointer-events-none">
          <img
            src={purgeImageUrl}
            alt=""
            className="h-48 object-contain animate-pulse drop-shadow-2xl"
          />
          {/* The scenario's purge sentence when authored (the same one the
              bottom banner uses), else the app default - retours sept. #68. */}
          <div className="mt-6 text-4xl font-bold text-center px-8" style={{ fontFamily }}>
            {(eventTexts.purge
              ? renderEventSentence(eventTexts.purge, purgeFlash.clanName, purgeFlash.terrName)
              : [
                  { text: purgeFlash.clanName, clan: true },
                  { text: ` ${tc('purge_announcement', { territory: purgeFlash.terrName })}`, clan: false },
                ]
            ).map((run, ri) => (
              <span key={ri} style={run.clan ? { color: purgeFlash.clanColor } : undefined} className={run.clan ? undefined : 'text-white'}>
                {run.text}
              </span>
            ))}
          </div>
        </div>
      )}

      <GameMessageOverlay message={message} type={messageType} fontFamily={fontFamily} />

      <PendingTeamsBar labels={queue.pending} lang={lang} fontFamily={fontFamily} />
    </>
  );
}
