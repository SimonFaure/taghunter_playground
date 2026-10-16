// Game simulator planner: reads the launched game and builds the whole
// session up front from the seed (deterministic -> replayable).

import { getLaunchedGameMeta, getLaunchedGameState } from '../services/launchedGames';
import * as patternStore from '../services/patternStore';
import { gameConfigFromMeta } from '../utils/gameConfigFromMeta';
import { SIM_CHIP_BASE, isSimChipId } from '../services/simChips';
import { cardTypeFor, makeRng, pickPlayers } from './profiles';
import type { Team as LaunchTeam } from '../components/LaunchGameModal';
import { planMystery } from './models/mystery';
import { planTracks } from './models/tracks';
import { planQuest, type QuestTeam } from './models/quest';
import { planClash, type ClashClan } from './models/clash';
import * as scenarioStore from '../services/scenarioStore';
import { getClashMembers, type ClashConfig, type ClashMember } from '../services/clash';
import type { SimConfig, SimPlan } from './types';

export interface PlanTeam {
  label: string;
  cardId: number;
  cardType: string;
  /** Virtual epoch ms the team first reaches the reader. */
  arriveAt: number;
  /** "Départ groupé": the roster was started at launch, no start bip. */
  alreadyStarted: boolean;
  /** Player first names (rostered teammates, else 2-5 fake ones). */
  players: string[];
  /** Self-register games: the name the mock team types in the overlay. */
  selfRegisterName?: string;
  /** Self-register with the player language choice: the flag the team picks. */
  selfRegisterLanguage?: string;
  /** Tracks: this team's route (per-team launch override). */
  route?: string;
}

