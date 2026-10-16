// Game simulator shared types (tester builds only).

import type { SimClockState } from '../services/gameClock';
import type { SimBusAction } from '../services/simBus';

export type ProfileId = 'fast' | 'average' | 'slow' | 'chaotic';

export const DEFAULT_PROFILE_MIX: Record<ProfileId, number> = { fast: 2, average: 4, slow: 2, chaotic: 1 };

export interface SimConfig {
  launchedGameId: number;
  seed: number;
  /** 1..20 */
  speed: number;
  /** Relative weights of each behaviour profile. */
  profileMix: Record<ProfileId, number>;
  /** Teams to create for auto/self-register games (rostered games use their roster). */
  dynamicTeamCount: number;
  /** Minutes over which dynamic teams arrive (0 = all at once). */
  arrivalWindowMin: number;
  /** Spread the mock teams over every device of the game (default on). Each
   *  device bips its own teams' cards on its own reader, on one shared clock. */
  spreadAcrossDevices?: boolean;
  /** Devices the game was launched on (meta simDevices). The director waits for
   *  them to open the game before dealing the teams. */
  expectedDevices?: number;
  /** Clash: minutes after Start of the planned Purge attempt (undefined = random). */
  clashPurgeAtMin?: number;
}

/** A card exactly as `si_simulate_card` expects it (CardPayload shape). */
export interface SimCard {
  cardId: number;
  cardType: string;
  start: { code: number; time: string } | null;
  finish: { code: number; time: string } | null;
  check: { code: number; time: string } | null;
  punches: Array<{ code: number; time: string }>;
}

export interface SimRead {
  /** Virtual epoch ms at which the team reaches the reader. */
  at: number;
  /** Links the read to its SimTeamTrack. */
  key: string;
  /** Multi-device runs: the device whose reader bips this card. */
  device?: number;
  /** Team label for the journal (chip-based; the app names teams itself). */
  team: string;
  profile: ProfileId;
  /** What the team did - ground truth for the journal. */
  intent: string;
  card: SimCard;
  /** Injected right after the previous read, without the human handling gap. */
  noGap?: boolean;
  /** Journal only, never injected (e.g. a team that abandoned, or a step that
   *  only presses something on screen). */
  skip?: boolean;
  /** On-screen steps emitted on the sim bus just before the bip (or alone,
   *  with `skip`): self-register name, team pick, Start, Enter. */
  actions?: SimBusAction[];
  /** Tracks finish reads: what the card should score (see SimExpect). */
  expect?: SimExpect;
}

/** Tracks: the finish card's checkpoints the game should credit, worked out
 *  with the game's own matching (tracksScoring) on the card the model built. */
export interface SimExpect {
  hits: number;
  of: number;
  /** Over the time limit: the late malus also applies. */
  late: boolean;
}

/** One step of what a team does between bips (ground truth for the field view). */
export interface SimActivity {
  /** Virtual epoch ms the activity starts. */
  at: number;
  label: string;
}

/** A mock team's whole story: its players and what they do over time. */
export interface SimTeamTrack {
  key: string;
  team: string;
  profile: ProfileId;
  players: string[];
  /** Sorted by `at`. */
  activities: SimActivity[];
  /** Virtual ms the team gives up (never comes back), if it does. */
  abandonAt?: number;
}

export type FieldState = 'not_arrived' | 'field' | 'reader' | 'done' | 'abandoned';

/** A team's live state at the current simulated time. */
export interface FieldRow {
  key: string;
  team: string;
  profile: ProfileId;
  players: string[];
  state: FieldState;
  action: string;
  nextBipAt: number | null;
  nextBipIntent?: string;
  lastBipAt?: number;
  lastBipIntent?: string;
}

export interface SimPlan {
  seed: number;
  gameType: string;
  virtualStart: number;
  reads: SimRead[];
  tracks: SimTeamTrack[];
  warnings: string[];
  /** Clash: the planned Purge attempt (virtual epoch ms). */
  purgeAt?: number;
  /** Quest / Clash: track key -> the team's team_number, to send a team's
   *  registration bips to the device whose registration lock includes it. */
  teamNumbers?: Record<string, number>;
}

