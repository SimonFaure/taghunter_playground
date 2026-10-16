// Mystery behaviour model: start bip -> walk the enigmas punching the GOOD or
// WRONG station (or none) -> end bip. Chaos adds the real-world slips.

import type { PatternEnigma } from '../../services/patternStore';
import { between, chance, hms, pickProfile, type Rng } from '../profiles';
import type { SimActivity, SimRead, SimTeamTrack, ProfileId } from '../types';
import type { PlanTeam } from '../planner';

/** A station code no scenario uses: the "unknown station" chaos punch. */
const UNKNOWN_STATION = 250;

export interface MysteryModelInput {
  teams: PlanTeam[];
  enigmas: PatternEnigma[];
  /** Game time limit in seconds (0 = none authored). */
  limitSec: number;
  rng: Rng;
  profileMix: Record<ProfileId, number>;
  /** How the results hold is cleared before each bip: Enter ("press Enter to
   *  reset"), the summary's reset button (manual), or nothing (auto reset). */
  resetAction?: 'pressEnter' | 'pressReset';
}

const code = (s: string) => parseInt(s, 10);

export function planMystery({ teams, enigmas, limitSec, rng, profileMix, resetAction }: MysteryModelInput): {
  reads: SimRead[];
  tracks: SimTeamTrack[];
} {
  const reads: SimRead[] = [];
  const tracks: SimTeamTrack[] = [];
  // Without an authored limit, model a typical 45-minute run.
  const refSec = limitSec > 0 ? limitSec : 45 * 60;

  const enter = resetAction ? [{ kind: resetAction }] : [];
  for (const team of teams) {
    const profile = pickProfile(rng, profileMix);
    const key = String(team.cardId);
    const base = { key, team: team.label, profile: profile.id };
    // Field view: what the team does between bips. Players are cosmetic in
    // Mystery (one team card) - they take turns carrying it, by enigma.
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

    act(start, team.alreadyStarted ? 'leaves together (mass start)' : 'arrives to bip the start');
    // Start bip (skipped when "Départ groupé" already started the roster).
    if (!team.alreadyStarted) {
      const stale = chance(rng, profile.chaos * 0.3);
      const stalePunches = stale
        ? [0, 1].map((i) => ({
            code: code(enigmas[Math.floor(rng() * enigmas.length)]?.good_answers[0] ?? '31'),
            time: hms(start - (2 * 3600 + i * 60) * 1000),
          }))
        : [];
      reads.push({
        ...base,
        at: start,
        intent: stale ? 'start, card not wiped' : 'start',
        card: card(stalePunches),
        actions: [
          ...enter,
          ...(team.selfRegisterName
            ? [{ kind: 'selfRegister' as const, name: team.selfRegisterName, language: team.selfRegisterLanguage, cardId: team.cardId }]
            : []),
        ],
      });
      if (chance(rng, profile.chaos * 0.3)) {
        reads.push({ ...base, at: start + 1500, noGap: true, intent: 'double read (debounce)', card: card(stalePunches) });
      }
      if (chance(rng, profile.chaos * 0.2)) {
        reads.push({ ...base, at: start + 20_000, intent: 're-bip right after start (empty card)', card: card(stalePunches) });
      }
    }

    // Walk the enigmas in a random order, spread over the run.
    const order = enigmas.map((e, i) => ({ e, k: rng(), i })).sort((a, b) => a.k - b.k);
    const punches: SimRead['card']['punches'] = [];
    const answers: string[] = [];
    order.forEach(({ e }, idx) => {
      const t = start + ((idx + 1) / (order.length + 1)) * playMs;
      const prev = start + (idx / (order.length + 1)) * playMs + 30_000;
      act(prev, `looking for enigma ${e.enigma_id}`);
      const good = e.good_answers.map(code).filter(Number.isFinite);
      const wrong = e.wrong_answers.map(code).filter(Number.isFinite);
      const r = rng();
      if (r < profile.skip || (good.length === 0 && wrong.length === 0)) {
        answers.push(`${e.enigma_id}:-`);
        act(t, `skips enigma ${e.enigma_id}`);
        return;
      }
      const goodPick = rng() < profile.accuracy || wrong.length === 0;
      const pick = goodPick && good.length ? good : wrong.length ? wrong : good;
      punches.push({ code: pick[Math.floor(rng() * pick.length)], time: hms(t) });
      let mark = goodPick ? 'G' : 'W';
      act(t, `${who(idx)} punches st. ${punches[punches.length - 1].code} (enigma ${e.enigma_id}, ${goodPick ? 'good' : 'wrong'})`);
      if (chance(rng, profile.chaos * 0.15) && good.length && wrong.length) {
        // Changed their mind: both answers on the card.
        const other = goodPick ? wrong : good;
        punches.push({ code: other[0], time: hms(t + 40_000) });
        mark = 'GW';
        act(t + 40_000, `${who(idx + 1)} changes their mind: punches st. ${other[0]} too`);
      }
      answers.push(`${e.enigma_id}:${mark}`);
    });
    if (chance(rng, profile.chaos * 0.2)) {
      punches.push({ code: UNKNOWN_STATION, time: hms(start + playMs / 2) });
      answers.push('unknown station');
      act(start + playMs / 2, `${who(1)} punches an unknown station (${UNKNOWN_STATION})`);
    }

    const lastPunchAt = start + (order.length / (order.length + 1)) * playMs;
    if (chance(rng, profile.chaos * 0.25)) {
      track.abandonAt = lastPunchAt + 60_000;
      act(track.abandonAt, 'gives up - never comes back');
      activities.sort((a, b) => a.at - b.at);
      reads.push({ ...base, at: end, intent: `abandoned (never came back) - ${answers.join(' ')}`, card: card(punches), skip: true });
      continue;
    }

    act(lastPunchAt + 30_000, 'heading back to the reader');
    activities.sort((a, b) => a.at - b.at);
    const late = limitSec > 0 && playMs > limitSec * 1000;
    reads.push({
      ...base,
      at: end,
      intent: `end${late ? ' (late)' : ''} - ${answers.join(' ')}`,
      card: card(punches),
      actions: enter,
    });
    act(end + 1000, 'finished');
    if (chance(rng, profile.chaos * 0.3)) {
      const again = end + between(rng, 60, 300) * 1000;
      act(again - 30_000, 'comes back to bip again');
      reads.push({ ...base, at: again, intent: 're-bip after end', card: card(punches) });
    }
    activities.sort((a, b) => a.at - b.at);
  }
  return { reads, tracks };
}