export async function buildPlan(cfg: SimConfig, virtualStart: number): Promise<SimPlan> {
  const rng = makeRng(cfg.seed);
  // Separate stream for names so adding players never reshuffles behaviour.
  const nameRng = makeRng(cfg.seed ^ 0xa11ce);
  const warnings: string[] = [];
  const [state, meta] = await Promise.all([
    getLaunchedGameState(cfg.launchedGameId, 0),
    getLaunchedGameMeta(cfg.launchedGameId),
  ]);
  const gameType = (state.game_type || '').toLowerCase();
  const config = gameConfigFromMeta(meta, { name: state.name, numberOfTeams: state.teams.length });

  if (meta.simulated !== 'true') {
    warnings.push('This game was not launched as a Simulated session.');
  }

  const cardTeamGame = gameType === 'mystery' || gameType === 'tracks';
  // Teams: the roster when there is one, else virtual chips arriving over the window.
  const arrivalMs = Math.max(0, cfg.arrivalWindowMin) * 60_000;
  const open = state.teams.filter((t) => t.key_id != null && t.end_time == null);
  let rostered: LaunchTeam[] = [];
  try {
    rostered = meta.teamsConfig ? (JSON.parse(meta.teamsConfig) as LaunchTeam[]) : [];
  } catch {
    rostered = [];
  }
  const playersFor = (chipId: number) => {
    const mates = rostered.find((r) => r.chipId === chipId)?.teammates ?? [];
    const names = mates.map((m) => m.name).filter(Boolean);
    return names.length > 0 ? names : pickPlayers(nameRng);
  };
  let teams: PlanTeam[];
  if (!cardTeamGame) {
    teams = [];
  } else if (open.length > 0) {
    teams = open.map((t) => ({
      label: t.team_name || `Team ${t.team_number}`,
      cardId: t.key_id!,
      cardType: cardTypeFor(t.key_id!),
      arriveAt: virtualStart + (config.massStart ? 0 : rng() * arrivalMs),
      alreadyStarted: t.start_time != null,
      players: playersFor(t.key_id!),
      route: meta[`route:${t.id}`] || undefined,
    }));
    if (open.some((t) => !isSimChipId(t.key_id!))) {
      warnings.push('Some teams use real chips: their reads are simulated too.');
    }
  } else if (config.autoRegisterTeam || config.selfRegisterTeam) {
    const used = new Set(state.teams.map((t) => t.key_id));
    teams = [];
    for (let n = 1; teams.length < cfg.dynamicTeamCount; n++) {
      const cardId = SIM_CHIP_BASE + n;
      if (used.has(cardId)) continue;
      teams.push({
        label: `SIM ${n}`,
        cardId,
        cardType: 'SI10',
        arriveAt: virtualStart + rng() * arrivalMs,
        alreadyStarted: false,
        players: pickPlayers(nameRng),
      });
    }
  } else {
    teams = [];
    warnings.push('No open team and no auto/self-register: nothing to play.');
  }
  if (cardTeamGame && config.selfRegisterTeam) {
    // Player language choice: about half the teams switch to another scenario
    // language (drawn on the name stream, so behaviour is unchanged).
    const langs = config.allowPlayerLanguageChoice ? (config.scenarioLanguages ?? []) : [];
    teams.forEach((t, i) => {
      t.selfRegisterName = `Team ${t.players[0] ?? 'SIM'} ${i + 1}`;
      t.label = t.selfRegisterName;
      if (langs.length >= 2 && nameRng() < 0.5) {
        t.selfRegisterLanguage = langs[Math.floor(nameRng() * langs.length)];
      }
    });
  }

  let reads: SimPlan['reads'] = [];
  let tracks: SimPlan['tracks'] = [];
  let purgeAt: number | undefined;
  if (gameType === 'mystery') {
    const enigmas = await patternStore.getMysteryEnigmas(config.pattern);
    if (enigmas.length === 0) warnings.push('The pattern has no enigma stations.');
    ({ reads, tracks } = planMystery({
      teams,
      enigmas,
      limitSec: (config.duration ?? 0) * 60,
      rng,
      profileMix: cfg.profileMix,
      resetAction: config.autoResetTeam ? undefined : config.enterToReset ? 'pressEnter' : 'pressReset',
    }));
  } else if (gameType === 'tracks') {
    const stations = await patternStore.getTracksCheckpointStations(config.pattern);
    if (stations.size === 0) warnings.push('The pattern has no checkpoint stations.');
    ({ reads, tracks } = planTracks({
      teams,
      stations,
      route: config.route,
      limitSec: (config.duration ?? 0) * 60,
      playMode: config.trackPlayMode === 'itinerary' ? 'itinerary' : 'free',
      rng,
      profileMix: cfg.profileMix,
    }));
  } else if (gameType === 'tagquest' || gameType === 'clash') {
    // Fresh virtual chips for mock players (never one already bound in this game).
    const used = new Set<number>(state.teams.map((t) => t.key_id ?? 0));
    let members: ClashMember[] = [];
    try {
      members = await getClashMembers(cfg.launchedGameId);
    } catch {
      members = [];
    }
    members.forEach((m) => used.add(m.chip_id));
    let nextChip = 1;
    const freshChip = () => {
      while (used.has(SIM_CHIP_BASE + nextChip)) nextChip++;
      used.add(SIM_CHIP_BASE + nextChip);
      return SIM_CHIP_BASE + nextChip;
    };
    let clashCfg: ClashConfig = { territories: [] };
    try {
      clashCfg = meta.clash_config ? (JSON.parse(meta.clash_config) as ClashConfig) : clashCfg;
    } catch {
      /* keep empty */
    }
    const cap = clashCfg.max_per_clan && clashCfg.max_per_clan > 0 ? clashCfg.max_per_clan : 5;
    const mockPlayers = (n: number) => pickPlayers(nameRng, n, n).map((name) => ({ name, chipId: freshChip() }));
    const openTeams = state.teams.filter((t) => t.end_time == null);

    if (gameType === 'tagquest') {
      const teamMode = (config.playMode ?? 'team') === 'team';
      const selfReg = !!config.tagquestSelfRegister;
      let qTeams: QuestTeam[] = [];
      if (teamMode && !selfReg) {
        qTeams = openTeams.map((t, i) => {
          const launch = rostered[t.team_number - 1] ?? rostered[i];
          const mates = (launch?.teammates ?? []).filter((m) => m.chipId);
          const players = mates.length
            ? mates.map((m) => ({ name: m.name || `Player ${m.chipNumber}`, chipId: m.chipId }))
            : t.key_id
              ? [{ name: pickPlayers(nameRng, 1, 1)[0], chipId: t.key_id }]
              : [];
          return { key: `team-${t.id}`, label: t.team_name || `Team ${t.team_number}`, teamId: t.id, players };
        });
        if (qTeams.some((q) => q.players.length === 0)) {
          warnings.push('Some teams have no chip in the roster: they cannot play.');
        }
      } else if (teamMode && selfReg) {
        qTeams = openTeams.map((t) => ({
          key: `team-${t.id}`,
          label: t.team_name || `Team ${t.team_number}`,
          teamId: t.id,
          players: mockPlayers(Math.min(cap, 2 + Math.floor(nameRng() * 3))),
        }));
      } else if (!selfReg) {
        qTeams = openTeams
          .filter((t) => t.key_id != null)
          .map((t) => ({
            key: `team-${t.id}`,
            label: t.team_name || `Player ${t.team_number}`,
            teamId: t.id,
            players: [{ name: t.team_name || pickPlayers(nameRng, 1, 1)[0], chipId: t.key_id as number }],
          }));
      } else {
        // Solo self-register: the app names each player after the chip
        // ("SIM n") - there is no name entry - so the journal does too.
        qTeams = mockPlayers(cfg.dynamicTeamCount).map((p, i) => {
          const label = `SIM ${p.chipId - SIM_CHIP_BASE}`;
          return { key: `solo-${i}`, label, players: [{ ...p, name: label }] };
        });
      }
      const gd = (await scenarioStore.getGameData(state.game_uniqid).catch(() => null)) as {
        game_data?: { game_meta?: Record<string, unknown> };
        game_meta?: Record<string, unknown>;
      } | null;
      const gm = (gd?.game_data?.game_meta ?? gd?.game_meta ?? {}) as Record<string, unknown>;
      const malus = Number(gm.malus_station);
      const routing = await patternStore.getRouting(config.pattern);
      const byQuest = new Map<number, number[]>();
      for (const r of routing) {
        const list = byQuest.get(r.item_index) ?? [];
        list.push(Number(r.station_key_number));
        byQuest.set(r.item_index, list);
      }
      const quests = Array.from(byQuest.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, st]) => st.filter(Number.isFinite));
      if (quests.length === 0) warnings.push('The pattern has no quest stations.');
      ({ reads, tracks } = planQuest({
        teams: qTeams,
        quests,
        malusStation: Number.isFinite(malus) && malus > 0 ? malus : undefined,
        registration: selfReg ? { teamMode } : null,
        virtualStart,
        limitSec: (config.duration ?? 0) * 60,
        speedMode: (meta.victoryType ?? 'speed') === 'speed',
        rng,
        profileMix: cfg.profileMix,
      }));
    } else {
      const bulk = (meta.clashRegistrationMode ?? 'self') === 'bulk';
      const clans: ClashClan[] = openTeams.map((t) => {
        const bound = members.filter((m) => m.team_id === t.id);
        const players = bulk
          ? bound.map((m, i) => ({ name: pickPlayers(nameRng, 1, 1)[0] ?? `Player ${i + 1}`, chipId: m.chip_id }))
          : mockPlayers(Math.min(cap, 2 + Math.floor(nameRng() * 4)));
        return { key: `clan-${t.id}`, label: t.team_name || `Clan ${t.team_number}`, teamId: t.id, players };
      });
      if (bulk && clans.every((c) => c.players.length === 0)) {
        warnings.push('Predefined teams: no chip is bound to any clan.');
      }
      if (clashCfg.territories.length === 0) warnings.push('The Clash config has no territory.');
      const clash = planClash({
        clans,
        config: clashCfg,
        selfRegistration: !bulk,
        virtualStart,
        limitSec: (config.duration ?? 0) * 60,
        rng,
        purgeRng: makeRng(cfg.seed ^ 0x9a26e),
        profileMix: cfg.profileMix,
        purgeAtMs: cfg.clashPurgeAtMin !== undefined ? cfg.clashPurgeAtMin * 60_000 : undefined,
      });
      ({ reads, tracks } = clash);
      purgeAt = clash.purgeAt;
      warnings.push(...clash.warnings);
    }
  } else {
    warnings.push(`Game type "${gameType}" can't be simulated.`);
  }

  reads.sort((a, b) => a.at - b.at);
  const last = reads.length ? reads[reads.length - 1].at : virtualStart;
  if (new Date(last).toDateString() !== new Date(virtualStart).toDateString()) {
    warnings.push('The session crosses midnight: SI punch times (HH:MM:SS) will wrap.');
  }
  const teamNumbers: Record<string, number> = {};
  if (gameType === 'tagquest' || gameType === 'clash') {
    for (const t of state.teams) {
      teamNumbers[`team-${t.id}`] = t.team_number;
      teamNumbers[`clan-${t.id}`] = t.team_number;
    }
  }
  return { seed: cfg.seed, gameType, virtualStart, reads, tracks, warnings, purgeAt, teamNumbers };
}
