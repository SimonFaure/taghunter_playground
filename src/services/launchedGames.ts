// Service file for the launched-games / multiplayer-state surface.
//
// All functions wrap apiCall against the new launched_games.php endpoints.
// Writes go through withRetry (3 attempts, exp backoff) for transient blips;
// reads do too. Server-of-truth for everything: no local SQLite mirror.
//
// Per-client scoping is enforced server-side via the JWT - no need to pass
// client_id in any request body. device_id for record_punch / register_device
// is sourced from the authenticated token on the server, never trusted from
// the client.

import { apiCall } from './api';
import { withRetry } from './apiRetry';
import { captureGameSummary, type GameSummaryPayload } from './telemetry';
import type { ScreenState } from './screenState';

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
  /** True when launched with testMode - excluded from statistics; deletable. */
  is_test?: boolean;
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
  /** Per-team display language (2-letter ISO). null ⇒ use the launch language. */
  language: string | null;
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
    language?: string | null;
  }>;
  // Optional client-supplied UUID. Required to make retries safe - without it
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

export async function listLaunchedGames(
  filter?: { ended?: boolean; forceLocal?: boolean; mine?: boolean },
): Promise<LaunchedGameRow[]> {
  const query: Record<string, string> = {};
  if (filter?.ended === true) query.ended = '1';
  if (filter?.ended === false) query.ended = '0';
  // mine=1 restricts to games this device launched or participates in - used by
  // the "Cet appareil" section so it never surfaces games merely hosted here for
  // other satellites (a former-mother's local rows).
  if (filter?.mine) query.mine = '1';
  const res = await withRetry(() =>
    apiCall<{ games: LaunchedGameRow[] }>('launched_games', 'list', {
      method: 'GET',
      bearer: true,
      query,
      forceLocal: filter?.forceLocal,
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

// `update_meta` REPLACES the whole KV map atomically (DELETE-then-insert on the
// server), so adding or removing a single key means read-merge-write. These two
// helpers wrap that gotcha once. They are last-writer-wins: only call them from
// the single kiosk that owns a game's loop - never fan per-team writes across
// satellites.
export async function mergeLaunchedGameMeta(
  id: number,
  patch: Record<string, string>
): Promise<void> {
  const current = await getLaunchedGameMeta(id);
  await updateLaunchedGameMeta(id, { ...current, ...patch });
}

// Atomic per-key upsert - the server touches only the keys in `patch` and
// leaves the rest of the map alone, so this IS safe to call concurrently from
// several devices (unlike mergeLaunchedGameMeta above). Use it for any write
// that fans out across satellites: self-register's per-chip keys, per-team
// overrides, anything keyed by a thing a station owns. A null value deletes.
//
// Falls back to the read-merge-write path when the route is an older mother
// that predates the `merge_meta` action, so a mixed-version LAN still works -
// it just reopens the lost-update window on that older mother.
export async function patchLaunchedGameMeta(
  id: number,
  patch: Record<string, string | null>
): Promise<void> {
  try {
    await withRetry(() =>
      apiCall('launched_games', 'merge_meta', {
        method: 'POST',
        bearer: true,
        body: { id, meta: patch },
      })
    );
  } catch (err) {
    console.warn('[launchedGames] merge_meta unavailable, falling back to read-merge-write:', err);
    const current = await getLaunchedGameMeta(id);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete current[k];
      else current[k] = v;
    }
    await updateLaunchedGameMeta(id, current);
  }
}

export async function removeLaunchedGameMetaKeys(id: number, keys: string[]): Promise<void> {
  const current = await getLaunchedGameMeta(id);
  let changed = false;
  for (const k of keys) {
    if (k in current) {
      delete current[k];
      changed = true;
    }
  }
  if (changed) await updateLaunchedGameMeta(id, current);
}

// State endpoint - the 1s poll target. Returns ended flag, current teams, and
// any raw_data rows newer than `sinceRawId`.
export async function getLaunchedGameState(id: number, sinceRawId: number): Promise<LaunchedGameStatePayload> {
  // No retry on the state poll itself - we run it once per second; if it
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
  fields: { score?: number; team_name?: string | null; start_time?: number | null; end_time?: number | null; language?: string | null }
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

// Remove a team from a launched game (and its completed-quest rows). Used by
// the operator's "Remove team" action in the launched-games list.
export async function deleteTeam(teamId: number): Promise<void> {
  await withRetry(() =>
    apiCall('launched_games', 'delete_team', {
      method: 'POST',
      bearer: true,
      body: { team_id: teamId },
    })
  );
}

export async function addTeamToLaunchedGame(input: {
  launched_game_id: number;
  team_number: number;
  team_name?: string | null;
  pattern?: number;
  key_id?: number | null;
  language?: string | null;
  // When true and the launch enabled a name pool, the server replaces the
  // provided team_name with a drawn pooled name (server-side for uniqueness).
  // team_name is kept as the fallback if the pool is empty/exhausted.
  draw_from_pool?: boolean;
}): Promise<{ id: number }> {
  return withRetry(() =>
    apiCall<{ id: number }>('launched_games', 'add_team', {
      method: 'POST',
      bearer: true,
      body: input,
    })
  );
}

// Record the game's start timestamp once (idempotent server-side). Pass an
// ISO-8601 UTC string (e.g. new Date(ms).toISOString()). Returns the effective
// start_time - the first writer wins, so re-entry never resets the clock.
export async function startLaunchedGame(id: number, startTime: string): Promise<{ start_time: string | null }> {
  return withRetry(() =>
    apiCall<{ start_time: string | null }>('launched_games', 'start_game', {
      method: 'POST',
      bearer: true,
      body: { id, start_time: startTime },
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
  // A just-ended game is eligible for summarising; push it up promptly
  // (best-effort - the periodic sync is the safety net).
  void syncGameSummaries();
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

// Extend a running game by N minutes (operator "add time"). Bumps the server
// duration - the source of truth every station's timer reads via the poll.
export async function addLaunchedGameTime(id: number, minutes: number): Promise<{ duration: number }> {
  return withRetry(() =>
    apiCall<{ duration: number }>('launched_games', 'add_time', {
      method: 'POST',
      bearer: true,
      body: { id, minutes },
    })
  );
}

// ---------- game-summary statistics + Archive ----------

export interface GameSummaryRow extends GameSummaryPayload {
  archived_at?: string | null;
  pushed?: boolean;
}

/**
 * Archive a launched game: the mother finalises its summary (kept forever in
 * lg_game_summaries) and deletes the heavy lg_* rows. Then push the summary up.
 */
export async function archiveLaunchedGame(
  id: number
): Promise<{ success: boolean; summary_kept: boolean }> {
  const res = await withRetry(() =>
    apiCall<{ success: boolean; summary_kept: boolean }>('launched_games', 'archive_game', {
      method: 'POST',
      bearer: true,
      body: { id },
    })
  );
  void syncGameSummaries();
  return res;
}

/** The local Archived-games view: every archived summary, newest first. */
export async function listArchivedSummaries(): Promise<GameSummaryRow[]> {
  const res = await withRetry(() =>
    apiCall<{ summaries: GameSummaryRow[] }>('launched_games', 'list_archived_summaries', {
      method: 'GET',
      bearer: true,
    })
  );
  return res.summaries ?? [];
}

let summarySyncInFlight = false;

/**
 * Push pending per-game statistics to studio. Asks the local mother to auto-end
 * stale (>24h) games and recompute summaries, then enqueues a game_summary
 * telemetry event for each summary still awaiting a push and marks them pushed.
 * Best-effort and self-healing: a crash mid-flight just re-pushes next cycle
 * (studio upserts on summary_uuid). No-op when there is no mother / no auth.
 */
export async function syncGameSummaries(): Promise<void> {
  if (summarySyncInFlight) return;
  summarySyncInFlight = true;
  try {
    const res = await apiCall<{ summaries: GameSummaryPayload[] }>(
      'launched_games',
      'sync_summaries',
      { method: 'POST', bearer: true }
    );
    const summaries = res.summaries ?? [];
    if (summaries.length === 0) return;
    for (const s of summaries) {
      await captureGameSummary(s);
    }
    await apiCall('launched_games', 'mark_summaries_pushed', {
      method: 'POST',
      bearer: true,
      body: { summary_uuids: summaries.map((s) => s.summary_uuid) },
    });
  } catch (err) {
    console.warn('[summaries] syncGameSummaries skipped:', err);
  } finally {
    summarySyncInFlight = false;
  }
}

let summaryTimer: ReturnType<typeof setInterval> | null = null;
const SUMMARY_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 min, matching the drainer

/** Start the periodic game-summary sync (boot + every 5 min). Idempotent. */
export function startSummarySync(): void {
  if (summaryTimer !== null) return;
  summaryTimer = setInterval(() => {
    void syncGameSummaries();
  }, SUMMARY_SYNC_INTERVAL_MS);
  void syncGameSummaries();
}

export function stopSummarySync(): void {
  if (summaryTimer !== null) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
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

// paired_devices.id of every device currently participating in an active
// launched game. A device runs at most ONE game at a time, so these are
// off-limits when picking devices for a new launch (the launching/host device
// can still dispatch more games - that's a separate concern from participating).
// Aggregated client-side across active games; best-effort (a game whose device
// list fails to load is skipped rather than blocking the launch).
export async function listBusyDeviceIds(): Promise<Set<number>> {
  const busy = new Set<number>();
  try {
    const games = await listActiveLaunchedGames();
    const lists = await Promise.all(
      games.map((g) => getLaunchedGameDevices(g.id).catch(() => [] as LaunchedGameDeviceRow[]))
    );
    for (const devices of lists) {
      for (const d of devices) {
        if (typeof d.device_id === 'number') busy.add(d.device_id);
      }
    }
  } catch (err) {
    console.error('[launchedGames] listBusyDeviceIds failed:', err);
  }
  return busy;
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
  // The peer's self-reported current screen (what it's showing right now), or
  // null when it hasn't reported one yet (e.g. an older app build). Only render
  // a pill for online rows - see GameDevicesModal. The self row uses the local
  // screenState store instead (the mother never pings itself).
  screen_state?: ScreenState | null;
}

export interface ListPairedWithStatusResp {
  in_game: PairedDeviceStatusRow[];
  available_online: PairedDeviceStatusRow[];
  offline: PairedDeviceStatusRow[];
  // paired_devices.id of the CALLER, resolved server-side from the bearer
  // secret. Not the same as the `is_self` row: these lists come from whichever
  // device owns the DB (the mother), so `is_self` marks the MOTHER's row no
  // matter who asked. Anything answering "which device am I?" must use this.
  // Optional only for compatibility with an older mother build.
  caller_device_id?: number;
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
  kind: 'join_game' | 'play_video' | 'stop_video' | 'open_ranking' | 'show_team_summary' | 'disconnect_device' | 'become_mother' | 'reload_config',
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
  launchedGameId: number,
  // `rejoin` re-pushes the navigate-to-game command to devices ALREADY in the
  // game (the Devices-modal "Reconnect" action), bypassing the server's
  // already-in-game guard. Omit it for "Launch here" on available devices.
  opts?: { rejoin?: boolean }
): Promise<QueueCommandBulkResp> {
  const payload: Record<string, unknown> = { launched_game_id: launchedGameId };
  if (opts?.rejoin) payload.rejoin = true;
  return queueCommandBulk(targets, 'join_game', payload);
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

// Remove device(s) from a launched game: the mother drops their participation
// row (so they leave bucket A → become available again) and pushes a command
// telling each satellite to leave the in-game page and return to the
// launched-games list. Delivery is via /ping.php pickup (latency up to one
// ping cycle, ~10s); the registration removal is immediate on the mother.
export async function queueDisconnectDeviceBulk(
  targets: number[],
  launchedGameId: number
): Promise<QueueCommandBulkResp> {
  return queueCommandBulk(targets, 'disconnect_device', { launched_game_id: launchedGameId });
}

// Tell paired device(s) to open a ranking page (single launched game, or a
// scenario's cross-game leaderboard over a time range). The target descriptor
// is carried verbatim in the payload; in game mode it includes
// `launched_game_id` so the mother can validate ownership.
export async function queueOpenRankingPageBulk(
  targets: number[],
  payload: Record<string, unknown>
): Promise<QueueCommandBulkResp> {
  return queueCommandBulk(targets, 'open_ranking', payload);
}

// Tell paired device(s) to show a finished team's final summary. The payload is
// a self-contained TeamSummarySnapshot (encodeTeamSummarySnapshot); it includes
// `launched_game_id` so the mother can validate ownership.
export async function queueShowTeamSummaryBulk(
  targets: number[],
  payload: Record<string, unknown>
): Promise<QueueCommandBulkResp> {
  return queueCommandBulk(targets, 'show_team_summary', payload);
}

// Tell in-game device(s) to re-derive their running game page's config from the
// freshly-saved launched-game meta, so a config edit made on one device applies
// live everywhere. Same in-game-target validation as play_video.
export async function queueReloadConfigBulk(
  targets: number[],
  launchedGameId: number
): Promise<QueueCommandBulkResp> {
  return queueCommandBulk(targets, 'reload_config', { launched_game_id: launchedGameId });
}

// Push a reload_config command to every OTHER device currently in the game, so a
// config edit propagates to their running game page. Best-effort: enumerates the
// in-game bucket (excluding self) and fans out; swallows errors so a failed push
// never blocks the local save. Offline in-game devices still get a queued command
// (delivered when they next ping, within the mother's command TTL).
export async function broadcastConfigReload(launchedGameId: number): Promise<void> {
  try {
    const buckets = await listPairedWithStatus(launchedGameId);
    const targets = buckets.in_game.filter((r) => !r.is_self).map((r) => r.id);
    if (targets.length === 0) return;
    await queueReloadConfigBulk(targets, launchedGameId);
  } catch (err) {
    console.error('[launchedGames] broadcastConfigReload failed:', err);
  }
}

// Planned handover: tell a paired device to take over as the mother for this
// game. The target adopts its latest cached snapshot and promotes (epoch+1);
// the current mother then yields. Delivery is via /ping.php pickup.
export async function queueBecomeMotherCommand(
  targetDeviceId: number,
  launchedGameId: number
): Promise<QueueCommandBulkResp> {
  return queueCommandBulk([targetDeviceId], 'become_mother', {
    launched_game_id: launchedGameId,
  });
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

// Removes the most-recent completion row for (team, quest_number). Used by the
// operator's manual quest-count adjustment in the Team Details modal.
export async function deleteCompletedQuest(input: {
  launched_game_id: number;
  team_id: number;
  quest_number: string;
}): Promise<{ deleted: boolean }> {
  return withRetry(() =>
    apiCall<{ deleted: boolean }>('launched_games', 'delete_completed_quest', {
      method: 'POST',
      bearer: true,
      body: input,
    })
  );
}
