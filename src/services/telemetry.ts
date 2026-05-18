// Playground → Studio telemetry pipeline.
//
// Sends three kinds of background-only events to Studio, all through a single
// SQLite outbox (`pending_writes`, migration 5):
//   - heartbeat: device id + name + OS + app version. Fires on cold start and
//     when app_version differs from the last sent value.
//   - error:     JS uncaught + unhandledrejection + Rust panics. Fingerprinted
//     so the same crash within a 5-min window collapses to one row.
//   - launch:    light per-game-launch stat (future feature; the wire shape
//     and outbox handling are wired now so the future call site is a one-liner).
//
// Delivery is invisible and non-blocking: enqueue is synchronous from the
// caller's perspective (SQLite write), the drainer runs on a 5-min interval
// AND on app boot. Devices that stay offline for months are fine — there's
// no TTL; the local outbox is FIFO-capped at MAX_QUEUE_ROWS.
//
// Idempotency: every row carries a UUIDv4 event_uuid generated at enqueue.
// Studio upserts on it, so a mid-response network drop that the client
// retries doesn't produce duplicates.

import type Database from '@tauri-apps/plugin-sql';
import { getDb } from './db';
import { invoke } from '@tauri-apps/api/core';
import { apiCall, ApiError } from './api';
import { loadJwt } from './strongholdStore';
import { getDeviceMetadata } from './device';

// ─── tunables ────────────────────────────────────────────────────────────────

const BATCH_SIZE = 50;
const DRAIN_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const DEDUP_WINDOW_MS = 5 * 60 * 1000;   // 5 min
const MAX_QUEUE_ROWS = 5000;
const META_LAST_HEARTBEAT_VERSION = 'telemetry_last_heartbeat_app_version';

// ─── public surface ──────────────────────────────────────────────────────────

export type TelemetryEventType = 'heartbeat' | 'error' | 'launch';

export interface ErrorContext {
  /** Free-form structured context. JSON-serialized, scrubbed for PII. */
  [k: string]: unknown;
}

/**
 * Capture a JS error (caught or uncaught) into the outbox. Always swallows
 * its own failures — telemetry must never break the caller.
 */
export async function captureError(err: unknown, context?: ErrorContext): Promise<void> {
  try {
    const { message, stack } = extractError(err);
    const scrubbedMessage = scrubPii(message);
    const scrubbedStack = stack ? scrubPii(stack) : null;
    const fingerprint = await fingerprintError(scrubbedMessage, scrubbedStack);
    const meta = await getDeviceMetadata().catch(() => null);

    const payload = {
      fingerprint_hash: fingerprint,
      error_message: scrubbedMessage,
      stack_trace: scrubbedStack,
      app_version: meta?.app_version ?? null,
      context: context ? scrubContext(context) : null,
    };

    await enqueueErrorWithDedup(payload);
  } catch (innerErr) {
    // Telemetry is best-effort. Never propagate.
    console.warn('[telemetry] captureError failed:', innerErr);
  }
}

/**
 * Send a device heartbeat, but only if the app_version has changed since the
 * last heartbeat (or if no heartbeat was ever sent). Safe to call every boot.
 */
export async function sendHeartbeat(): Promise<void> {
  try {
    const meta = await getDeviceMetadata();
    const db = await getDb();

    const lastVersion = await readSchemaMeta(db, META_LAST_HEARTBEAT_VERSION);
    if (lastVersion === meta.app_version) {
      // Nothing changed. The server's last_seen_at gets bumped by every
      // authenticated request anyway (DeviceManager::bumpLastSeen).
      return;
    }

    await enqueue('heartbeat', {
      device_uniq: meta.device_uniq,
      device_label: meta.device_label,
      os: meta.os,
      os_version: meta.os_version,
      app_version: meta.app_version,
    });

    // Persist optimistically: if delivery fails we won't try again until the
    // next version change. Heartbeat data only matters when it shifts.
    await writeSchemaMeta(db, META_LAST_HEARTBEAT_VERSION, meta.app_version);
  } catch (err) {
    console.warn('[telemetry] sendHeartbeat failed:', err);
  }
}

