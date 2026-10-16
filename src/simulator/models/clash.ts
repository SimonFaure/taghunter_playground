// Clash behaviour model. Clans of players, each with a chip. Registration
// screen first: self mode = pick the clan + bip each chip; bulk mode = chips
// were bound at launch, nothing to bip. Then Start. Players capture
// territories: punch every station of one territory, come back, bip (the
// server credits at most one territory per read and consumes the punches).
// Rivals recapture the same territories. The Purge: one player of one clan
// always goes for it at a set time (`purgeAtMs` after Start, else at random
// between 25 % and 60 % of the game), so the purge can be tested on purpose;
// other clans may also try theirs, at random, before 85 % of the game.
// The game ends by itself when its duration runs out.

import type { ClashConfig } from '../../services/clash';
import { between, chance, hms, makeRng, pickProfile, type Rng } from '../profiles';
import type { ProfileId, SimActivity, SimRead, SimTeamTrack } from '../types';

export interface ClashPlayer {
  name: string;
  chipId: number;
}

export interface ClashClan {
  key: string;
  label: string;
  teamId: number;
  players: ClashPlayer[];
}

export interface ClashModelInput {
  clans: ClashClan[];
  config: ClashConfig;
  /** Self registration: bip each chip on the registration screen. */
  selfRegistration: boolean;
  virtualStart: number;
  limitSec: number;
  rng: Rng;
  /** Every Purge draw comes from this stream, so the same seed plays the same
   *  game with the Purge on or off (only the purge punches differ). */
  purgeRng: Rng;
  profileMix: Record<ProfileId, number>;
  /** The planned Purge attempt, ms after Start (undefined = random 25-60 %). */
  purgeAtMs?: number;
}

export interface ClashPlan {
  reads: SimRead[];
  tracks: SimTeamTrack[];
  /** The planned Purge attempt (virtual epoch ms), when the Purge is on. */
  purgeAt?: number;
  warnings: string[];
}

