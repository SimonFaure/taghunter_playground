// Service file for the launched-games / multiplayer-state surface.
//
// All functions wrap apiCall against the new launched_games.php endpoints.
// Writes go through withRetry (3 attempts, exp backoff) for transient blips;
// reads do too. Server-of-truth for everything: no local SQLite mirror.
//
// Per-client scoping is enforced server-side via the JWT — no need to pass
// client_id in any request body. device_id for record_punch / register_device
// is sourced from the authenticated token on the server, never trusted from
// the client.

import { apiCall } from './api';
import { withRetry } from './apiRetry';

// ---------- types ----------

export interface LaunchedGameRow {
  id: number;
  game_uniqid: string;
  name: string;
  number_of_teams?: number;
  game_type: string;
  duration: number;
  start_time?: string | null;
  started?: number | boolean;
  ended?: number | boolean;
  created_at?: string;
  updated_at?: string;
}

export interface TeamRow {
  id: number;
  team_number: number;
  team_name: string | null;
  pattern: number;
  score: number;
  key_id: number | null;
  start_time: number | null;
  end_time: number | null;
}

export interface RawPunchRow {
  id: number;
  device_id: number;
  raw_data: unknown;
  created_at: string;
}

export interface LaunchedGameStatePayload {
  id: number;
  name: string;
  game_uniqid: string;
  game_type: string;
  duration: number;
  start_time: string | null;
  ended: boolean;
  started: boolean;
  teams: TeamRow[];
  new_raw_data: RawPunchRow[];
  last_raw_id: number;
}

export interface LaunchedGameDeviceRow {
  id: number;
  device_id: number;
  connected: number | boolean;
  last_connection_attempt: string;
  device_label: string | null;
  os: string | null;
  os_version: string | null;
}

export interface CreateLaunchedGameInput {
  game_uniqid: string;
  name: string;
  number_of_teams: number;
  game_type: string;
  duration: number;
  started?: boolean;
  meta: Record<string, string | number | boolean | null | undefined>;
  teams: Array<{
    team_number: number;
    team_name?: string | null;
    pattern: number;
    key_id?: number | null;
  }>;
  // Optional client-supplied UUID. Required to make retries safe — without it
  // a withRetry-driven second attempt after a slow/5xx first attempt would
  // create a duplicate row. Callers that don't pass one get a fresh UUID per
  // call, which only helps if the entire call (incl. all retries) shares it.
  idempotency_key?: string;
  // When false, the mother (the calling peer) is NOT auto-inserted into
  // lg_launched_game_devices. Lets the operator launch a game where the
  // mother just hosts the server but doesn't participate as a scanning
  // station. Default true.
  include_self?: boolean;
}

// ---------- public API ----------

export async function createLaunchedGame(input: CreateLaunchedGameInput): Promise<{ id: number; device_row_id: number | null; idempotent_replay?: boolean }> {
  // Stringify any non-string meta values so the server stores them as TEXT.
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.meta)) {
    if (v === undefined || v === null) continue;
    meta[k] = typeof v === 'string' ? v : String(v);
  }
  // Pin one key for the whole create operation. withRetry may fire up to 4
  // attempts; they must all carry the same key so the server can dedupe.
  const idempotencyKey = input.idempotency_key ?? crypto.randomUUID();
  return withRetry(() =>
    apiCall<{ id: number; device_row_id: number | null; idempotent_replay?: boolean }>('launched_games', 'create', {
      method: 'POST',
      bearer: true,
      body: { ...input, meta, started: input.started ? 1 : 0, idempotency_key: idempotencyKey },
    })
  );
}

export async function listLaunchedGames(filter?: { ended?: boolean }): Promise<LaunchedGameRow[]> {
  const query: Record<string, string> = {};
  if (filter?.ended === true) query.ended = '1';
  if (filter?.ended === false) query.ended = '0';
  const res = await withRetry(() =>
    apiCall<{ games: LaunchedGameRow[] }>('launched_games', 'list', {
      method: 'GET',
      bearer: true,
      query,
    })
  );
  return res.games;
}

