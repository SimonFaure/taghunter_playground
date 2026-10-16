// Quest (TagQuest) behaviour model. Every PLAYER owns a chip; its SI card keeps
// every punch until the end (each read carries the whole card, the page only
// counts what's new). A player makes trips: punch the stations of 1-2 quests
// (sometimes missing one = partial, sometimes the malus station), come back
// and bip. The team ends when its leader bips with a finish record.
//
// Self-register games first play the registration screen: pick the team, bip
// every chip, press Start. Otherwise the game clock started when the page
// opened (mass start), so players just go.

import { between, chance, hms, pickProfile, type Rng } from '../profiles';
import type { ProfileId, SimActivity, SimRead, SimTeamTrack } from '../types';

const UNKNOWN_STATION = 250;
/** Finish station record (any code ends the team; the test modals use 254). */
const FINISH_CODE = 254;

export interface QuestPlayer {
  name: string;
  chipId: number;
}

export interface QuestTeam {
  key: string;
  label: string;
  /** Existing team row (team mode / rostered); undefined for solo self-register. */
  teamId?: number;
  players: QuestPlayer[];
}

export interface QuestModelInput {
  teams: QuestTeam[];
  /** Station ids of each quest, in quest order. */
  quests: number[][];
  malusStation?: number;
  /** Registration screen to play first (self-register games). */
  registration: { teamMode: boolean } | null;
  /** Virtual ms the run starts (registration, or play when no registration). */
  virtualStart: number;
  limitSec: number;
  /** Speed victory: a team completes each quest once. */
  speedMode: boolean;
  rng: Rng;
  profileMix: Record<ProfileId, number>;
}

