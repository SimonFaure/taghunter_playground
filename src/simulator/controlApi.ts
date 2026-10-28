// Local control API, JS side (tester builds only, main window). The Rust
// listener (src-tauri/src/sim_control_server.rs, 127.0.0.1 + token) forwards
// each request as `sim://control {reqId, cmd, args}`; the answer goes back
// through `sim_control_reply`. Used by the Claude Desktop MCP server
// (tools/playground-mcp) to run simulation campaigns.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { listBusyDeviceIds, listLaunchDevices } from '../services/launchedGames';
import { isOperatorOnly } from '../services/operatorMode';
import {
  appVersion,
  axesFor,
  comboKey,
  comboLabel,
  enumerate,
  listRuns,
  pairwise,
  statusOf,
  type Verdict,
} from './coverage';
import {
  CAMPAIGN_GAME_TYPES,
  buildItems,
  campaignSeq,
  retryCandidates,
  estimateSeconds,
  getCampaign,
  listPresets,
  listScenarios,
  loadSavedCampaign,
  pauseCampaign,
  recordVerdict,
  resumeCampaign,
  savePreset,
  skipCurrent,
  startCampaign,
  stopCampaign,
  waitForChange,
  type Campaign,
  type CampaignItemSpec,
  type CampaignSpec,
} from './campaign';
import { getSimStatus } from './executor';

type Args = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function testerName(): string {
  try {
    return localStorage.getItem('sim.testerName') ?? '';
  } catch {
    return '';
  }
}

function summary(c: Campaign | null) {
  if (!c) return { campaign: null, seq: campaignSeq() };
  const counts: Record<string, number> = {};
  for (const i of c.items) counts[i.state] = (counts[i.state] ?? 0) + 1;
  const cur = c.current !== null ? c.items[c.current] : null;
  const sim = getSimStatus();
  const remaining = c.items.filter((i) => i.state === 'queued');
  return {
    seq: campaignSeq(),
    campaign: {
      id: c.id,
      name: c.name,
      state: c.state,
      speed: c.speed,
      teams: c.teams,
      gameDurationMin: c.gameDuration ?? 'scenario default',
      clashPurgeAtMin: c.clashPurgeAt ?? 'random (25-60 % of the game)',
      appVersion: c.appVersion,
      counts,
      remainingEstimateSec: Math.round(estimateSeconds(remaining, c.speed, c.gameDuration)),
      current: cur
        ? {
            index: cur.index,
            state: cur.state,
            gameType: cur.gameType,
            label: cur.label,
            scenario: cur.scenarioTitle,
            launchedGameId: cur.launchedGameId,
            sim:
              sim.launchedGameId === cur.launchedGameId
                ? { phase: sim.phase, reads: `${sim.done}/${sim.total}`, message: sim.message }
                : null,
          }
        : null,
      items: c.items.map((i) => ({
        index: i.index,
        state: i.state,
        gameType: i.gameType,
        label: i.label,
        scenario: i.scenarioTitle,
        retryOf: i.retryOf ?? null,
        reason: i.reason,
        anomalies: i.result?.anomalies.length ?? 0,
        verdict: i.verdict?.verdict ?? null,
      })),
      awaitingVerdict: c.items
        .filter((i) => i.result && !i.verdict && (i.state === 'done' || i.state === 'error'))
        .map((i) => i.index),
    },
  };
}