export async function listActiveLaunchedGames(): Promise<LaunchedGameRow[]> {
  const res = await withRetry(() =>
    apiCall<{ games: LaunchedGameRow[] }>('launched_games', 'list_active', {
      method: 'GET',
      bearer: true,
    })
  );
  return res.games;
}

export async function getLaunchedGameMeta(id: number): Promise<Record<string, string>> {
  const res = await withRetry(() =>
    apiCall<{ meta: Record<string, string> }>('launched_games', 'get_meta', {
      method: 'GET',
      bearer: true,
      query: { id },
    })
  );
  return res.meta ?? {};
}

export async function updateLaunchedGameMeta(id: number, meta: Record<string, string>): Promise<void> {
  await withRetry(() =>
    apiCall('launched_games', 'update_meta', {
      method: 'POST',
      bearer: true,
      body: { id, meta },
    })
  );
}

// State endpoint — the 1s poll target. Returns ended flag, current teams, and
// any raw_data rows newer than `sinceRawId`.
export async function getLaunchedGameState(id: number, sinceRawId: number): Promise<LaunchedGameStatePayload> {
  // No retry on the state poll itself — we run it once per second; if it
  // fails the next tick will re-fetch. Wrapping every poll in 21s of retries
  // would back up the queue.
  return apiCall<LaunchedGameStatePayload>('launched_games', 'state', {
    method: 'GET',
    bearer: true,
    query: { id, since_raw_id: sinceRawId },
  });
}

export async function getRawDataForChip(
  launchedGameId: number,
  chipId: number,
  limit = 2
): Promise<RawPunchRow[]> {
  const res = await withRetry(() =>
    apiCall<{ rows: RawPunchRow[] }>('launched_games', 'raw_data_for_chip', {
      method: 'GET',
      bearer: true,
      query: { launched_game_id: launchedGameId, chip_id: chipId, limit },
    })
  );
  return res.rows;
}

export async function recordPunch(launchedGameId: number, rawData: unknown): Promise<{ id: number }> {
  return withRetry(() =>
    apiCall<{ id: number }>('launched_games', 'record_punch', {
      method: 'POST',
      bearer: true,
      body: { launched_game_id: launchedGameId, raw_data: rawData },
    })
  );
}

// Partial-field team update. Pass any subset of fields you want to change.
export async function updateTeam(
  teamId: number,
  fields: { score?: number; team_name?: string | null; start_time?: number | null; end_time?: number | null }
): Promise<void> {
  await withRetry(() =>
    apiCall('launched_games', 'update_team', {
      method: 'POST',
      bearer: true,
      body: { team_id: teamId, ...fields },
    })
  );
}

export async function updateTeamScore(teamId: number, score: number): Promise<void> {
  return updateTeam(teamId, { score });
}

export async function endTeam(teamId: number, endTime: number): Promise<void> {
  return updateTeam(teamId, { end_time: endTime });
}

export async function addTeamToLaunchedGame(input: {
  launched_game_id: number;
  team_number: number;
  team_name?: string | null;
  pattern?: number;
  key_id?: number | null;
}): Promise<{ id: number }> {
  return withRetry(() =>
    apiCall<{ id: number }>('launched_games', 'add_team', {
      method: 'POST',
      bearer: true,
      body: input,
    })
  );
}

export async function endLaunchedGame(id: number): Promise<void> {
  await withRetry(() =>
    apiCall('launched_games', 'end_game', {
      method: 'POST',
      bearer: true,
      body: { id },
    })
  );
}

export async function deleteLaunchedGame(id: number): Promise<void> {
  await withRetry(() =>
    apiCall('launched_games', 'delete_game', {
      method: 'POST',
      bearer: true,
      body: { id },
    })
  );
}

export async function registerDeviceForGame(launchedGameId: number): Promise<void> {
  await withRetry(() =>
    apiCall('launched_games', 'register_device', {
      method: 'POST',
      bearer: true,
      body: { launched_game_id: launchedGameId },
    })
  );
}

export async function getLaunchedGameDevices(id: number): Promise<LaunchedGameDeviceRow[]> {
  const res = await withRetry(() =>
    apiCall<{ devices: LaunchedGameDeviceRow[] }>('launched_games', 'get_devices', {
      method: 'GET',
      bearer: true,
      query: { id },
    })
  );
  return res.devices;
}

