// Clash runtime service - thin wrappers over the mother's server-authoritative
// clash_* endpoints (LAN-mother-only). The mother owns crediting, consumed-punch
// dedup, and ownership math; this file just shuttles requests/results.
//
// Design: project_clash_game_type_design.

import { apiCall } from './api';
import { withRetry } from './apiRetry';

// ---------- config (persisted into the launch's clash_config meta) ----------

/**
 * Fallback "The Purge" station for scenarios authored before retours #50 put
 * the number in Studio (game_meta.purge_station). The launch field prefills
 * from the scenario and only lands here when the scenario says nothing.
 */
export const DEFAULT_CLASH_PURGE_STATION = 25;

export interface ClashConfigTerritory {
  index: number;
  /** Points-per-minute paid to the controlling clan (V2 domination scoring). */
  points: number;
  /** Physical balise station codes composing this territory (V2, variable count). */
  balises: number[];
  /** The authored station NUMBERS, positionally paired with `balises` (which
   *  hold the ids the SI punches carry). Lets the mother name a missing balise
   *  the way it is labelled in the field (retours #96). */
  balise_numbers?: number[];
  /** @deprecated V1 volume/last-bipper size. */
  size?: 'large' | 'medium' | 'small';
  /** @deprecated V1 combination indices. */
  combos?: number[];
}

export interface ClashConfig {
  territories: ClashConfigTerritory[];
  /** 0 / omitted ⇒ unlimited. */
  max_per_clan?: number;
  /** "The Purge" launch toggle (omitted in pre-purge launches ⇒ off). */
  purge_enabled?: boolean;
  /** Physical SI station whose punch attempts a purge (default 25). */
  purge_station?: number;
  /** @deprecated V1 combos array (territories now carry balises directly). */
  combos?: { index: number; stations: number[] }[];
}

// ---------- standings (returned by clash_state + clash_validate) ----------

export interface ClashClanStanding {
  team_id: number;
  team_number: number;
  team_name: string | null;
  member_count: number;
  /** Weighted cumulative score, rounded for display (V2 effectif weighting). */
  points: number;
  /** Exact unrounded weighted score - used for tiebreak (V2). */
  points_exact?: number;
  /** Current weighted "+X pts/min" domination rate (V2). */
  rate?: number;
  /** Effectif multiplier locked at game start (largest ÷ this) (V2). */
  weight?: number;
}

export interface ClashTerritoryStanding {
  index: number;
  points: number;
  owner_team_id: number | null;
  /** team_id (string key) -> validation count on this territory. */
  counts: Record<string, number>;
  /** @deprecated V1 fields. */
  size?: 'large' | 'medium' | 'small';
  last_team_id?: number | null;
}

/** Mother-authored event-feed line (V2). Kind + actor clan + territory + server time. */
export interface ClashEvent {
  kind: 'conquest' | 'attack' | 'neutralized' | 'purge';
  team_id: number | null;
  territory_index: number;
  /** Server epoch ms (client derives "il y a X min"). */
  at: number;
}

/** "The Purge" live state (in every standings payload). */
export interface ClashPurgeState {
  enabled: boolean;
  /** Physical purge station code. */
  station: number;
  /** The ONE territory a purge would hit right now (null ⇒ no target: no
   *  unique leading clan yet, or the leader has no validations). */
  target_territory_index: number | null;
  /** team_ids whose one purge is already spent. */
  used_by: number[];
}

export interface ClashStandings {
  status: 'ok' | 'no_config';
  clans: ClashClanStanding[];
  territories: ClashTerritoryStanding[];
  total_points_possible: number;
  max_per_clan?: number;
  /** Recent event-feed lines, most-recent first (V2). */
  events?: ClashEvent[];
  /** The Purge state (absent on pre-purge mothers). */
  purge?: ClashPurgeState;
}

// ---------- punch shape (from the SI card read) ----------

export interface ClashPunch {
  code: number;
  time: string;
}