async function coverage(args: Args) {
  const types = Array.isArray(args.gameTypes) && args.gameTypes.length
    ? (args.gameTypes as string[])
    : [...CAMPAIGN_GAME_TYPES];
  const [runs, version] = await Promise.all([listRuns(true), appVersion()]);
  return {
    appVersion: version,
    gameTypes: types
      .map((t) => axesFor(t))
      .filter((ga): ga is NonNullable<typeof ga> => !!ga)
      .map((ga) => {
        const all = enumerate(ga);
        const report = pairwise(ga, runs, version);
        const statuses = all.map((c) => ({ c, s: statusOf(comboKey(ga.gameType, c), runs, version) }));
        return {
          gameType: ga.gameType,
          axes: ga.axes.map((a) => ({ id: a.id, label: a.label, values: a.values.map((v) => v.v) })),
          allConfigs: all.length,
          passedOnThisVersion: statuses.filter((x) => x.s.kind === 'tested').length,
          pairs: { covered: report.covered, total: report.total },
          gaps: report.suggestions.map((s) => ({ combo: s.combo, label: comboLabel(ga, s.combo), addsPairs: s.adds })),
          failed: statuses
            .filter((x) => x.s.kind === 'failed')
            .map((x) => ({ combo: x.c, label: comboLabel(ga, x.c), status: x.s })),
        };
      }),
  };
}