// ---------- bucketed devices view + push-channel APIs ----------

// One row in the three-bucket Devices modal AND the launch wizard's step 3.
// Both surfaces share the shape so the modal can reuse the same row-renderer.
export interface PairedDeviceStatusRow {
  id: number; // paired_devices.id, used as device_id everywhere
  device_label: string;
  peer_os: string | null;
  is_self: boolean;
  has_reader: boolean;
  reader_last_seen_at: string | null;
  online: boolean;
  last_seen_at: string | null;
  // Non-null when the device is currently in the launched_game we asked
  // about; null in the launch-wizard's pre-create view.
  lgd_id: number | null;
}

export interface ListPairedWithStatusResp {
  in_game: PairedDeviceStatusRow[];
  available_online: PairedDeviceStatusRow[];
  offline: PairedDeviceStatusRow[];
}

export async function listPairedWithStatus(
  launchedGameId: number
): Promise<ListPairedWithStatusResp> {
  return withRetry(() =>
    apiCall<ListPairedWithStatusResp>('launched_games', 'list_paired_with_status', {
      method: 'GET',
      bearer: true,
      query: { launched_game_id: launchedGameId },
    })
  );
}

export async function listPairedDevicesForLaunch(): Promise<PairedDeviceStatusRow[]> {
  const res = await withRetry(() =>
    apiCall<{ devices: PairedDeviceStatusRow[] }>(
      'launched_games',
      'list_paired_for_launch',
      { method: 'GET', bearer: true }
    )
  );
  return res.devices;
}

export interface QueueCommandResult {
  target_device_id: number;
  command_id?: number;
  error?: string;
  status?: number;
}

export interface QueueCommandBulkResp {
  results: QueueCommandResult[];
}

async function queueCommandBulk(
  targets: number[],
  kind: 'join_game' | 'play_video' | 'stop_video',
  payload: Record<string, unknown>
): Promise<QueueCommandBulkResp> {
  return withRetry(() =>
    apiCall<QueueCommandBulkResp>('launched_games', 'queue_command_bulk', {
      method: 'POST',
      bearer: true,
      body: { targets, kind, payload },
    })
  );
}

export async function queueJoinGameCommandBulk(
  targets: number[],
  launchedGameId: number
): Promise<QueueCommandBulkResp> {
  return queueCommandBulk(targets, 'join_game', { launched_game_id: launchedGameId });
}

export async function queuePlayVideoBulk(
  targets: number[],
  launchedGameId: number,
  kinds: Array<'intro' | 'tutorial'>,
  language: string
): Promise<QueueCommandBulkResp> {
  return queueCommandBulk(targets, 'play_video', {
    launched_game_id: launchedGameId,
    kinds,
    language,
  });
}

export async function queueStopVideoBulk(
  targets: number[],
  launchedGameId: number
): Promise<QueueCommandBulkResp> {
  return queueCommandBulk(targets, 'stop_video', { launched_game_id: launchedGameId });
}

// ---------- team_completed_quests (tagquest scoring) ----------

export interface CompletedQuestRow {
  id: number;
  team_id: number;
  quest_number: string;
  points_awarded: number;
  teammate_chip_id: number | null;
  created_at: string;
}

export async function listCompletedQuests(
  launchedGameId: number,
  teamId?: number
): Promise<CompletedQuestRow[]> {
  const query: Record<string, number> = { launched_game_id: launchedGameId };
  if (teamId) query.team_id = teamId;
  const res = await withRetry(() =>
    apiCall<{ rows: CompletedQuestRow[] }>('launched_games', 'list_completed_quests', {
      method: 'GET',
      bearer: true,
      query,
    })
  );
  return res.rows;
}

export async function recordCompletedQuest(input: {
  launched_game_id: number;
  team_id: number;
  quest_number: string;
  points_awarded: number;
  teammate_chip_id?: number | null;
  allow_duplicates?: boolean;
}): Promise<{ inserted: boolean; id: number }> {
  return withRetry(() =>
    apiCall<{ inserted: boolean; id: number }>('launched_games', 'record_completed_quest', {
      method: 'POST',
      bearer: true,
      body: input,
    })
  );
}
