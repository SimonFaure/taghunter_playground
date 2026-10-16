// Licensee "Report a problem" (launched-games page, next to Raw Data).
//
// Builds a snapshot of the game as seen from THIS device - teams, raw punches,
// game config, devices, plus this device's recent console warnings/errors - and
// queues it with the licensee's comment in the telemetry outbox as a
// `bug_report` event, then pushes the outbox at once. Offline, the report waits
// in the outbox and goes out with the next drain.
//
// Game reads go through launched_games, which routes to the mother during a LAN
// game, so a child reports the same data the mother holds. If the game can't be
// read (mother unreachable) the comment is still sent, with `snapshot_error`.
//
// Studio side: telemetry.php ingestBugReport → Studio > Bug reports.
// Design: project_bug_report_button.

import {
  getLaunchedGameState,
  getLaunchedGameMeta,
  getLaunchedGameDevices,
  type LaunchedGameRow,
  type LaunchedGameStatePayload,
  type TeamRow,
} from './launchedGames';
import { getLanOverride, getLocalLaunchedGamesRoute } from './api';
import * as scenarioStore from './scenarioStore';
import { getDeviceMetadata } from './device';
import { isOperatorOnly } from './operatorMode';
import { getConsoleLines } from './consoleBuffer';
import { captureBugReport, drainNow, isEventPending } from './telemetry';
import { dbDate } from '../utils/dbTime';

export const BUG_REPORT_MIN_COMMENT = 10;
export const BUG_REPORT_MAX_COMMENT = 5000;

/** Newest punches kept in a snapshot. */
const MAX_PUNCHES = 5000;
/** Kept under the studio's 1 MiB request cap with room for the envelope. */
const MAX_REPORT_BYTES = 900_000;

export type DeviceRole = 'mother' | 'child' | 'standalone';

/** The launched-games page keeps a slimmer row than LaunchedGameRow. */
export type BugReportGame = Pick<LaunchedGameRow, 'id' | 'game_uniqid' | 'name' | 'game_type'> &
  Partial<Omit<LaunchedGameRow, 'id' | 'game_uniqid' | 'name' | 'game_type'>>;