/**
 * Enqueue a launch event. Reserved for the future game-launch stats feature.
 * Server is already accepting these and dedup'ing on event_uuid.
 */
export async function captureLaunch(launch: {
  scenario_uniqid?: string | null;
  duration_seconds?: number | null;
  teams_count?: number | null;
  started_at?: string | null;
  ended_at?: string | null;
}): Promise<void> {
  try {
    await enqueue('launch', launch);
  } catch (err) {
    console.warn('[telemetry] captureLaunch failed:', err);
  }
}

/**
 * Read and clear any pending Rust panic written by the panic hook on the
 * previous run, and enqueue it as a normal error event. Idempotent: the
 * native command deletes the file after reading.
 */
export async function recoverPendingPanic(): Promise<void> {
  try {
    interface PendingPanic {
      occurred_at: string;
      message: string;
      location: string | null;
      thread: string | null;
      app_version: string;
    }
    const record = await invoke<PendingPanic | null>('take_pending_panic');
    if (!record) return;

    const message = `Rust panic: ${record.message}`;
    const stack =
      [`at ${record.location ?? '<unknown>'}`, record.thread ? `thread: ${record.thread}` : null]
        .filter(Boolean)
        .join('\n');

    await captureError(new Error(message), {
      source: 'rust_panic',
      location: record.location ?? undefined,
      thread: record.thread ?? undefined,
      occurred_at: record.occurred_at,
      rust_app_version: record.app_version,
      stack_override: stack,
    });
  } catch (err) {
    console.warn('[telemetry] recoverPendingPanic failed:', err);
  }
}

let drainTimer: ReturnType<typeof setInterval> | null = null;
let drainInFlight = false;

/**
 * Start the periodic drainer. Idempotent: starting twice is a no-op. Kicks
 * off an immediate drain attempt so events queued before the timer's first
 * tick don't wait DRAIN_INTERVAL_MS.
 */
export function startDrainer(): void {
  if (drainTimer !== null) return;
  drainTimer = setInterval(() => {
    void drainOnce();
  }, DRAIN_INTERVAL_MS);
  void drainOnce();
}

export function stopDrainer(): void {
  if (drainTimer !== null) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
}

// ─── enqueue + dedup ─────────────────────────────────────────────────────────

interface ErrorPayload {
  fingerprint_hash: string;
  error_message: string;
  stack_trace: string | null;
  app_version: string | null;
  context: ErrorContext | null;
}

async function enqueueErrorWithDedup(payload: ErrorPayload): Promise<void> {
  const db = await getDb();
  const nowIso = new Date().toISOString();
  const windowCutoff = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();

  // Look for a pending error row with the same fingerprint inside the dedup
  // window. If we find one, increment its counter instead of inserting a new
  // row. This collapses error storms (same panic in a render loop) to a
  // single outbox row that the drainer ships with occurrence_count > 1.
  const existing = await db.select<Array<{ id: number; occurrence_count: number }>>(
    `SELECT id, occurrence_count FROM pending_writes
       WHERE event_type = 'error'
         AND payload_hash = $1
         AND (last_seen_at IS NULL OR last_seen_at > $2)
       ORDER BY id DESC
       LIMIT 1`,
    [payload.fingerprint_hash, windowCutoff]
  );

  if (existing.length > 0) {
    const row = existing[0];
    await db.execute(
      `UPDATE pending_writes
         SET occurrence_count = $1, last_seen_at = $2
       WHERE id = $3`,
      [row.occurrence_count + 1, nowIso, row.id]
    );
    return;
  }

  await enqueue('error', {
    ...payload,
    first_seen_at: nowIso,
    last_seen_at: nowIso,
    occurrence_count: 1,
  }, payload.fingerprint_hash);
}

/**
 * Insert a row in pending_writes. Generates event_uuid, applies the FIFO
 * cap, and stores the per-type payload as JSON in the existing body_json
 * column (the column predates this feature but its shape fits perfectly).
 */
