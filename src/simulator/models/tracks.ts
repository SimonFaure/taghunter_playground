// Tracks behaviour model: start bip (empty card) -> walk the team's route,
// punching each checkpoint's station -> finish bip with the whole card.
// Mass start: the roster is already started, the first bip is the finish.
// Profiles: speed, skipped checkpoints, order swaps (itinerary mode), wrong
// stations. Chaos: card not wiped at start (held, wiped, bipped again), double read,
// re-bip after finishing (clues page), giving up.

import { checkpointsForRoute, firstSlotByCheckpoint, orderedHitCheckpointIds } from '../../services/tracksScoring';
import { between, chance, hms, pickProfile, type Rng } from '../profiles';
import type { ProfileId, SimActivity, SimExpect, SimRead, SimTeamTrack } from '../types';
import type { PlanTeam } from '../planner';

const UNKNOWN_STATION = 250;

export interface TracksModelInput {
  teams: Array<PlanTeam & { route?: string }>;
  /** Checkpoint position (1-based, full course) -> its station ids. */
  stations: Map<number, number[]>;
  /** Default route of the launch (per-team overrides come in `teams[].route`). */
  route?: string;
  /** Game time limit in seconds (0 = none). */
  limitSec: number;
  /** Launch play mode: itinerary walks the route in card order. */
  playMode?: 'itinerary' | 'free';
  rng: Rng;
  profileMix: Record<ProfileId, number>;
}

