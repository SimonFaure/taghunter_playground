// cards_state row + cross-system orchestration for the card registry.
//
// The actual card rows live in the `cards` table — read/written via
// services/cardsRepo.ts. This module owns the *sync metadata* in
// `cards_state` (remote_version, local_version, on-demand flag, retry
// counters) plus the high-level operations (pull JSON from studio, push
// pending mutations, "do we need to pull").
//
// History: this file used to manage a per-version CSV file on disk
// (cards/v{N}.csv) that the game engine parsed at launch. After Unit 4 the
// CSV path is gone — `pullCardsFromServer` now upserts JSON rows via
// `cardsRepo.applyServerPull`. A thin `getCardsCsvText` shim remains for
// LaunchGameModal's CSV parser; Unit 6 deletes that shim alongside its
// caller.

import { exists, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { onDemandCardsFileRel } from './contentFs';
import { getDb } from './db';
import * as cardsRepo from './cardsRepo';
import { apiCall, ApiError } from './api';

export interface CardsStateRow {
  client_id: number;
  remote_version: number | null;
  local_version: number | null;
  has_on_demand_cards: boolean;
  on_demand_fetched_at: string | null;
  failed_attempts: number;
}

function rowOut(row: Omit<CardsStateRow, 'has_on_demand_cards'> & { has_on_demand_cards: number }): CardsStateRow {
  return { ...row, has_on_demand_cards: Boolean(row.has_on_demand_cards) };
}

export async function get(clientId: number): Promise<CardsStateRow | null> {
  const db = await getDb();
  const rows = await db.select<Parameters<typeof rowOut>[0][]>(
    'SELECT * FROM cards_state WHERE client_id = $1',
    [clientId]
  );
  return rows.length ? rowOut(rows[0]) : null;
}

// Update from manifest: set remote_version + has_on_demand_cards. Preserves
// local_version. Creates the row on first sight.
export async function upsertFromManifest(
  clientId: number,
  payload: { cards_version: number | null; has_on_demand_cards: boolean }
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO cards_state (
       client_id, remote_version, local_version, has_on_demand_cards,
       on_demand_fetched_at, failed_attempts
     ) VALUES ($1, $2, NULL, $3, NULL, 0)
     ON CONFLICT(client_id) DO UPDATE SET
       remote_version = excluded.remote_version,
       has_on_demand_cards = excluded.has_on_demand_cards`,
    [clientId, payload.cards_version, payload.has_on_demand_cards ? 1 : 0]
  );
}

export async function markCardsDownloaded(clientId: number, version: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE cards_state SET local_version = $1, failed_attempts = 0 WHERE client_id = $2',
    [version, clientId]
  );
}

export async function markOnDemandFetched(clientId: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE cards_state SET on_demand_fetched_at = $1 WHERE client_id = $2',
    [new Date().toISOString(), clientId]
  );
}

export async function incrementFailedAttempts(clientId: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE cards_state SET failed_attempts = failed_attempts + 1 WHERE client_id = $1',
    [clientId]
  );
}

export async function getOnDemandCardsJson(): Promise<unknown | null> {
  const rel = onDemandCardsFileRel();
  if (!(await exists(rel, { baseDir: BaseDirectory.AppData }))) return null;
  const text = await readTextFile(rel, { baseDir: BaseDirectory.AppData });
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Whether a pull is needed: studio's reported remote_version differs from
// what we last persisted. Equality is exact (DECIMAL ↔ float round-trips
// cleanly for our N.00/N.01 values).
export async function needsCardsDownload(clientId: number): Promise<boolean> {
  const row = await get(clientId);
  if (!row || row.remote_version === null) return false;
  return row.local_version === null || row.local_version !== row.remote_version;
}

export async function hasOnDemandCards(clientId: number): Promise<boolean> {
  const row = await get(clientId);
  return Boolean(row?.has_on_demand_cards);
}

// ---------------------------------------------------------------------------
// Pull JSON from studio and reconcile into the local cards table.
// ---------------------------------------------------------------------------

interface GetCardsResponse {
  cards: cardsRepo.CardRow[];
  version: number;
}

export async function pullCardsFromServer(clientId: number, signal?: AbortSignal): Promise<void> {
  const res = await apiCall<GetCardsResponse>('playground', 'get_cards', {
    method: 'GET',
    bearer: true,
    signal,
  });
  await cardsRepo.applyServerPull(res.cards);
  await markCardsDownloaded(clientId, res.version);
}

// ---------------------------------------------------------------------------
// Push pending local mutations to studio. Returns counts for the
// orchestrator's stats. Conflict (409) handling per the plan:
//   - error_code 'card_id_exists' or 'key_number_taken' on a pending create
//     → re-fetch authoritative state from studio and accept the overwrite,
//       letting the operator know via syncEvents.
// ---------------------------------------------------------------------------

export interface PushResult {
  pushed: number;
  conflicts: number;
  failed: number;
}

// Cheap pre-check used by the orchestrator to decide whether to surface a
// "Pushing local changes" phase in the UI. Avoids emitting a phase boundary
// for the common no-op case where the cycle has no outgoing card edits.
export async function hasPendingMutations(): Promise<boolean> {
  const pending = await cardsRepo.listPending();
  return pending.length > 0;
}

export async function pushPendingMutations(): Promise<PushResult> {
  const pending = await cardsRepo.listPending();
  let pushed = 0;
  let conflicts = 0;
  let failed = 0;

  for (const item of pending) {
    try {
      if (item.operation === 'create') {
        await apiCall('cards', 'create_card', {
          method: 'POST',
          bearer: true,
          body: {
            id: item.id,
            key_number: item.key_number,
            key_name: item.key_name,
            color: item.color,
          },
        });
        await cardsRepo.markSynced(item.id, 'create');
        pushed += 1;
      } else if (item.operation === 'update') {
        await apiCall('cards', 'update_card', {
          method: 'PUT',
          bearer: true,
          body: {
            id: item.id,
            key_number: item.key_number,
            key_name: item.key_name,
            color: item.color,
          },
        });
        await cardsRepo.markSynced(item.id, 'update');
        pushed += 1;
      } else if (item.operation === 'delete') {
        await apiCall('cards', 'delete_card', {
          method: 'DELETE',
          bearer: true,
          query: { id: item.id },
        });
        await cardsRepo.markSynced(item.id, 'delete');
        pushed += 1;
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        conflicts += 1;
        // Surface the conflict and let the next pull cycle bring the
        // authoritative row in. We don't fetch + acceptServerOverwrite
        // inline here because the very next step in the orchestrator is
        // the manifest fetch + cards pull, which reconciles everything.
        // Leave the row 'pending' so the user sees the conflict in the UI
        // (the surface will be enhanced in Unit 6).
        // For now: pull a single canonical row and accept-overwrite so
        // the local data stops being a lie.
        const body = err.body as { error_code?: string } | null;
        if (body?.error_code === 'card_id_exists') {
          await reconcileSingleCard(item.id);
        }
      } else if (err instanceof ApiError && err.status === 401) {
        throw err;
      } else {
        failed += 1;
      }
    }
  }

  return { pushed, conflicts, failed };
}

// Helper for 409 'card_id_exists' resolution: re-pull a single card by
// looking it up in the next list (cheap; cards lists are small).
async function reconcileSingleCard(id: number): Promise<void> {
  try {
    const res = await apiCall<GetCardsResponse>('playground', 'get_cards', {
      method: 'GET',
      bearer: true,
    });
    const server = res.cards.find((c) => c.id === id);
    if (server) {
      await cardsRepo.acceptServerOverwrite(server);
    }
  } catch {
    /* swallow — next cycle will retry */
  }
}

