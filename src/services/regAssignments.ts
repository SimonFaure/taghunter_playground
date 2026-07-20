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
 * Auto-assign: deal team_number 1..teamCount round-robin over the eligible
 * devices, in order. Teams > devices ⇒ devices get several teams; devices >
 * teams ⇒ the leftover devices stay unassigned (full grid). The caller decides
 * eligibility (the default deal excludes the mother and reader-less devices -
 * both stay manually assignable).
 */
export function computeAutoRegAssignments(
  deviceIds: number[],
  teamCount: number,
): RegAssignmentMap {
  const out: RegAssignmentMap = {};
  if (deviceIds.length === 0 || teamCount <= 0) return out;
  for (let teamNumber = 1; teamNumber <= teamCount; teamNumber++) {
    const id = deviceIds[(teamNumber - 1) % deviceIds.length];
    (out[id] ??= []).push(teamNumber);
  }
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
 * keyed by) via the bucketed devices view - the self row carries is_self.
 */
export async function getSelfDeviceId(launchedGameId: number): Promise<number | null> {
  try {
    const buckets = await listPairedWithStatus(launchedGameId);
    const all = [...buckets.in_game, ...buckets.available_online, ...buckets.offline];
    return all.find((r) => r.is_self)?.id ?? null;
  } catch {
    return null;
  }
}
