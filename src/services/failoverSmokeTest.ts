// Mother-failover single-machine smoke test (slices 0–3). Automates the checks
// a single device can run without a second physical satellite: the state-version
// counter (slice 0), snapshot build + ping delivery + omission (slice 1), and
// the mDNS client_id/epoch TXT keys (slice 3). Slice 2 (satellite-side cache)
// and the promotion path (slice 4) need a real second device - see
// plans/mother-failover-qa-slices-0-3.md sections E and H.
//
// Manual run from DevTools:
//   await window.__failoverSmokeTest()
//
// Mirrors services/lanSmokeTest.ts: starts a throwaway mother on a test port,
// drives the surface, cleans up in `finally`, and returns a step report. Hits
// /ping.php directly (native ping is Rust-side and can't be observed from the
// webview Network tab) using the mother's own self peer_secret as bearer.

import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { setLanOverride } from './api';
import { getDb } from './db';
import { becomeMother } from './lanMotherBoot';
import {
  createLaunchedGame,
  getLaunchedGameState,
  recordPunch,
  deleteLaunchedGame,
} from './launchedGames';

const LAN_PORT = 8743; // distinct from lanSmokeTest's 8742 so both can coexist
const LAN_BASE = `http://127.0.0.1:${LAN_PORT}`;
const LAN_ENDPOINTS = new Set(['launched_games']);

interface MotherStartInfo {
  port: number;
  bound_addr: string;
  mother_device_uuid: string;
  mother_peer_secret: string;
  mother_peer_id: number;
}

interface PingResp {
  mother_uuid: string;
  commands: unknown[];
  mother_wifi: unknown;
  state_version: number;
  snapshot: Record<string, unknown> | null;
}

interface StepResult {
  step: string;
  ok: boolean;
  detail?: unknown;
}

