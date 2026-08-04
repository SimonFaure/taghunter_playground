// Team→device registration assignments for the station-based self-register
// modes (Clash 'self' + TagQuest self-register team mode).
//
// The map lives in ONE launched-game meta key (`regAssignments`) as JSON
// `{ "<device_id>": [team_number, ...] }`. A device with an entry becomes a
// hard-locked registration kiosk showing only its assigned team(s); a device
// with no entry keeps the legacy pick-any-team grid (which is also the
// backward-compat and late-joiner behaviour). Several devices may share a team
// - the server's max_per_clan cap arbitrates. Keys are paired_devices.id;
// values are team_number (team ids don't exist yet at launch time).
//
// Enforcement is client-side only by design: the station just never offers a
// team outside its assignment. Design: project_selfregister_team_device_assignment.

import { listPairedWithStatus } from './launchedGames';

/** device_id → assigned team_numbers. Empty/missing entry ⇒ unrestricted. */
export type RegAssignmentMap = Record<number, number[]>;

export const REG_ASSIGNMENTS_META_KEY = 'regAssignments';

export function parseRegAssignments(raw: string | null | undefined): RegAssignmentMap {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: RegAssignmentMap = {};
    for (const [k, v] of Object.entries(obj)) {
      const id = Number(k);
      if (!Number.isInteger(id) || !Array.isArray(v)) continue;
      const teams = v
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (teams.length > 0) out[id] = teams;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeRegAssignments(map: RegAssignmentMap): string {
  // Drop empty entries - "no entry" is the canonical unrestricted state.
  const clean: RegAssignmentMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (v.length > 0) clean[Number(k)] = v;
  }
  return JSON.stringify(clean);
}

/**
 * Auto-assign: spread team_number 1..teamCount over the eligible devices so
 * EVERY eligible device ends up with at least one team (operators expect the
 * switch to fill the whole list, not leave rows empty).
 *
 * - teams >= devices: contiguous balanced blocks, biggest first. 6 teams / 4
 *   devices ⇒ [1,2] [3,4] [5] [6]. Contiguous (not round-robin) so a station
 *   reads as "Équipe 1 + Équipe 2" rather than "Équipe 1 + Équipe 4".
 * - devices > teams: teams cycle, one per device, so the extra stations double
 *   up on a team (allowed by design - the server's max_per_clan arbitrates).
 */
export function computeAutoRegAssignments(
  deviceIds: number[],
  teamCount: number,
): RegAssignmentMap {
  const out: RegAssignmentMap = {};
  const n = deviceIds.length;
  if (n === 0 || teamCount <= 0) return out;
  if (teamCount < n) {
    deviceIds.forEach((id, i) => { out[id] = [(i % teamCount) + 1]; });
    return out;
  }
  const base = Math.floor(teamCount / n);
  const extra = teamCount % n;
  let next = 1;
  deviceIds.forEach((id, i) => {
    const size = base + (i < extra ? 1 : 0);
    out[id] = Array.from({ length: size }, () => next++);
  });
  return out;
}

/** This device's assigned team numbers, or null when unrestricted. */
export function assignedTeamNumbersFor(
  map: RegAssignmentMap,
  deviceId: number | null,
): number[] | null {
  if (deviceId == null) return null;
  const teams = map[deviceId];
  return teams && teams.length > 0 ? teams : null;
}

/**
 * Resolve THIS device's paired_devices.id (the device_id the assignment map is
 * keyed by) via the bucketed devices view.
 *
 * Uses `caller_device_id`, which the server derives from OUR bearer secret.
 * The rows' `is_self` flag is NOT usable here: a satellite reads this list off
 * the mother's server, where `is_self` marks the MOTHER's row - so every
 * satellite used to resolve itself to the mother's id and inherit the mother's
 * station assignment (or none at all). The `is_self` fallback below only exists
 * for a mother still running an older build, where the caller IS the DB owner
 * and the two agree.
 */
export async function getSelfDeviceId(launchedGameId: number): Promise<number | null> {
  try {
    const buckets = await listPairedWithStatus(launchedGameId);
    if (typeof buckets.caller_device_id === 'number') return buckets.caller_device_id;
    console.warn('[regAssignments] mother did not report caller_device_id - falling back to is_self');
    const all = [...buckets.in_game, ...buckets.available_online, ...buckets.offline];
    return all.find((r) => r.is_self)?.id ?? null;
  } catch {
    return null;
  }
}