export interface BugReportInput {
  game: BugReportGame;
  /** Game state already loaded by the modal (for the team picker), if any. */
  state: LaunchedGameStatePayload | null;
  /** Why the state could not be loaded, when it couldn't. */
  stateError: string | null;
  isChildView: boolean;
  comment: string;
  teamsConcerned: TeamRow[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function isoOrNull(ts: string | null | undefined): string | null {
  return dbDate(ts)?.toISOString() ?? null;
}

function deviceRole(isChildView: boolean): DeviceRole {
  if (isChildView) return 'child';
  return getLanOverride() ? 'mother' : 'standalone';
}

/** The game's teams + raw punches. Never throws. */
export async function loadGameState(
  launchedGameId: number,
): Promise<{ state: LaunchedGameStatePayload | null; error: string | null }> {
  try {
    return { state: await getLaunchedGameState(launchedGameId, 0), error: null };
  } catch (err) {
    return { state: null, error: errorText(err) };
  }
}

async function buildSnapshot(
  input: BugReportInput,
  state: LaunchedGameStatePayload,
): Promise<{ snapshot: Record<string, unknown>; truncated: boolean }> {
  const { game, isChildView } = input;

  const [meta, devices, scenario, device, operatorOnly] = await Promise.all([
    getLaunchedGameMeta(game.id).then(
      (m) => ({ meta: m, error: null as string | null }),
      (err) => ({ meta: null, error: errorText(err) }),
    ),
    getLaunchedGameDevices(game.id).catch(() => null),
    scenarioStore.get(game.game_uniqid).catch(() => null),
    getDeviceMetadata().catch(() => null),
    isOperatorOnly(),
  ]);

  const allPunches = [...(state.new_raw_data ?? [])].sort((a, b) => b.id - a.id);
  const punches = allPunches.slice(0, MAX_PUNCHES);

  const snapshot: Record<string, unknown> = {
    schema: 1,
    captured_at: new Date().toISOString(),
    game: {
      id: game.id,
      name: state.name ?? game.name,
      game_type: state.game_type ?? game.game_type,
      game_uniqid: game.game_uniqid,
      summary_uuid: game.summary_uuid ?? null,
      duration: state.duration ?? game.duration,
      created_at: game.created_at ?? null,
      start_time: state.start_time ?? game.start_time ?? null,
      started: state.started,
      ended: state.ended,
      is_test: game.is_test ?? false,
      is_simulated: game.is_simulated ?? false,
      number_of_teams: game.number_of_teams ?? null,
    },
    scenario: scenario
      ? {
          uniqid: scenario.uniqid,
          title: scenario.title,
          local_version: scenario.local_version,
          remote_version: scenario.remote_version,
          local_content_hash: scenario.local_content_hash,
          remote_content_hash: scenario.remote_content_hash,
        }
      : null,
    meta: meta.meta,
    ...(meta.error ? { meta_error: meta.error } : {}),
    teams: state.teams ?? [],
    raw_punches: punches,
    raw_punch_total: allPunches.length,
    devices,
    device: {
      device_uniq: device?.device_uniq ?? null,
      device_label: device?.device_label ?? null,
      os: device?.os ?? null,
      os_version: device?.os_version ?? null,
      app_version: device?.app_version ?? null,
      role: deviceRole(isChildView),
      operator_only: operatorOnly,
      // Addresses only - never the LAN bearer tokens.
      launched_games_route: getLanOverride()?.baseUrl ?? null,
      local_server: getLocalLaunchedGamesRoute()?.baseUrl ?? null,
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    },
    console_log: getConsoleLines(),
  };

  return { snapshot, truncated: punches.length < allPunches.length };
}

/**
 * Queue the report and try to deliver it now. Resolves 'sent' when studio
 * acknowledged it, 'queued' when it is saved and will go out once online.
 * Throws only if the report could not even be saved locally.
 */
export async function sendBugReport(input: BugReportInput): Promise<'sent' | 'queued'> {
  const { game } = input;
  const comment = input.comment.trim().slice(0, BUG_REPORT_MAX_COMMENT);

  // Re-read so the latest punches are in; fall back to what the modal loaded.
  const fresh = await loadGameState(game.id);
  const state = fresh.state ?? input.state;
  const stateError = state ? null : (fresh.error ?? input.stateError ?? 'Game state unavailable');

  const device = await getDeviceMetadata().catch(() => null);

  const payload: Record<string, unknown> = {
    comment,
    teams_concerned: input.teamsConcerned.map((t) => ({
      id: t.id,
      team_number: t.team_number,
      team_name: t.team_name,
    })),
    launched_game_id: game.id,
    game_name: state?.name ?? game.name,
    game_type: state?.game_type ?? game.game_type,
    scenario_uniqid: game.game_uniqid,
    summary_uuid: game.summary_uuid ?? null,
    game_started_at: isoOrNull(state?.start_time ?? game.start_time ?? game.created_at),
    device_role: deviceRole(input.isChildView),
    app_version: device?.app_version ?? null,
    snapshot: null,
    snapshot_error: stateError,
    snapshot_truncated: false,
  };

  if (state) {
    try {
      const { snapshot, truncated } = await buildSnapshot(input, state);
      payload.snapshot = snapshot;
      payload.snapshot_truncated = truncated;
      fitToSize(payload);
    } catch (err) {
      payload.snapshot = null;
      payload.snapshot_error = `Snapshot build failed: ${errorText(err)}`;
    }
  }

  const eventUuid = await captureBugReport(payload);
  await drainNow();
  const pending = await isEventPending(eventUuid).catch(() => true);
  return pending ? 'queued' : 'sent';
}

/**
 * Shrink the snapshot until the payload fits MAX_REPORT_BYTES: halve the
 * punches (newest kept), then trim the console log, then give up on the
 * snapshot but keep the comment.
 */
function fitToSize(payload: Record<string, unknown>): void {
  const snap = payload.snapshot as Record<string, unknown> & {
    raw_punches: unknown[];
    console_log: unknown[];
  };
  const size = () => byteLength(JSON.stringify(payload));

  while (size() > MAX_REPORT_BYTES && snap.raw_punches.length > 0) {
    snap.raw_punches = snap.raw_punches.slice(0, Math.floor(snap.raw_punches.length / 2));
    payload.snapshot_truncated = true;
  }
  if (size() > MAX_REPORT_BYTES) {
    snap.console_log = snap.console_log.slice(-50);
  }
  if (size() > MAX_REPORT_BYTES) {
    payload.snapshot = null;
    payload.snapshot_error = 'Snapshot too large even without punches';
  }
}