export interface FailoverSmokeReport {
  passed: number;
  failed: number;
  steps: StepResult[];
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// POST /ping.php as the given bearer. Returns the parsed envelope (incl. the
// slice-1 state_version + snapshot fields).
async function ping(
  secret: string,
  body: { launched_game_id?: number; known_version?: number }
): Promise<PingResp> {
  const res = await tauriFetch(`${LAN_BASE}/ping.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`ping failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as PingResp;
}

const SNAPSHOT_KEYS = [
  'game',
  'meta',
  'devices',
  'raw_data',
  'teams',
  'completed_quests',
  'paired_devices',
  'wifi',
  'mother_epoch',
  'state_version',
];

export async function runFailoverSmokeTest(opts?: {
  clientId?: number;
  port?: number;
}): Promise<FailoverSmokeReport> {
  const clientId = opts?.clientId ?? 1;
  const port = opts?.port ?? LAN_PORT;
  const steps: StepResult[] = [];
  const record = (step: string, ok: boolean, detail?: unknown) =>
    steps.push({ step, ok, detail });

  // Tear down any prior run.
  try { await invoke('mother_stop_local_server'); } catch { /* noop */ }
  setLanOverride(null);

  const startInfo = (await invoke('mother_start_local_server', {
    clientId,
    port,
    mdnsLabel: 'Failover-Smoke-Mother',
  })) as MotherStartInfo;
  const secret = startInfo.mother_peer_secret;
  record('mother_start_local_server', true, {
    port: startInfo.port,
    mother_device_uuid: startInfo.mother_device_uuid,
  });

  setLanOverride({ baseUrl: LAN_BASE, token: secret, endpoints: LAN_ENDPOINTS });

  let createdGameId: number | null = null;

  try {
    // ─── set up a game ───────────────────────────────────────────────────────
    const created = await createLaunchedGame({
      game_uniqid: `failover-${Date.now()}`,
      name: 'Failover Smoke Game',
      number_of_teams: 2,
      game_type: 'tagquest',
      duration: 300,
      started: true,
      meta: {},
      teams: [
        { team_number: 1, team_name: 'Red', pattern: 1, key_id: 100 },
        { team_number: 2, team_name: 'Blue', pattern: 2, key_id: 101 },
      ],
    });
    assert(typeof created.id === 'number' && created.id > 0, 'create returned id');
    createdGameId = created.id;
    record('create_game', true, { id: createdGameId });

    // ─── slice 1: snapshot delivered when stale ─────────────────────────────
    const p0 = await ping(secret, { launched_game_id: createdGameId, known_version: -1 });
    assert(typeof p0.state_version === 'number', 'D1: state_version is a number');
    assert(p0.snapshot !== null && typeof p0.snapshot === 'object', 'D1: snapshot delivered');
    record('D1_snapshot_delivered', true, { state_version: p0.state_version });

    const missing = SNAPSHOT_KEYS.filter((k) => !(k in (p0.snapshot as object)));
    assert(missing.length === 0, `D2: snapshot has all keys (missing: ${missing.join(',')})`);
    record('D2_snapshot_complete', true, { keys: Object.keys(p0.snapshot as object) });

    const paired = (p0.snapshot!.paired_devices as Array<Record<string, unknown>>) ?? [];
    assert(paired.some((d) => d.is_self === true), 'D3: a self paired_devices row exists');
    assert(paired.every((d) => typeof d.peer_secret === 'string'), 'D3: peer_secret carried');
    record('D3_secrets_carried', true, { paired_count: paired.length });

    // ─── slice 0: counter bumps on a mutating action ────────────────────────
    const v0 = p0.state_version;
    const rawBefore = (p0.snapshot!.raw_data as unknown[]).length;
    await recordPunch(createdGameId, { id: 12345, ts: Date.now() });
    const p1 = await ping(secret, { launched_game_id: createdGameId, known_version: -1 });
    assert(p1.state_version > v0, `C1: state_version advanced (${v0} → ${p1.state_version})`);
    record('C1_counter_bumped', true, { from: v0, to: p1.state_version });

    const rawAfter = (p1.snapshot!.raw_data as unknown[]).length;
    assert(rawAfter > rawBefore, `D4: raw_data grew (${rawBefore} → ${rawAfter})`);
    record('D4_punch_in_snapshot', true, { raw_before: rawBefore, raw_after: rawAfter });

    // ─── slice 0: counter stable across a read-only op ──────────────────────
    await getLaunchedGameState(createdGameId, 0);
    const p1b = await ping(secret, { launched_game_id: createdGameId, known_version: -1 });
    assert(p1b.state_version === p1.state_version, 'C2: read-only op does not bump counter');
    record('C2_counter_stable_on_read', true, { state_version: p1b.state_version });

    // ─── slice 1: omission when the satellite is already current ────────────
    const pSame = await ping(secret, {
      launched_game_id: createdGameId,
      known_version: p1b.state_version,
    });
    assert(pSame.snapshot === null, 'D5: snapshot omitted when known_version matches');
    assert(pSame.state_version === p1b.state_version, 'D5: state_version unchanged');
    record('D5_omission_when_current', true, { state_version: pSame.state_version });

    // ─── slice 1: no game id → no snapshot ──────────────────────────────────
    const pNoGame = await ping(secret, {});
    assert(pNoGame.snapshot === null, 'D6: no snapshot without launched_game_id');
    record('D6_no_game_no_snapshot', true);

    // ─── slice 3: mDNS advertises client_id + epoch ─────────────────────────
    const mothers = (await invoke('client_discover_mothers', {
      timeoutMs: 4000,
    })) as Array<{
      mother_uuid: string;
      client_id: number | null;
      epoch: number | null;
    }>;
    const me = mothers.find((m) => m.mother_uuid === startInfo.mother_device_uuid);
    if (me) {
      assert(me.client_id === clientId, `F2: TXT client_id matches (${me.client_id})`);
      assert(typeof me.epoch === 'number' && me.epoch >= 1, `F3: epoch present (${me.epoch})`);
      record('F1_mdns_client_id_epoch', true, { client_id: me.client_id, epoch: me.epoch });
    } else {
      // Same soft-skip as lanSmokeTest: multicast loopback / firewall can hide
      // self-discovery on some hosts. Not a hard failure.
      record('F_mdns_self_discovery(skipped)', true, {
        reason: 'self not discovered (firewall / multicast); not a hard failure',
        count: mothers.length,
      });
    }
  } catch (e) {
    record('FAILED', false, (e as Error).message);
    throw e;
  } finally {
    if (createdGameId !== null) {
      try { await deleteLaunchedGame(createdGameId); } catch { /* noop */ }
    }
    setLanOverride(null);
    try { await invoke('mother_stop_local_server'); } catch { /* noop */ }
  }

  const failed = steps.filter((s) => !s.ok).length;
  return { passed: steps.length - failed, failed, steps };
}

// ─── manual two-device QA helpers (sections F + H) ───────────────────────────
// The DevTools console can't resolve bare module specifiers (`import('@tauri-
// apps/...')`) and `withGlobalTauri` is off, so there's no console-level
// `invoke`. These bundled helpers expose exactly the calls the manual F/H steps
// need. Run e.g. `await window.__failoverQA.discoverMothers()`.
export const failoverQA = {
  // Raw passthrough for any other command you need ad hoc.
  invoke,
  // F2 step 1 - this device's logged-in client_id (run on the mother).
  motherClientId: async () => (await getDb()).select('SELECT client_id FROM auth_user'),
  // F1/F3/H4 - browse the LAN for mothers (run on the satellite). Each row
  // carries client_id + epoch from the mDNS TXT.
  discoverMothers: (timeoutMs = 4000) =>
    invoke('client_discover_mothers', { timeoutMs }),
  // F4 quick path - force a mDNS re-announce without changing the network.
  refreshMdns: () => invoke('mother_refresh_mdns', { addresses: [] }),
  // H1–H5 - this device's cached failover snapshots (run on the satellite).
  snapshotCache: async () =>
    (await getDb()).select(
      'SELECT launched_game_id, state_version, mother_epoch, length(snapshot_json) AS bytes, updated_at FROM mother_snapshots'
    ),
  // Slice-0 counter, handy while testing C1/C3.
  stateVersion: async () =>
    (await getDb()).select("SELECT value FROM schema_meta WHERE key='lg_state_version'"),
  // Slice 4 - promote THIS device into the new mother for a game it cached.
  // Run on a satellite after killing the real mother. Returns the new server
  // info incl. the bumped `epoch`; throws on the content/snapshot guards.
  becomeMother: (launchedGameId: number) => becomeMother(launchedGameId),
};

declare global {
  interface Window {
    __failoverSmokeTest?: typeof runFailoverSmokeTest;
    __failoverQA?: typeof failoverQA;
  }
}

if (typeof window !== 'undefined') {
  window.__failoverSmokeTest = runFailoverSmokeTest;
  window.__failoverQA = failoverQA;
}