export interface ClashValidateResult {
  status: 'ok' | 'not_registered' | 'game_over' | 'no_config';
  team_id?: number;
  /** V2: at most one entry - the single territory credited by this read. */
  credited: Array<{ territory_index: number; combo_index?: number }>;
  standings?: Omit<ClashStandings, 'status' | 'max_per_clan'> & { status?: string };
  /** Present when nothing was credited AND at least one territory had a fresh
   *  punch: the territory the read came closest to completing. Absent means no
   *  fresh punch matched any territory (card already spent, or nothing new). */
  partial?: {
    territory_index: number;
    have: number;
    need: number;
    /** The balises of that territory the read is still missing, in the numbers
     *  printed on them (retours #96). Absent on pre-2026-09 mothers. */
    missing?: number[];
  };
  /** Present when the read carried an unspent purge-station punch. `ok` = the
   *  purge fired on territory_index. `no_target` / `own_territory` keep both the
   *  clan's quota AND the punch: it stays pending and is retried on every later
   *  read of the card. `already_used` spends the punch. */
  purge?: {
    attempted: boolean;
    status: 'ok' | 'already_used' | 'no_target' | 'own_territory';
    territory_index?: number;
    /** The same pending punch was already refused on an earlier read - the
     *  station stays quiet. Absent on older mothers. */
    repeat?: boolean;
  };
}

export interface ClashRegisterResult {
  status: 'ok' | 'clan_full' | 'already_in_clan' | 'already_in_other_clan' | 'team_not_found';
  team_id: number;
  member_count: number;
}

// ---------- endpoints ----------

/** Bind a chip to a clan (server-enforced cap + single-clan membership).
 *  `punches` = the card's current punches, sent only by the Clash station's
 *  self-registration bip: the mother marks them consumed so leftovers from an
 *  earlier game (cards aren't always wiped) don't count. */
export async function clashRegister(
  launchedGameId: number,
  teamId: number,
  chipId: number,
  punches?: ClashPunch[],
): Promise<ClashRegisterResult> {
  return withRetry(() =>
    apiCall<ClashRegisterResult>('launched_games', 'clash_register', {
      method: 'POST',
      bearer: true,
      body: {
        launched_game_id: launchedGameId,
        team_id: teamId,
        chip_id: chipId,
        ...(punches ? { punches } : {}),
      },
    }),
  );
}

/**
 * Validate a central-reader card-read: the mother credits every fresh
 * combination among the card's unconsumed punches and returns what was
 * credited (for the local reveal) plus fresh standings.
 */
export async function clashValidate(
  launchedGameId: number,
  chipId: number,
  punches: ClashPunch[],
): Promise<ClashValidateResult> {
  return withRetry(() =>
    apiCall<ClashValidateResult>('launched_games', 'clash_validate', {
      method: 'POST',
      bearer: true,
      body: { launched_game_id: launchedGameId, chip_id: chipId, punches },
    }),
  );
}

/** Read-only standings + clan member counts - drives the live dashboard. */
export async function getClashState(launchedGameId: number): Promise<ClashStandings> {
  return withRetry(() =>
    apiCall<ClashStandings>('launched_games', 'clash_state', {
      method: 'GET',
      bearer: true,
      query: { id: launchedGameId },
    }),
  );
}

export interface ClashMember {
  team_id: number;
  chip_id: number;
  created_at?: string;
}

/** Operator: the chips bound to each clan (launched-game page + clan modal). */
export async function getClashMembers(launchedGameId: number): Promise<ClashMember[]> {
  const res = await withRetry(() =>
    apiCall<{ members: ClashMember[] }>('launched_games', 'clash_members', {
      method: 'GET',
      bearer: true,
      query: { id: launchedGameId },
    }),
  );
  return res.members ?? [];
}

/** Operator: unbind a chip from its clan (manual correction). */
export async function clashUnregister(
  launchedGameId: number,
  chipId: number,
): Promise<{ deleted: boolean }> {
  return withRetry(() =>
    apiCall<{ deleted: boolean }>('launched_games', 'clash_unregister', {
      method: 'POST',
      bearer: true,
      body: { launched_game_id: launchedGameId, chip_id: chipId },
    }),
  );
}