export function planQuest(input: QuestModelInput): { reads: SimRead[]; tracks: SimTeamTrack[] } {
  const { teams, quests, malusStation, registration, virtualStart, limitSec, speedMode, rng, profileMix } = input;
  const reads: SimRead[] = [];
  const tracks: SimTeamTrack[] = [];
  const refSec = limitSec > 0 ? limitSec : 60 * 60;
  const allStations = quests.flat();
  const emptyCard = (chipId: number) => ({
    cardId: chipId,
    cardType: 'SI10',
    start: null,
    finish: null,
    check: null,
    punches: [] as SimRead['card']['punches'],
  });

  // ── registration screen (self-register): pick team, bip each chip, Start ──
  let gameStart = virtualStart;
  if (registration) {
    let t = virtualStart + 5_000;
    for (const team of teams) {
      for (const p of team.players) {
        reads.push({
          key: team.key,
          team: team.label,
          profile: 'average',
          at: t,
          intent: `${p.name} registers`,
          card: emptyCard(p.chipId),
          actions:
            registration.teamMode && team.teamId !== undefined
              ? [{ kind: 'selectTeam', teamId: team.teamId }]
              : undefined,
        });
        t += 7_000;
      }
    }
    gameStart = t + 10_000;
    reads.push({
      key: teams[0]?.key ?? 'registration',
      team: 'operator',
      profile: 'average',
      at: gameStart,
      intent: 'presses Start',
      card: emptyCard(0),
      skip: true,
      actions: [{ kind: 'pressStart' }],
    });
  }

  for (const team of teams) {
    const profile = pickProfile(rng, profileMix);
    const activities: SimActivity[] = [];
    const act = (at: number, label: string) => activities.push({ at, label });
    const track: SimTeamTrack = {
      key: team.key,
      team: team.label,
      profile: profile.id,
      players: team.players.map((p) => p.name),
      activities,
    };
    tracks.push(track);
    act(registration ? virtualStart : gameStart, registration ? 'waiting to register' : 'game started');
    if (registration) act(gameStart, 'game started');

    const teamEnd = gameStart + between(rng, profile.pace[0], profile.pace[1]) * refSec * 1000;
    const done = new Set<number>(); // quests the team already completed (speed mode)
    const teamAbandons = chance(rng, profile.chaos * 0.15);
    if (teamAbandons) track.abandonAt = gameStart + (teamEnd - gameStart) * 0.6;
    const stopAt = track.abandonAt ?? teamEnd;

    team.players.forEach((p, pi) => {
      const isLeader = pi === 0;
      const card: SimRead['card']['punches'] = [];
      const snapshot = () => ({ ...emptyCard(p.chipId), punches: [...card] });
      const base = { key: team.key, team: team.label, profile: profile.id };
      // The finishing leader heads for the finish 90 s before the end: its
      // trips stop 2 min before, so the trip bip and the FINISH bip are not
      // the same instant (the reader would coalesce them).
      const tripsUntil = isLeader && !teamAbandons ? stopAt - 120_000 : stopAt;
      let t = gameStart + between(rng, 0.5, 2) * 60_000;
      while (t < tripsUntil) {
        const tripMs = between(rng, 4, 9) * 60_000 * (profile.pace[0] + profile.pace[1]) / 1.6;
        const tripEnd = Math.min(t + tripMs, tripsUntil);
        if (tripEnd - t < 60_000) break;
        // Pick 1-2 quests (speed mode: ones the team hasn't completed).
        const open = quests.map((_, i) => i).filter((i) => !speedMode || !done.has(i));
        const pool = open.length ? open : quests.map((_, i) => i);
        const picks = pool.sort(() => rng() - 0.5).slice(0, 1 + (rng() < 0.4 ? 1 : 0));
        const labels: string[] = [];
        const steps = picks.reduce((n, qi) => n + quests[qi].length, 0) + 1;
        let k = 0;
        const at = () => t + (++k / (steps + 1)) * (tripEnd - t);
        for (const qi of picks) {
          const st = quests[qi];
          const missing = st.length > 1 && !chance(rng, profile.accuracy) ? Math.floor(rng() * st.length) : -1;
          st.forEach((code, si) => {
            const when = at();
            if (si === missing) return;
            card.push({ code, time: hms(when) });
          });
          act(t + 30_000, `${p.name} heads for quest ${qi + 1}`);
          if (missing < 0) done.add(qi);
          labels.push(`Q${qi + 1}${missing >= 0 ? ' partial' : ''}`);
        }
        if (malusStation !== undefined && chance(rng, profile.skip)) {
          card.push({ code: malusStation, time: hms(at()) });
          labels.push('malus');
          act(at(), `${p.name} punches the malus station`);
        }
        if (chance(rng, profile.chaos * 0.15)) {
          card.push({ code: UNKNOWN_STATION, time: hms(at()) });
          labels.push('unknown station');
        }
        act(tripEnd - 20_000, `${p.name} back to the reader`);
        reads.push({ ...base, at: tripEnd, intent: `${p.name}: ${labels.join(', ')}`, card: snapshot() });
        if (chance(rng, profile.chaos * 0.2)) {
          reads.push({ ...base, at: tripEnd + 1500, noGap: true, intent: `${p.name}: double read`, card: snapshot() });
        }
        if (chance(rng, profile.chaos * 0.1)) {
          reads.push({
            ...base,
            at: tripEnd + 40_000,
            intent: `${p.name}: bips again with nothing new`,
            card: snapshot(),
          });
        }
        t = tripEnd + between(rng, 0.3, 1) * 60_000;
      }

      if (isLeader && !teamAbandons) {
        // Last trip: one more station + the finish box, then bip.
        const extra = allStations[Math.floor(rng() * allStations.length)] ?? 31;
        const noNew = chance(rng, profile.chaos * 0.3);
        if (!noNew) card.push({ code: extra, time: hms(teamEnd - 60_000) });
        act(teamEnd - 90_000, `${p.name} goes to the finish`);
        const late = limitSec > 0 && teamEnd - gameStart > limitSec * 1000;
        reads.push({
          ...base,
          at: teamEnd,
          intent: `${p.name}: FINISH${late ? ' (late)' : ''}${noNew ? ' - no new punch since last bip' : ''}`,
          card: { ...snapshot(), finish: { code: FINISH_CODE, time: hms(teamEnd) } },
        });
      }
    });
    if (teamAbandons) act(track.abandonAt!, 'gives up - never finishes');
    else act(teamEnd + 1000, 'finished');
    activities.sort((a, b) => a.at - b.at);
  }
  return { reads, tracks };
}