function specFrom(args: Args): CampaignSpec {
  const source = str(args.source) as CampaignSpec['source'] | undefined;
  if (!source || !['gaps', 'all', 'preset', 'custom', 'retry'].includes(source)) {
    throw new Error('source must be one of gaps, all, preset, custom, retry');
  }
  return {
    source,
    name: str(args.name),
    gameTypes: Array.isArray(args.gameTypes) ? (args.gameTypes as string[]) : undefined,
    scenarioUniqid: str(args.scenarioUniqid),
    preset: str(args.preset),
    items: Array.isArray(args.items) ? (args.items as CampaignItemSpec[]) : undefined,
    retryRunIds: Array.isArray(args.retryRunIds)
      ? (args.retryRunIds as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : undefined,
    includeTested: args.includeTested === true,
    limit: num(args.limit),
    speed: num(args.speed),
    teams: num(args.teams),
    gameDuration: num(args.gameDuration),
    clashPurgeAt: num(args.clashPurgeAt),
  };
}

/** Studio runs worth retrying: failed / partial, not resolved, newest first. */
async function retryList(args: Args) {
  const types = Array.isArray(args.gameTypes) ? (args.gameTypes as string[]) : undefined;
  const runs = await listRuns(true);
  const children = new Map<number, number[]>();
  for (const r of runs) {
    if (!r.parent_run_id) continue;
    children.set(r.parent_run_id, [...(children.get(r.parent_run_id) ?? []), r.id]);
  }
  const limit = num(args.limit) ?? 30;
  return {
    runs: retryCandidates(runs, types)
      .slice(0, limit)
      .map((r) => {
        const ga = axesFor(r.game_type);
        const retries = children.get(r.id) ?? [];
        const lastRetry = retries.length ? runs.find((x) => x.id === Math.max(...retries)) : undefined;
        return {
          id: r.id,
          gameType: r.game_type,
          verdict: r.verdict,
          triage: r.triage_status ?? 'new',
          appVersion: r.app_version,
          date: r.created_at,
          scenario: r.scenario_title,
          canRetry: !!r.scenario_uniqid && !!ga,
          config: ga ? comboLabel(ga, r.config) : r.config_key,
          seed: r.seed,
          note: r.note,
          tester: r.tester_name,
          retryOf: r.parent_run_id ?? null,
          retries,
          lastRetryVerdict: lastRetry?.verdict ?? null,
        };
      }),
  };
}

async function handle(cmd: string, args: Args): Promise<unknown> {
  switch (cmd) {
    case 'retry_candidates':
      return retryList(args);
    case 'info': {
      const [version, devices, operatorOnly, busy] = await Promise.all([
        appVersion(),
        listLaunchDevices().catch(() => null),
        isOperatorOnly().catch(() => false),
        listBusyDeviceIds().catch(() => new Set<number>()),
      ]);
      return {
        appVersion: version,
        thisDeviceOperatorOnly: operatorOnly,
        devices: devices?.devices.map((d) => ({
          id: d.id,
          label: d.device_label,
          self: d.id === devices.selfId,
          online: d.online,
          operatorOnly: !!d.operator_only,
          // Informative only: simulated runs never need a reader.
          reader: !!d.has_reader,
          // In an active game: the launch wizard won't pick it for a new run.
          inGame: busy.has(d.id),
        })) ?? null,
        tester: testerName() || null,
        ...summary(getCampaign()),
      };
    }
    case 'list_scenarios':
      return { scenarios: await listScenarios() };
    case 'coverage':
      return coverage(args);
    case 'estimate': {
      const spec = specFrom(args);
      const items = await buildItems(spec);
      const speed = Math.min(20, Math.max(1, spec.speed ?? 20));
      const byType: Record<string, number> = {};
      for (const i of items) byType[i.gameType] = (byType[i.gameType] ?? 0) + 1;
      return {
        runs: items.length,
        byGameType: byType,
        speed,
        gameDurationMin: spec.gameDuration ?? 'scenario default',
        roughSeconds: Math.round(estimateSeconds(items, speed, spec.gameDuration)),
      };
    }
    case 'list_presets':
      return { presets: await listPresets() };
    case 'save_preset': {
      const name = str(args.name)?.trim();
      if (!name) throw new Error('name is required');
      const items = Array.isArray(args.items) ? (args.items as CampaignItemSpec[]) : [];
      if (!items.length) throw new Error('items is required');
      await savePreset(name, items);
      return { saved: name, items: items.length };
    }
    case 'start_campaign':
      await startCampaign(specFrom(args));
      return summary(getCampaign());
    case 'campaign_status':
      return summary(getCampaign());
    case 'wait_next_result': {
      const since = num(args.since) ?? campaignSeq();
      const timeoutSec = Math.min(60, Math.max(1, num(args.timeoutSec) ?? 55));
      await waitForChange(since, timeoutSec * 1000);
      return { changed: campaignSeq() > since, ...summary(getCampaign()) };
    }
    case 'run_result': {
      const c = getCampaign();
      const item = c?.items.find((i) => i.index === num(args.index));
      if (!item) throw new Error('no such run in the current campaign');
      // The whole journal and score timeline are big: only on request.
      if (args.full === true || !item.result) return { run: item };
      const { journal, scoreTimeline, ...result } = item.result;
      return {
        run: { ...item, result },
        more: {
          journalEntries: journal?.length ?? 0,
          scoreSnapshots: scoreTimeline?.length ?? 0,
          hint: 'Call run_result with full=true for every journal entry and the score timeline.',
        },
      };
    }
    case 'record_verdict': {
      const verdict = str(args.verdict) as Verdict | undefined;
      if (!verdict || !['pass', 'partial', 'fail'].includes(verdict)) throw new Error('verdict must be pass, partial or fail');
      const index = num(args.index);
      if (index === undefined) throw new Error('index is required');
      const tester = str(args.tester)?.trim() || testerName();
      if (str(args.tester)?.trim()) {
        try {
          localStorage.setItem('sim.testerName', tester);
        } catch {
          /* storage unavailable */
        }
      }
      const runId = await recordVerdict(index, verdict, str(args.note) ?? '', tester);
      return { recorded: runId };
    }
    case 'pause':
      pauseCampaign();
      return summary(getCampaign());
    case 'resume':
      resumeCampaign();
      return summary(getCampaign());
    case 'skip':
      skipCurrent();
      return summary(getCampaign());
    case 'stop':
      await stopCampaign();
      return summary(getCampaign());
    default:
      throw new Error(`unknown command "${cmd}"`);
  }
}

let installed = false;

/** Main window: answer the local control API and reload the last campaign. */
export function installControlApi() {
  if (installed) return;
  installed = true;
  void loadSavedCampaign();
  void listen<{ reqId: number; cmd: string; args: Args }>('sim://control', async (e) => {
    const { reqId, cmd, args } = e.payload;
    let result: unknown;
    try {
      result = { ok: true, data: await handle(cmd, args ?? {}) };
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    void invoke('sim_control_reply', { reqId, result }).catch((err) =>
      console.warn('[sim control] reply failed', err),
    );
  });
}