export interface JournalEntry {
  /** Virtual epoch ms the read was injected. */
  at: number;
  team: string;
  profile: ProfileId;
  intent: string;
  cardId: number;
  punches: number;
  ok: boolean;
  error?: string;
  /** Never played: the run was stopped before its time came. */
  dropped?: boolean;
  expect?: SimExpect;
}

/** 'opening' = waiting for the game page to open and bind its card handler. */
export type SimPhase = 'idle' | 'opening' | 'running' | 'paused' | 'done' | 'stopped' | 'error';

export interface SimStatus {
  phase: SimPhase;
  launchedGameId: number | null;
  done: number;
  total: number;
  queued: number;
  clock: SimClockState | null;
  warnings: string[];
  message?: string;
  /** Multi-device run this status belongs to (same on every participant). */
  runKey?: string;
  /** solo = one device; director = planned + drives the run; follower = plays its share. */
  role?: 'solo' | 'director' | 'follower';
  /** Devices taking part in the run. */
  devices?: number;
  /** Run facts for the verdict / coverage record. */
  seed?: number;
  teams?: number;
  errors?: number;
  /** Virtual epoch ms of this device's next planned read; null once none is left.
   *  A run waiting for a read still to come is not stalled. */
  nextAt?: number | null;
  /** A read is due but held: the game page is closed on this device. */
  holding?: boolean;
  /** The game page for this game is open on this device and bound to the reader. */
  pageListening: boolean;
  /** Paused automatically because the game page was left; resumes when it's back. */
  pausedByPage?: boolean;
}

/** What a director sends each follower device: the whole plan (cards stripped
 *  from the reads another device bips) + the shared clock. */
export interface SimRunShare {
  runKey: string;
  launchedGameId: number;
  directorId: number;
  seed: number;
  devices: number;
  clock: SimClockState;
  plan: SimPlan;
}

/** Control window -> main window. */
export type SimCommand =
  | { kind: 'start'; config: SimConfig }
  /** Director -> follower: play your share of this run. */
  | { kind: 'joinRun'; run: SimRunShare }
  /** Director -> follower: the shared clock changed (pause / speed), or the run stopped (null). */
  | { kind: 'runClock'; runKey: string; clock: SimClockState | null }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'speed'; speed: number }
  | { kind: 'stop' }
  | { kind: 'status' };

export const EVT_SIM_CMD = 'sim://cmd';
export const EVT_SIM_STATUS = 'sim://status';
export const EVT_SIM_JOURNAL = 'sim://journal';
export const EVT_SIM_CLOCK = 'sim://clock';
export const EVT_SIM_FIELD = 'sim://field';

/** What a device's executor mirrors into launched-game meta for remote controllers. */
export interface SimRemoteStatus {
  status: SimStatus;
  journal: JournalEntry[];
  field?: FieldRow[];
  /** Real epoch ms of the write (staleness check on the controller). */
  updatedAt: number;
}

export const MIRROR_JOURNAL_TAIL = 40;
/** A device's FULL journal of a shared run, written to the game meta when its
 *  share ends (`sim_journal:<deviceId>`), so the director's result has it all. */
export interface SimJournalMirror {
  runKey: string;
  entries: JournalEntry[];
}
export const SIM_JOURNAL_PREFIX = 'sim_journal:';

/** The game's standings at one moment of a run (stored only when they change,
 *  and at least once per simulated minute). */
export interface ScoreSnapshot {
  /** Virtual epoch ms. */
  at: number;
  teams: Array<{
    team: string;
    score: number;
    started?: boolean;
    ended?: boolean;
    /** Clash: members at Start, effectif weight, current pts/min. */
    members?: number;
    weight?: number;
    rate?: number;
  }>;
  /** Clash: territory number (1-based) -> owning clan, null = neutral. */
  owners?: Record<number, string | null>;
  /** Clash: clans whose Purge is spent. */
  purgedBy?: string[];
  /** Clash: the territory a Purge would hit right now (1-based). */
  purgeTarget?: number | null;
}
export const simJournalKey = (deviceId: number) => `${SIM_JOURNAL_PREFIX}${deviceId}`;
export const SIM_STATUS_PREFIX = 'sim_status:';
export const simStatusKey = (deviceId: number) => `${SIM_STATUS_PREFIX}${deviceId}`;