async function enqueue(
  eventType: TelemetryEventType,
  payload: unknown,
  payloadHash: string | null = null
): Promise<void> {
  const db = await getDb();
  await enforceQueueCap(db);

  const eventUuid = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  // body_json carries the per-event-type payload. endpoint + method preserved
  // as descriptive labels in case anyone inspects the outbox by hand.
  await db.execute(
    `INSERT INTO pending_writes
       (endpoint, method, body_json, created_at, attempts,
        event_uuid, event_type, payload_hash,
        occurrence_count, first_seen_at, last_seen_at, occurred_at)
     VALUES
       ('telemetry', 'POST', $1, $2, 0,
        $3, $4, $5,
        1, $2, $2, $2)`,
    [JSON.stringify(payload), nowIso, eventUuid, eventType, payloadHash]
  );
}

async function enforceQueueCap(db: Database): Promise<void> {
  const rows = await db.select<Array<{ n: number }>>('SELECT COUNT(*) AS n FROM pending_writes');
  const count = rows[0]?.n ?? 0;
  if (count < MAX_QUEUE_ROWS) return;

  // Drop the oldest rows to make room. We over-trim by 50 so we don't run
  // this query on every insert when at the cap.
  const overflow = count - MAX_QUEUE_ROWS + 50;
  await db.execute(
    `DELETE FROM pending_writes
       WHERE id IN (SELECT id FROM pending_writes ORDER BY id ASC LIMIT $1)`,
    [overflow]
  );
}

// ─── drainer ─────────────────────────────────────────────────────────────────

interface PendingRow {
  id: number;
  event_uuid: string;
  event_type: TelemetryEventType;
  body_json: string;
  occurrence_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  occurred_at: string | null;
}

interface IngestResult {
  event_uuid: string;
  status: 'ok' | 'rejected';
}

async function drainOnce(): Promise<void> {
  if (drainInFlight) return;

  // Pre-check: no JWT means we're logged out. Don't even try; wait for the
  // next tick. The outbox accumulates harmlessly in the meantime.
  const jwt = await loadJwt().catch(() => null);
  if (!jwt) return;

  drainInFlight = true;
  try {
    const db = await getDb();

    while (true) {
      const rows = await db.select<PendingRow[]>(
        `SELECT id, event_uuid, event_type, body_json, occurrence_count,
                first_seen_at, last_seen_at, occurred_at
           FROM pending_writes
           ORDER BY id ASC
           LIMIT $1`,
        [BATCH_SIZE]
      );
      if (rows.length === 0) return;

      const events = rows.map((row) => {
        const inner = safeParseJson(row.body_json);
        // For errors, the dedup window may have bumped the row's
        // occurrence_count + last_seen_at after the original payload was
        // serialized; re-apply them so the server sees the freshest values.
        if (row.event_type === 'error') {
          if (inner) {
            (inner as { occurrence_count?: number }).occurrence_count = row.occurrence_count;
            if (row.first_seen_at) (inner as { first_seen_at?: string }).first_seen_at = row.first_seen_at;
            if (row.last_seen_at) (inner as { last_seen_at?: string }).last_seen_at = row.last_seen_at;
          }
        }
        return {
          event_uuid: row.event_uuid,
          event_type: row.event_type,
          occurred_at: row.occurred_at ?? new Date().toISOString(),
          payload: inner ?? {},
        };
      });

      let response: { results: IngestResult[] };
      try {
        response = await apiCall<{ results: IngestResult[] }>('telemetry', 'ingest', {
          method: 'POST',
          body: { events },
          bearer: true,
        });
      } catch (err) {
        if (err instanceof ApiError) {
          // 401/403: auth issue. Bail; user will re-login and the queue stays.
          if (err.status === 401 || err.status === 403) return;
          // 429 / 5xx: transient. Bail this tick; retry next interval.
          if (err.status === 429 || err.status >= 500) return;
          // Other 4xx: the request shape is malformed. Drop this batch so it
          // doesn't block the queue forever. The events themselves are lost,
          // which is acceptable for telemetry; logging surfaces the cause.
          console.warn('[telemetry] drainOnce: server rejected batch:', err.status, err.body);
          await deleteRows(db, rows.map((r) => r.id));
          continue;
        }
        // Network error (no response). Leave rows; retry next interval.
        return;
      }

      // Delete rows the server acknowledged (ok or rejected; the latter
      // means malformed and retrying won't help). The id list is small (50
      // max) so we can pass a parameterized IN clause.
      const acked = new Set(response.results.map((r) => r.event_uuid));
      const idsToDelete = rows.filter((r) => acked.has(r.event_uuid)).map((r) => r.id);
      if (idsToDelete.length === 0) {
        // Server returned no statuses — pathological case. Don't loop forever.
        return;
      }
      await deleteRows(db, idsToDelete);

      // If the server didn't ack the whole batch, leave the unacked rows for
      // next pass. Otherwise loop and drain the next batch.
      if (idsToDelete.length < rows.length) return;
    }
  } finally {
    drainInFlight = false;
  }
}