export function planTracks({ teams, stations, route, limitSec, playMode, rng, profileMix }: TracksModelInput): {
  reads: SimRead[];
  tracks: SimTeamTrack[];
} {
  const reads: SimRead[] = [];
  const tracks: SimTeamTrack[] = [];
  const refSec = limitSec > 0 ? limitSec : 60 * 60;
  const positions = Array.from(stations.keys()).sort((a, b) => a - b);
  const course = positions.map((p) => ({ id: String(p) }));
  const allStations = positions.flatMap((p) => stations.get(p) ?? []);

  for (const team of teams) {
    const profile = pickProfile(rng, profileMix);
    const key = String(team.cardId);
    const base = { key, team: team.label, profile: profile.id };
    const activities: SimActivity[] = [];
    const act = (at: number, label: string) => activities.push({ at, label });
    const who = (i: number) => team.players[i % team.players.length] ?? team.label;
    const track: SimTeamTrack = { key, team: team.label, profile: profile.id, players: team.players, activities };
    tracks.push(track);
    const card = (punches: SimRead['card']['punches']) => ({
      cardId: team.cardId,
      cardType: team.cardType,
      start: null,
      finish: null,
      check: null,
      punches,
    });

    const start = team.arriveAt;
    const playMs = between(rng, profile.pace[0], profile.pace[1]) * refSec * 1000;
    const end = start + playMs;
    const teamRoute = team.route ?? route ?? 'default';
    const order = checkpointsForRoute(course, teamRoute).map((c) => Number(c.id));

    // Start bip.
    act(start, team.alreadyStarted ? 'leaves together (mass start)' : 'arrives to bip the start');
    if (!team.alreadyStarted) {
      const notWiped = chance(rng, profile.chaos * 0.25);
      const leftovers = notWiped
        ? [{ code: allStations[Math.floor(rng() * allStations.length)] ?? 31, time: hms(start - 3 * 3600_000) }]
        : [];
      const registerActions: SimRead['actions'] = team.selfRegisterName
        ? [{ kind: 'selfRegister', name: team.selfRegisterName, language: team.selfRegisterLanguage, cardId: team.cardId }]
        : undefined;
      reads.push({
        ...base,
        at: start,
        intent: notWiped ? 'start, card not wiped (held)' : 'start',
        card: card(leftovers),
        // A held start shows no name prompt: the name is typed on the clean bip.
        actions: notWiped ? undefined : registerActions,
      });
      if (notWiped) {
        // The page holds the start and asks for a wipe; the team wipes its card
        // and bips again: a normal start. (Bipping again WITHOUT wiping makes
        // the page recover a finished run from the card's times - a team that
        // then walks the whole course would contradict that.)
        reads.push({
          ...base,
          at: start + 30_000,
          intent: 'wipes the card, bips the start again',
          card: card([]),
          actions: registerActions,
        });
      }
      if (chance(rng, profile.chaos * 0.3)) {
        reads.push({ ...base, at: start + 1500, noGap: true, intent: 'double read (debounce)', card: card(leftovers) });
      }
    }

    // Walk the route. Itinerary faults: swap two neighbours, skip one.
    const walk = [...order];
    const marks: string[] = [];
    if (chance(rng, profile.skip * 2) && walk.length > 3) {
      const i = 1 + Math.floor(rng() * (walk.length - 2));
      [walk[i], walk[i + 1]] = [walk[i + 1], walk[i]];
      // Both still punched ("ok"), but out of order: costs one in itinerary.
      marks.push(`swap ${walk[i + 1]}<->${walk[i]}`);
    }
    const punches: SimRead['card']['punches'] = [];
    // Stations of the checkpoints this team has already punched right.
    const punchedStations: number[] = [];
    walk.forEach((pos, idx) => {
      const t = start + ((idx + 1) / (walk.length + 1)) * playMs;
      act(start + (idx / (walk.length + 1)) * playMs + 30_000, `looking for checkpoint ${pos}`);
      if (chance(rng, profile.skip)) {
        marks.push(`${pos}:-`);
        act(t, `misses checkpoint ${pos}`);
        return;
      }
      const st = stations.get(pos) ?? [];
      if (st.length === 0) return;
      if (!chance(rng, profile.accuracy) && chance(rng, 0.3)) {
        // Wrong station: the box of a checkpoint already punched (re-punched by
        // mistake), so it can never credit this checkpoint, a missed one or one
        // still ahead - the game matches punches by station, so any of those
        // would really be a right punch and the "W" label would lie. Nothing
        // punched yet: a station outside the course. One draw either way, so
        // a seed replays the same course.
        const draw = rng();
        const other = punchedStations.length
          ? punchedStations[Math.floor(draw * punchedStations.length)]
          : UNKNOWN_STATION;
        punches.push({ code: other, time: hms(t) });
        marks.push(`${pos}:W`);
        act(t, `${who(idx)} punches the wrong box (st. ${other})`);
        return;
      }
      const code = st[Math.floor(rng() * st.length)];
      punches.push({ code, time: hms(t) });
      punchedStations.push(...st);
      marks.push(`${pos}:ok`);
      act(t, `${who(idx)} punches checkpoint ${pos} (st. ${code})`);
    });
    if (chance(rng, profile.chaos * 0.2)) {
      punches.push({ code: UNKNOWN_STATION, time: hms(start + playMs / 2) });
      marks.push('unknown station');
      act(start + playMs / 2, `${who(1)} punches an unknown station (${UNKNOWN_STATION})`);
    }
    const lastAt = start + (walk.length / (walk.length + 1)) * playMs;

    if (chance(rng, profile.chaos * 0.2)) {
      track.abandonAt = lastAt + 60_000;
      act(track.abandonAt, 'gives up - never comes back');
      activities.sort((a, b) => a.at - b.at);
      reads.push({ ...base, at: end, intent: `abandoned - ${marks.join(' ')}`, card: card(punches), skip: true });
      continue;
    }

    act(lastAt + 30_000, 'heading back to the reader');
    const late = limitSec > 0 && playMs > limitSec * 1000;
    const expect = expectedHits(course, teamRoute, stations, punches, playMode, late);
    reads.push({
      ...base,
      at: end,
      intent:
        `finish (${teamRoute})${late ? ' late' : ''} - ${marks.join(' ')}` +
        ` - expect ${expect.hits}/${expect.of} checkpoints${late ? ' before the late malus' : ''}`,
      card: card(punches),
      expect,
    });
    act(end + 1000, 'finished');
    if (chance(rng, profile.chaos * 0.3)) {
      const again = end + between(rng, 60, 240) * 1000;
      act(again - 30_000, 'comes back to see the clues page');
      reads.push({ ...base, at: again, intent: 're-bip after finish (clues page)', card: card(punches) });
    }
    activities.sort((a, b) => a.at - b.at);
  }
  return { reads, tracks };
}

/** The checkpoints the game should credit for this card, with the game's own
 *  matching - so a verdict compares the standings to a number, not to a count
 *  of the journal's ok/W marks. */
function expectedHits(
  course: Array<{ id: string }>,
  teamRoute: string,
  stations: Map<number, number[]>,
  punches: SimRead['card']['punches'],
  playMode: 'itinerary' | 'free' | undefined,
  late: boolean,
): SimExpect {
  const routeCps = checkpointsForRoute(course, teamRoute);
  const slots = firstSlotByCheckpoint(routeCps, (cp) => Number(cp.id), stations, punches);
  const hits =
    playMode === 'itinerary'
      ? orderedHitCheckpointIds(routeCps, slots).hitIds.size
      : routeCps.filter((cp) => slots.get(cp.id) !== undefined).length;
  return { hits, of: routeCps.length, late };
}
