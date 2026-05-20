// Slices A + B smoke test. Starts the mother-side axum server, exercises the
// 17 launched_games actions through the existing services/launchedGames.ts,
// then runs the slice-B pair handshake against a simulated second peer and
// verifies mDNS discovery loops back to this mother.
//
// Manual run from DevTools:
//   await window.__lanSmokeTest()
//
// Returns a list of step results; throws on the first hard failure.

import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { setLanOverride } from './api';
import {
  createLaunchedGame,
  listLaunchedGames,
  listActiveLaunchedGames,
  getLaunchedGameMeta,
  updateLaunchedGameMeta,
  getLaunchedGameState,
  recordPunch,
  getRawDataForChip,
  updateTeam,
  addTeamToLaunchedGame,
  endLaunchedGame,
  deleteLaunchedGame,
  registerDeviceForGame,
  getLaunchedGameDevices,
  listCompletedQuests,
  recordCompletedQuest,
} from './launchedGames';

const LAN_PORT = 8742;
const LAN_BASE = `http://127.0.0.1:${LAN_PORT}`;
const LAN_ENDPOINTS = new Set(['launched_games']);

interface MotherStartInfo {
  port: number;
  bound_addr: string;
  mother_device_uuid: string;
  mother_peer_secret: string;
  mother_peer_id: number;
}

interface StepResult {
  step: string;
  ok: boolean;
  detail?: unknown;
}