export function planClash(input: ClashModelInput): ClashPlan {
  const { clans, config, selfRegistration, virtualStart, limitSec, rng, purgeRng, profileMix } = input;
  const warnings: string[] = [];
  const reads: SimRead[] = [];
  const tracks: SimTeamTrack[] = [];
  const territories = (config.territories ?? []).filter((t) => (t.balises ?? []).length > 0);
  const durationMs = (limitSec > 0 ? limitSec : 30 * 60) * 1000;
  const card0 = (chipId: number) => ({
    cardId: chipId,
    cardType: 'SI10',
    start: null,
    finish: null,
    check: null,
    punches: [] as SimRead['card']['punches'],
  });

  // ── registration screen ──
  let t = virtualStart + 5_000;
  if (selfRegistration) {
    for (const clan of clans) {
      for (const p of clan.players) {
        reads.push({
          key: clan.key,
          team: clan.label,
          profile: 'average',
          at: t,
          intent: `${p.name} joins ${clan.label}`,
          card: card0(p.chipId),
          actions: [{ kind: 'selectTeam', teamId: clan.teamId }],
        });
        t += 7_000;
      }
    }
  }
  const gameStart = t + 10_000;
  reads.push({
    key: clans[0]?.key ?? 'registration',
    team: 'operator',
    profile: 'average',
    at: gameStart,
    intent: 'presses Start',
    card: card0(0),
    skip: true,
    actions: [{ kind: 'pressStart' }],
  });
  const gameEnd = gameStart + durationMs;

  // ── the planned Purge: who, and when ──
  const purgeOn = !!(config.purge_enabled && config.purge_station && territories.length);
  let purgeAt: number | undefined;
  let purger: { clan: number; player: number } | null = null;
  if (purgeOn) {
    const wanted = input.purgeAtMs ?? durationMs * between(purgeRng, 0.25, 0.6);
    purgeAt = gameStart + Math.max(60_000, Math.min(wanted, durationMs - 20_000));
    if (input.purgeAtMs !== undefined && input.purgeAtMs > durationMs - 20_000) {
      warnings.push(`The Purge was asked at ${Math.round(input.purgeAtMs / 60_000)} min, after the end of the game: moved to 20 s before the end.`);
    }
    const withPlayers = clans.map((c, i) => (c.players.length ? i : -1)).filter((i) => i >= 0);
    if (withPlayers.length) {
      const ci = withPlayers[Math.floor(purgeRng() * withPlayers.length)];
      purger = { clan: ci, player: Math.floor(purgeRng() * clans[ci].players.length) };
    }
  }
  /** Random extra purges by other clans stay early enough to watch. */
  const randomPurgeUntil = gameStart + durationMs * 0.85;

  for (const [clanIdx, clan] of clans.entries()) {
    const profile = pickProfile(rng, profileMix);
    const activities: SimActivity[] = [];
    const act = (at: number, label: string) => activities.push({ at, label });
    tracks.push({
      key: clan.key,
      team: clan.label,
      profile: profile.id,
      players: clan.players.map((p) => p.name),
      activities,
    });
    act(virtualStart, selfRegistration ? 'waiting to register' : 'registered at launch');
    act(gameStart, 'game started');
    // One purge per clan: the planned purger's clan never tries another one.
    let purgeTried = purger?.clan === clanIdx;

    for (const [playerIdx, p] of clan.players.entries()) {
      // Each player has its own stream (one draw from the clan stream, always
      // taken): a purger's detour then changes nothing for anyone else.
      const prng = makeRng(Math.floor(rng() * 0x7fffffff));
      const card: SimRead['card']['punches'] = [];
      const snapshot = () => ({ ...card0(p.chipId), punches: [...card] });
      const base = { key: clan.key, team: clan.label, profile: profile.id };
      const isPurger = purger?.clan === clanIdx && purger.player === playerIdx && purgeAt !== undefined;
      let purgeDone = false;
      const goPurge = (at: number) => {
        card.push({ code: config.purge_station!, time: hms(at - 20_000) });
        act(at - 20_000, `${p.name} goes for the Purge`);
        reads.push({ ...base, at, intent: `${p.name}: PURGE (planned)`, card: snapshot() });
        purgeDone = true;
      };
      const quitAt =
        !isPurger && chance(prng, profile.chaos * 0.15) ? gameStart + durationMs * between(prng, 0.3, 0.7) : gameEnd;
      let tt = gameStart + between(prng, 0.3, 1.5) * 60_000;
      while (tt < quitAt - 60_000 && territories.length) {
        const tripMs = between(prng, 2, 6) * 60_000 * (profile.pace[0] + profile.pace[1]) / 1.6;
        // The planned purger breaks off for the Purge when its time comes.
        if (isPurger && !purgeDone && tt + tripMs >= purgeAt! - 30_000) {
          const at = Math.min(Math.max(purgeAt!, tt + 40_000), gameEnd - 5_000);
          goPurge(at);
          tt = at + between(prng, 0.2, 0.8) * 60_000;
          continue;
        }
        const tripEnd = Math.min(tt + tripMs, gameEnd - 5_000);
        if (tripEnd - tt < 45_000) break;
        // Prefer valuable territories, but not always.
        const ter =
          prng() < 0.6
            ? [...territories].sort((a, b) => (b.points ?? 0) - (a.points ?? 0))[Math.floor(prng() * Math.min(2, territories.length))]
            : territories[Math.floor(prng() * territories.length)];
        const balises = ter.balises;
        const missing = balises.length > 1 && !chance(prng, profile.accuracy) ? Math.floor(prng() * balises.length) : -1;
        balises.forEach((code, i) => {
          if (i === missing) return;
          card.push({ code, time: hms(tt + ((i + 1) / (balises.length + 2)) * (tripEnd - tt)) });
        });
        act(tt + 20_000, `${p.name} heads for territory ${ter.index + 1}`);
        let label = `territory ${ter.index + 1}${missing >= 0 ? ' (missing a station)' : ''}`;
        if (
          purgeOn &&
          !purgeTried &&
          tripEnd < randomPurgeUntil &&
          chance(purgeRng, 0.15 + profile.chaos * 0.3)
        ) {
          purgeTried = true;
          card.push({ code: config.purge_station!, time: hms(tripEnd - 30_000) });
          label += ' + PURGE';
          act(tripEnd - 30_000, `${p.name} tries the Purge`);
        }
        reads.push({ ...base, at: tripEnd, intent: `${p.name}: ${label}`, card: snapshot() });
        if (chance(prng, profile.chaos * 0.2)) {
          reads.push({ ...base, at: tripEnd + 1500, noGap: true, intent: `${p.name}: double read`, card: snapshot() });
        }
        tt = tripEnd + between(prng, 0.2, 0.8) * 60_000;
      }
      if (isPurger && !purgeDone && purgeAt! < gameEnd - 5_000) goPurge(Math.max(purgeAt!, tt));
      if (quitAt < gameEnd) act(quitAt, `${p.name} stops playing`);
    }
    act(gameEnd, 'time is up');
    activities.sort((a, b) => a.at - b.at);
  }

  // A read after the end of the game (it must answer "game over").
  const latecomer = clans[0]?.players[0];
  if (latecomer) {
    reads.push({
      key: clans[0].key,
      team: clans[0].label,
      profile: 'average',
      at: gameEnd + 60_000,
      intent: `${latecomer.name}: bips after the end`,
      card: { ...card0(latecomer.chipId), punches: [{ code: territories[0]?.balises[0] ?? 31, time: hms(gameEnd + 30_000) }] },
    });
  }
  if (purgeOn && !purger) warnings.push('The Purge is on but no clan has a player: nobody tries it.');
  return { reads, tracks, purgeAt, warnings };
}
