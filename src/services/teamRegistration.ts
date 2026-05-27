// Dynamic team creation for auto-register / reuse-cards modes.
//
// When a card has no active run, the runtimes call ensureTeamForCard to create
// (and let the caller then start) a team. Registered-cards-only: the card must
// exist in the local `cards` table, otherwise we return null and the caller
// ignores the bip (unknown chip). `cards.id` == the SI card number, so the
// card's reader id resolves directly via cardsRepo.getById.

import * as cardsRepo from './cardsRepo';
import {
  addTeamToLaunchedGame,
  getLaunchedGameState,
  type LaunchedGameStatePayload,
  type TeamRow,
} from './launchedGames';

// Ensures a fresh active team exists for `cardId` and returns it. Returns null
// if the card isn't registered locally (caller should ignore/toast).
//
// `state` is the most recent state snapshot the caller already holds — used to
// derive the run index (for naming) and the next team_number without an extra
// round-trip. After creating, we re-read state so the returned row reflects the
// server's authoritative team (and survives multi-station dedup races, where a
// concurrent add_team on another reader already created the active team).
export async function ensureTeamForCard(
  launchedGameId: number,
  cardId: number,
  state: LaunchedGameStatePayload,
  preferPoolName = false,
): Promise<TeamRow | null> {
  const cardRow = await cardsRepo.getById(cardId);
  if (!cardRow) return null;

  const priorForCard = state.teams.filter((t) => t.key_id === cardId);
  const runN = priorForCard.length + 1;
  const name = runN === 1 ? cardRow.key_name : `${cardRow.key_name} (${runN})`;
  const teamNumber = state.teams.reduce((m, t) => Math.max(m, t.team_number), 0) + 1;

  // `name` is the key_name fallback; when a name pool is enabled the server
  // draws an unused pooled name instead (uniqueness is enforced server-side
  // so concurrent multi-station bips never collide). On exhaustion the server
  // keeps this fallback.
  const { id } = await addTeamToLaunchedGame({
    launched_game_id: launchedGameId,
    team_number: teamNumber,
    team_name: name,
    pattern: 0,
    key_id: cardId,
    draw_from_pool: preferPoolName,
  });

  const fresh = await getLaunchedGameState(launchedGameId, 0);
  return (
    fresh.teams.find((t) => t.id === id) ??
    fresh.teams.find((t) => t.key_id === cardId && t.end_time == null) ??
    null
  );
}