async function deleteRows(db: Database, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  // SQLite IN(?, ?, ?) requires one placeholder per value. plugin-sql uses
  // $1, $2, ... numbering.
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  await db.execute(`DELETE FROM pending_writes WHERE id IN (${placeholders})`, ids);
}

// ─── scrubbing ───────────────────────────────────────────────────────────────

// Replace anything that looks like a JWT (three base64url segments separated
// by dots), Bearer headers, and OS home-directory paths. Light touch by design
// (the plan calls for "light scrub"): aggressive scrubbing destroys stack
// debuggability. Tighten when a real leak is found.
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._-]+/gi;
const WIN_HOME_RE = /([A-Z]:\\Users\\)([^\\/\s"']+)/gi;
const NIX_HOME_RE = /(\/Users\/|\/home\/)([^/\s"']+)/g;

export function scrubPii(input: string): string {
  return input
    .replace(JWT_RE, '<jwt>')
    .replace(BEARER_RE, 'Bearer <token>')
    .replace(WIN_HOME_RE, '$1<user>')
    .replace(NIX_HOME_RE, '$1<user>');
}

function scrubContext(ctx: ErrorContext): ErrorContext {
  // Walk shallow JSON-like objects and scrub string values. We don't go deep
  // to avoid pathological recursion; if a caller needs deep scrubbing they
  // can pre-format the context string-side.
  const out: ErrorContext = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v === 'string') {
      out[k] = scrubPii(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─── fingerprinting ──────────────────────────────────────────────────────────

const TEXT_ENCODER = new TextEncoder();

/**
 * sha256(message + first 5 stack frames). Hex-encoded. The fingerprint
 * survives line-number drift only insofar as the first 5 frames keep their
 * file:fn shape — close enough for client-side dedup; the server can group
 * by it for the admin view.
 */
async function fingerprintError(message: string, stack: string | null): Promise<string> {
  const head = stack
    ? stack
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .slice(0, 5)
        .join('\n')
    : '';
  const data = TEXT_ENCODER.encode(`${message}\n${head}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function extractError(err: unknown): { message: string; stack: string | null } {
  if (err instanceof Error) {
    return { message: err.message || err.name || 'Error', stack: err.stack ?? null };
  }
  if (typeof err === 'string') {
    return { message: err, stack: null };
  }
  try {
    return { message: JSON.stringify(err), stack: null };
  } catch {
    return { message: String(err), stack: null };
  }
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function readSchemaMeta(db: Database, key: string): Promise<string | null> {
  const rows = await db.select<Array<{ value: string }>>(
    'SELECT value FROM schema_meta WHERE key = $1',
    [key]
  );
  return rows.length > 0 ? rows[0].value : null;
}

async function writeSchemaMeta(db: Database, key: string, value: string): Promise<void> {
  await db.execute(
    'INSERT INTO schema_meta(key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}