export interface SmokeTestReport {
  passed: number;
  failed: number;
  steps: StepResult[];
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

export async function runLanSmokeTest(opts?: {
  clientId?: number;
  port?: number;
}): Promise<SmokeTestReport> {
  const clientId = opts?.clientId ?? 1;
  const port = opts?.port ?? LAN_PORT;
  const steps: StepResult[] = [];
  const record = (step: string, ok: boolean, detail?: unknown) =>
    steps.push({ step, ok, detail });

  // tear down any prior run
  try { await invoke('mother_stop_local_server'); } catch { /* noop */ }
  setLanOverride(null);

  const startInfo = (await invoke('mother_start_local_server', {
    clientId,
    port,
    mdnsLabel: 'Smoke-Test-Mother',
  })) as MotherStartInfo;
  assert(typeof startInfo.mother_device_uuid === 'string' && startInfo.mother_device_uuid.length > 0,
    'mother_device_uuid present');
  assert(typeof startInfo.mother_peer_secret === 'string' && startInfo.mother_peer_secret.length > 0,
    'mother_peer_secret present');
  assert(typeof startInfo.mother_peer_id === 'number' && startInfo.mother_peer_id > 0,
    'mother_peer_id is a positive integer');
  record('mother_start_local_server', true, {
    port: startInfo.port,
    mother_device_uuid: startInfo.mother_device_uuid,
    mother_peer_id: startInfo.mother_peer_id,
  });

  setLanOverride({
    baseUrl: LAN_BASE,
    token: startInfo.mother_peer_secret,
    endpoints: LAN_ENDPOINTS,
  });

  let createdGameId: number | null = null;
  let teamIds: number[] = [];

  try {
    // ─── slice-A surface: 17 launched_games actions ─────────────────────────
    const created = await createLaunchedGame({
      game_uniqid: `smoke-${Date.now()}`,
      name: 'Smoke Game',
      number_of_teams: 2,
      game_type: 'tagquest',
      duration: 300,
      started: true,
      meta: { difficulty: 'easy', max_players: 6 },
      teams: [
        { team_number: 1, team_name: 'Red', pattern: 1, key_id: 100 },
        { team_number: 2, team_name: 'Blue', pattern: 2, key_id: 101 },
      ],
    });
    assert(typeof created.id === 'number' && created.id > 0, 'create returned valid id');
    assert(typeof created.device_row_id === 'number', 'create registered the launching peer');
    createdGameId = created.id;
    record('create', true, created);

    const allGames = await listLaunchedGames();
    assert(allGames.find((g) => g.id === createdGameId), 'list contains created game');
    record('list', true, { count: allGames.length });

    const active = await listActiveLaunchedGames();
    assert(active.find((g) => g.id === createdGameId), 'list_active contains created game');
    record('list_active', true, { count: active.length });

    const meta1 = await getLaunchedGameMeta(createdGameId);
    assert(meta1.difficulty === 'easy', 'meta1 difficulty=easy');
    assert(meta1.max_players === '6', 'meta1 max_players=6');
    record('get_meta', true, meta1);

    await updateLaunchedGameMeta(createdGameId, { difficulty: 'hard', extra: 'val' });
    const meta2 = await getLaunchedGameMeta(createdGameId);
    assert(meta2.difficulty === 'hard', 'update_meta replaced difficulty');
    assert(meta2.extra === 'val', 'update_meta added extra');
    assert(meta2.max_players === undefined, 'update_meta cleared max_players');
    record('update_meta', true, meta2);

    const state1 = await getLaunchedGameState(createdGameId, 0);
    assert(state1.id === createdGameId, 'state(initial) id matches');
    assert(state1.teams.length === 2, 'state(initial) has 2 teams');
    teamIds = state1.teams.map((t) => t.id);
    record('state(initial)', true, { teams: state1.teams.length });

    const punch1 = await recordPunch(createdGameId, { id: 12345, ts: Date.now() });
    assert(typeof punch1.id === 'number' && punch1.id > 0, 'record_punch returned id');
    record('record_punch', true, punch1);

    const state2 = await getLaunchedGameState(createdGameId, 0);
    assert(state2.new_raw_data.length === 1, 'state has 1 raw row');
    assert(
      (state2.new_raw_data[0]!.raw_data as { id: number }).id === 12345,
      'raw_data round-trip preserved chip id'
    );
    assert(
      state2.new_raw_data[0]!.device_id === startInfo.mother_peer_id,
      'punch device_id matches mother peer'
    );
    record('state(after-punch)', true, { device_id: state2.new_raw_data[0]!.device_id });

    const chipRows = await getRawDataForChip(createdGameId, 12345);
    assert(chipRows.length === 1, 'raw_data_for_chip returned 1 row');
    record('raw_data_for_chip', true, { count: chipRows.length });

    await updateTeam(teamIds[0]!, { score: 50, team_name: 'Crimson' });
    const state3 = await getLaunchedGameState(createdGameId, state2.last_raw_id);
    const updatedTeam = state3.teams.find((t) => t.id === teamIds[0]);
    assert(updatedTeam?.score === 50, 'update_team set score=50');
    record('update_team', true, updatedTeam);

    const addedTeam = await addTeamToLaunchedGame({
      launched_game_id: createdGameId,
      team_number: 3,
      team_name: 'Green',
      pattern: 3,
    });
    const state4 = await getLaunchedGameState(createdGameId, state3.last_raw_id);
    assert(state4.teams.length === 3, 'add_team made 3 teams total');
    record('add_team', true, addedTeam);

    const endTs = Date.now();
    await updateTeam(teamIds[0]!, { end_time: endTs });
    const state5 = await getLaunchedGameState(createdGameId, state4.last_raw_id);
    assert(
      state5.teams.find((t) => t.id === teamIds[0])?.end_time === endTs,
      'update_team set end_time'
    );
    record('update_team(end_time)', true, { end_time: endTs });

    await registerDeviceForGame(createdGameId);
    record('register_device', true);

    const devices = await getLaunchedGameDevices(createdGameId);
    assert(devices.length >= 1, 'get_devices returned at least the launcher');
    assert(
      devices.some((d) => d.device_id === startInfo.mother_peer_id),
      'mother peer is registered'
    );
    record('get_devices', true, { count: devices.length });

    const quests1 = await listCompletedQuests(createdGameId);
    assert(quests1.length === 0, 'list_completed_quests is empty');
    record('list_completed_quests(empty)', true);

    const cq1 = await recordCompletedQuest({
      launched_game_id: createdGameId,
      team_id: teamIds[0]!,
      quest_number: 'Q-1',
      points_awarded: 10,
    });
    assert(cq1.inserted === true, 'first record_completed_quest inserted');
    const cq2 = await recordCompletedQuest({
      launched_game_id: createdGameId,
      team_id: teamIds[0]!,
      quest_number: 'Q-1',
      points_awarded: 10,
    });
    assert(cq2.inserted === false, 'duplicate blocked (speed mode)');
    record('record_completed_quest', true, { first: cq1, dup: cq2 });

    const quests2 = await listCompletedQuests(createdGameId, teamIds[0]);
    assert(quests2.length === 1, 'list_completed_quests has 1 row');
    record('list_completed_quests(after)', true);

    // ─── slice-B surface: pair handshake against a simulated second peer ────
    const fakePeerUuid = `smoke-peer-${crypto.randomUUID()}`;
    const fakePeerLabel = 'Smoke Pretend Phone';
    const reqResp = await pairRequest(LAN_BASE, {
      peer_uuid: fakePeerUuid,
      peer_label: fakePeerLabel,
      peer_os: 'simulated',
      peer_app_version: 'smoke-1',
    });
    assert(reqResp.status === 'pending', 'pair.request returned pending');
    assert(typeof reqResp.request_id === 'number', 'pair.request returned request_id');
    record('pair.request', true, reqResp);

    const pollPending = await pairStatus(LAN_BASE, reqResp.request_id, fakePeerUuid);
    assert(pollPending.status === 'pending', 'pair.status pending before approval');
    record('pair.status(pending)', true, pollPending);

    const pendingList = (await invoke('mother_list_pending_pair_requests')) as Array<{ id: number; peer_uuid: string }>;
    assert(
      pendingList.some((r) => r.id === reqResp.request_id),
      'mother lists the pending request'
    );
    record('mother_list_pending_pair_requests', true, { count: pendingList.length });

    const newPeerId = (await invoke('mother_approve_pair_request', {
      requestId: reqResp.request_id,
    })) as number;
    assert(typeof newPeerId === 'number' && newPeerId > 0, 'approve returned new peer_id');
    assert(newPeerId !== startInfo.mother_peer_id, 'new peer is not the mother itself');
    record('mother_approve_pair_request', true, { peer_id: newPeerId });

    const pollApproved = await pairStatus(LAN_BASE, reqResp.request_id, fakePeerUuid);
    assert(pollApproved.status === 'approved', 'pair.status flipped to approved');
    assert(typeof pollApproved.peer_secret === 'string', 'approved status reveals peer_secret');
    record('pair.status(approved)', true, { has_secret: !!pollApproved.peer_secret });

    // Use the new peer's secret as bearer; confirm a launched_games read
    // works under a non-self bearer.
    setLanOverride({
      baseUrl: LAN_BASE,
      token: pollApproved.peer_secret!,
      endpoints: LAN_ENDPOINTS,
    });
    const stateAsPeer = await getLaunchedGameState(createdGameId, 0);
    assert(stateAsPeer.id === createdGameId, 'paired peer can read game state');
    record('peer_authed_state_read', true, { teams: stateAsPeer.teams.length });

    // Punch as the new peer; verify device_id flips to the new peer_id.
    const peerPunch = await recordPunch(createdGameId, { id: 99999, ts: Date.now() });
    const stateAfterPeerPunch = await getLaunchedGameState(createdGameId, stateAsPeer.last_raw_id);
    const newRow = stateAfterPeerPunch.new_raw_data.find((r) => r.id === peerPunch.id);
    assert(newRow !== undefined, 'peer punch row visible to mother');
    assert(newRow!.device_id === newPeerId, 'peer punch carries the paired peer_id');
    record('peer_authed_record_punch', true, { device_id: newRow!.device_id });

    // Re-pairing the same peer_uuid should be refused while a paired_devices
    // entry exists — the mother UI must revoke first.
    const reqAgain = await pairRequest(LAN_BASE, {
      peer_uuid: fakePeerUuid,
      peer_label: fakePeerLabel,
    });
    assert(reqAgain.status === 'already_paired', 'second request flagged already_paired');
    record('pair.request(already_paired)', true, reqAgain);

    // Restore mother bearer for cleanup endpoints.
    setLanOverride({
      baseUrl: LAN_BASE,
      token: startInfo.mother_peer_secret,
      endpoints: LAN_ENDPOINTS,
    });

    // Revoke the simulated peer so subsequent runs start clean.
    await invoke('mother_revoke_paired_device', { peerId: newPeerId });
    record('mother_revoke_paired_device', true);

    // Cleanup the smoke game.
    await endLaunchedGame(createdGameId);
    const activeAfter = await listActiveLaunchedGames();
    assert(
      !activeAfter.find((g) => g.id === createdGameId),
      'list_active no longer contains ended game'
    );
    record('end_game', true);

    await deleteLaunchedGame(createdGameId);
    const allAfter = await listLaunchedGames();
    assert(!allAfter.find((g) => g.id === createdGameId), 'delete_game removed game');
    record('delete_game', true);
    createdGameId = null;

    // ─── slice-B: mDNS self-discovery ───────────────────────────────────────
    // Best-effort: a fresh mDNS browser inside the same process should still
    // see the mother's own broadcast. Skipping is acceptable on hosts with
    // restrictive firewalls or lacking multicast on the active interface.
    const mothers = (await invoke('client_discover_mothers', {
      timeoutMs: 3000,
    })) as Array<{ mother_uuid: string; port: number; addresses: string[] }>;
    const me = mothers.find((m) => m.mother_uuid === startInfo.mother_device_uuid);
    if (me) {
      assert(me.port === startInfo.port, 'mDNS reports correct port');
      record('client_discover_mothers', true, {
        count: mothers.length,
        self_addresses: me.addresses,
      });
    } else {
      record('client_discover_mothers(skipped)', true, {
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

// ─── pair endpoint helpers ───────────────────────────────────────────────────

interface PairRequestResp {
  status: 'pending' | 'already_paired';
  request_id?: number;
  message?: string;
}

interface PairStatusResp {
  status: 'pending' | 'approved' | 'denied';
  peer_secret?: string;
}

async function pairRequest(
  base: string,
  body: {
    peer_uuid: string;
    peer_label: string;
    peer_os?: string;
    peer_app_version?: string;
  }
): Promise<PairRequestResp> {
  const res = await tauriFetch(`${base}/pair.php?action=request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`pair.request failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as PairRequestResp;
}

async function pairStatus(
  base: string,
  requestId: number,
  peerUuid: string
): Promise<PairStatusResp> {
  const url = `${base}/pair.php?action=status&request_id=${requestId}&peer_uuid=${encodeURIComponent(peerUuid)}`;
  const res = await tauriFetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`pair.status failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as PairStatusResp;
}

declare global {
  interface Window {
    __lanSmokeTest?: typeof runLanSmokeTest;
  }
}

if (typeof window !== 'undefined') {
  window.__lanSmokeTest = runLanSmokeTest;
}
