// Game simulator: verdict form (end of a run) + Coverage tab (which configs
// have been tested, what's missing, "Launch this config"). In-app panel only:
// both need the Studio API and the launched game. Internal tool - English only.

import { useEffect, useMemo, useState } from 'react';
import { getLaunchedGameMeta, getLaunchedGameState } from '../services/launchedGames';
import { gameConfigFromMeta } from '../utils/gameConfigFromMeta';
import { requestPresetLaunch } from '../services/launchPresetStore';
import type { GameConfig } from '../components/LaunchGameModal';
import {
  appVersion,
  autoSetup,
  axesFor,
  comboKey,
  comboLabel,
  comboOf,
  enumerate,
  listRuns,
  pairwise,
  recordRun,
  statusOf,
  type Combo,
  type ComboStatus,
  type GameAxes,
  type SimulationRun,
  type Verdict,
} from './coverage';
import type { SimStatus } from './types';

export interface GameInfo {
  launchedGameId: number;
  gameType: string;
  scenarioUniqid: string;
  scenarioTitle: string;
  ga: GameAxes | null;
  /** This launched game's config as a coverage combo (devices from `devices`). */
  combo: Combo | null;
  /** The game was launched by "Retry" on this Studio run (meta simRetryOf). */
  retryOf: number | null;
}

/** Loads the launched game's type, scenario and coverage combo. */
export function useGameInfo(launchedGameId: number, devices: number): GameInfo | null {
  const [base, setBase] = useState<{
    gameType: string;
    scenarioUniqid: string;
    scenarioTitle: string;
    meta: Record<string, string>;
    teamCount: number;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [state, meta] = await Promise.all([
          getLaunchedGameState(launchedGameId, 0),
          getLaunchedGameMeta(launchedGameId),
        ]);
        if (cancelled) return;
        setBase({
          gameType: (state.game_type || '').toLowerCase(),
          scenarioUniqid: state.game_uniqid,
          scenarioTitle: state.name,
          meta,
          teamCount: state.teams.length,
        });
      } catch {
        /* the panel shows its own errors; coverage just stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [launchedGameId]);
  return useMemo(() => {
    if (!base) return null;
    const ga = axesFor(base.gameType);
    const cfg = gameConfigFromMeta(base.meta, { name: base.scenarioTitle, numberOfTeams: 0 });
    return {
      launchedGameId,
      gameType: base.gameType,
      scenarioUniqid: base.scenarioUniqid,
      scenarioTitle: base.scenarioTitle,
      ga,
      combo: ga ? comboOf(ga, cfg, { devices: Math.max(1, devices), teamCount: base.teamCount }) : null,
      retryOf: Number(base.meta.simRetryOf) > 0 ? Number(base.meta.simRetryOf) : null,
    };
  }, [base, devices, launchedGameId]);
}

function useRuns() {
  const [runs, setRuns] = useState<SimulationRun[] | null>(null);
  const [version, setVersion] = useState('0.0.0');
  const [error, setError] = useState<string | null>(null);
  const reload = async (force = false) => {
    setError(null);
    try {
      const [r, v] = await Promise.all([listRuns(force), appVersion()]);
      setRuns(r);
      setVersion(v);
    } catch (err) {
      setError(String(err));
    }
  };
  useEffect(() => {
    void reload();
  }, []);
  return { runs, version, error, reload };
}

export function StatusPill({ s }: { s: ComboStatus }) {
  switch (s.kind) {
    case 'tested':
      return <span className="px-2 py-0.5 rounded bg-emerald-700/70">Tested {s.version}</span>;
    case 'tested_old':
      return <span className="px-2 py-0.5 rounded bg-sky-700/70">Tested on {s.version}</span>;
    case 'failed':
      return (
        <span className="px-2 py-0.5 rounded bg-red-700/70">
          {s.verdict === 'partial' ? 'Partial' : 'Failed'} {s.version}
        </span>
      );
    default:
      return <span className="px-2 py-0.5 rounded bg-white/10">Never tested</span>;
  }
}

// ── verdict form ──

const TESTER_KEY = 'sim.testerName';

export function VerdictForm({
  info,
  status,
  speed,
  devices,
}: {
  info: GameInfo;
  status: SimStatus;
  speed: number;
  devices: number;
}) {
  const runKey = `${info.launchedGameId}:${status.seed}:${status.total}`;
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [note, setNote] = useState('');
  const [tester, setTester] = useState(() => {
    try {
      return localStorage.getItem(TESTER_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!info.ga || !info.combo) {
    return <p className="text-amber-400">Coverage isn't defined for {info.gameType} yet: no verdict to record.</p>;
  }
  if (savedKey === runKey) return <p className="text-emerald-400">Verdict recorded. Thanks!</p>;

  const save = async () => {
    if (!verdict || !info.ga || !info.combo) return;
    setBusy(true);
    setError(null);
    try {
      try {
        localStorage.setItem(TESTER_KEY, tester);
      } catch {
        /* storage unavailable */
      }
      await recordRun({
        game_type: info.gameType,
        config_key: comboKey(info.gameType, info.combo),
        config: info.combo,
        verdict,
        note: note.trim() || undefined,
        tester_name: tester.trim() || undefined,
        scenario_uniqid: info.scenarioUniqid,
        scenario_title: info.scenarioTitle,
        app_version: await appVersion(),
        seed: status.seed ?? 0,
        speed,
        devices_count: Math.max(1, devices),
        teams_count: status.teams ?? 0,
        reads_total: status.total,
        reads_done: status.done,
        read_errors: status.errors ?? 0,
        ...(info.retryOf ? { parent_run_id: info.retryOf } : {}),
      });
      setSavedKey(runKey);
    } catch (err) {
      setError(`Could not record the verdict: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const vbtn = (v: Verdict, label: string, on: string) => (
    <button
      type="button"
      className={`px-3 py-2 rounded min-h-[40px] ${verdict === v ? on : 'bg-black/30'}`}
      onClick={() => setVerdict(v)}
    >
      {label}
    </button>
  );

  return (
    <section className="space-y-2 rounded border border-fuchsia-500/40 p-3">
      <div className="font-semibold">How did this run go?</div>
      {info.retryOf && (
        <div className="text-xs text-violet-300">Retry of run #{info.retryOf}: recorded as its retry in Studio.</div>
      )}
      <div className="text-xs text-white/60">{comboLabel(info.ga, info.combo)}</div>
      <div className="flex flex-wrap gap-2">
        {vbtn('pass', 'Pass', 'bg-emerald-600')}
        {vbtn('partial', 'Partial', 'bg-amber-600')}
        {vbtn('fail', 'Fail', 'bg-red-700')}
      </div>
      <textarea
        className="bg-black/30 rounded px-2 py-2 w-full min-h-[70px]"
        placeholder="What did you see? (bugs, odd scores, screens…)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <input
        className="bg-black/30 rounded px-2 py-2 w-full"
        placeholder="Tester name"
        value={tester}
        onChange={(e) => setTester(e.target.value)}
      />
      {error && <p className="text-red-400">{error}</p>}
      <button
        type="button"
        className="px-3 py-2 rounded min-h-[40px] bg-fuchsia-600 disabled:opacity-40"
        disabled={!verdict || busy}
        onClick={() => void save()}
      >
        {busy ? 'Saving…' : 'Record verdict'}
      </button>
    </section>
  );
}

// ── coverage tab ──

function launchCombo(info: GameInfo, ga: GameAxes, combo: Combo) {
  const steps = ga.manualSteps(combo);
  requestPresetLaunch({
    scenarioUniqid: info.scenarioUniqid,
    scenarioTitle: info.scenarioTitle,
    gameTypeName: info.gameType,
    config: ga.toConfig(combo),
    notice: `Simulator coverage: ${comboLabel(ga, combo)}.${steps.length ? ` Still to set by hand: ${steps.join(' ')}` : ''}`,
  });
}

/**
 * "Retry this run": relaunch a recorded run's exact configuration on its
 * scenario, with the same seed / speed / team count, through the wizard
 * autopilot (as a campaign does). The game starts its simulation by itself and
 * the verdict recorded at the end becomes a retry (child) of that run.
 */
function retryRun(run: SimulationRun, onFail: (reason: string) => void) {
  const ga = axesFor(run.game_type);
  if (!ga || !run.scenario_uniqid) {
    onFail(!ga ? `no coverage axes for ${run.game_type}` : 'the run has no scenario recorded');
    return;
  }
  requestPresetLaunch({
    scenarioUniqid: run.scenario_uniqid,
    scenarioTitle: run.scenario_title ?? run.scenario_uniqid,
    gameTypeName: run.game_type,
    config: {
      simulated: true,
      simAutoStart: true,
      simSeed: run.seed,
      simRetryOf: run.id,
      ...(run.speed ? { simSpeed: run.speed } : {}),
      ...(run.teams_count ? { simTeams: run.teams_count } : {}),
    },
    notice: `Retry of simulation run #${run.id} (${run.verdict}, v${run.app_version}, seed ${run.seed}): ${comboLabel(
      ga,
      run.config,
    )}`,
    autopilot: {
      setup: (world) => autoSetup(ga, run.config, world),
      onLaunched: () => {},
      onFail,
    },
  });
}

/** Failed / partial runs not resolved in Studio yet, newest first. */
function RetryList({ info, runs }: { info: GameInfo; runs: SimulationRun[] }) {
  const [onlyThisType, setOnlyThisType] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const retried = useMemo(() => {
    const m = new Map<number, number>();
    runs.forEach((r) => r.parent_run_id && m.set(r.parent_run_id, (m.get(r.parent_run_id) ?? 0) + 1));
    return m;
  }, [runs]);
  const list = runs
    .filter(
      (r) =>
        r.verdict !== 'pass' &&
        r.triage_status !== 'resolved' &&
        (!onlyThisType || r.game_type === info.gameType),
    )
    .slice(0, 30);
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Runs to retry</span>
        <label className="flex items-center gap-1.5 text-xs text-white/70">
          <input type="checkbox" checked={onlyThisType} onChange={(e) => setOnlyThisType(e.target.checked)} />
          {info.gameType} only
        </label>
      </div>
      <div className="text-xs text-white/60">
        Failed or partial runs not resolved in Studio. Retry relaunches the same options, scenario and seed by
        itself; the verdict you record is filed as a retry of that run.
      </div>
      {failure && <p className="text-red-400">{failure}</p>}
      {list.length === 0 ? (
        <p className="text-white/50">Nothing to retry.</p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((r) => {
            const ga = axesFor(r.game_type);
            return (
              <li key={r.id} className="rounded bg-black/30 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">#{r.id}</span>
                  <span className={`px-2 py-0.5 rounded ${r.verdict === 'fail' ? 'bg-red-700/70' : 'bg-amber-600/70'}`}>
                    {r.verdict}
                  </span>
                  <span className="text-xs text-white/50">
                    {r.game_type} · v{r.app_version} · {r.created_at.slice(0, 16)}
                    {r.triage_status === 'analysed' ? ' · analysed' : ''}
                    {retried.get(r.id) ? ` · retried ×${retried.get(r.id)}` : ''}
                  </span>
                  <button
                    type="button"
                    className="px-3 py-2 rounded min-h-[40px] ml-auto bg-violet-600 disabled:opacity-40"
                    disabled={!r.scenario_uniqid || !ga}
                    title={!r.scenario_uniqid ? 'No scenario recorded for this run' : undefined}
                    onClick={() => {
                      setFailure(null);
                      retryRun(r, (reason) => setFailure(`Retry of #${r.id} could not launch: ${reason}`));
                    }}
                  >
                    Retry
                  </button>
                </div>
                <div className="text-xs text-white/70 mt-1">
                  {r.scenario_title ?? '—'}
                  {ga ? ` · ${comboLabel(ga, r.config)}` : ''}
                </div>
                {r.note && <div className="text-xs text-white/50 mt-1 whitespace-pre-wrap">“{r.note}”</div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function CoverageTab({ info }: { info: GameInfo | null }) {
  const { runs, version, error, reload } = useRuns();
  const [mode, setMode] = useState<'pairwise' | 'all' | 'retry'>('pairwise');
  const [onlyMissing, setOnlyMissing] = useState(true);

  const ga = info?.ga ?? null;
  const all = useMemo(() => (ga ? enumerate(ga) : []), [ga]);
  const report = useMemo(() => (ga && runs ? pairwise(ga, runs, version) : null), [ga, runs, version]);

  if (!info) return <p className="text-white/60">Loading the game…</p>;
  if (!ga) {
    return <p className="text-amber-400">Coverage isn't defined for {info.gameType} yet (comes with its simulation).</p>;
  }
  if (error) {
    return (
      <div className="space-y-2">
        <p className="text-red-400">Coverage unavailable: {error}</p>
        <p className="text-xs text-white/60">Studio only answers tester installs (update channel "test").</p>
        <button type="button" className="px-3 py-2 rounded bg-black/40" onClick={() => void reload(true)}>
          Retry
        </button>
      </div>
    );
  }
  if (!runs) return <p className="text-white/60">Loading runs…</p>;

  const btn = 'px-3 py-2 rounded min-h-[40px]';
  const thisKey = info.combo ? comboKey(info.gameType, info.combo) : null;

  return (
    <div className="space-y-3 text-sm">
      {info.combo && thisKey && (
        <section className="rounded bg-black/30 p-2 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span>This game's config:</span>
            <StatusPill s={statusOf(thisKey, runs, version)} />
          </div>
          <div className="text-xs text-white/60">{comboLabel(ga, info.combo)}</div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${btn} ${mode === 'pairwise' ? 'bg-fuchsia-600' : 'bg-black/30'}`}
          onClick={() => setMode('pairwise')}
        >
          Pairwise
        </button>
        <button
          type="button"
          className={`${btn} ${mode === 'all' ? 'bg-fuchsia-600' : 'bg-black/30'}`}
          onClick={() => setMode('all')}
        >
          All {all.length} configs
        </button>
        <button
          type="button"
          className={`${btn} ${mode === 'retry' ? 'bg-fuchsia-600' : 'bg-black/30'}`}
          onClick={() => setMode('retry')}
        >
          Retry runs
        </button>
        <span className="text-xs text-white/50">App {version}</span>
        <button type="button" className={`${btn} ml-auto bg-black/40`} onClick={() => void reload(true)}>
          Refresh
        </button>
      </div>

      {mode === 'pairwise' && report && (
        <section className="space-y-2">
          <div>
            Option pairs covered by a Pass on {version}: {report.covered}/{report.total}
            <div className="h-2 rounded bg-white/10 mt-1">
              <div
                className="h-2 rounded bg-emerald-500"
                style={{ width: `${report.total ? (100 * report.covered) / report.total : 0}%` }}
              />
            </div>
          </div>
          {report.suggestions.length === 0 ? (
            <p className="text-emerald-400">Every pair is covered on this version.</p>
          ) : (
            <>
              <div className="text-xs text-white/60">
                Shortest list of configs to reach full pairwise coverage ({report.suggestions.length}):
              </div>
              <ul className="space-y-1.5">
                {report.suggestions.map(({ combo, adds }, i) => (
                  <li key={comboKey(info.gameType, combo)} className="rounded bg-black/30 p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">#{i + 1}</span>
                      <span className="text-xs text-white/50">+{adds} pairs</span>
                      <StatusPill s={statusOf(comboKey(info.gameType, combo), runs, version)} />
                      <button
                        type="button"
                        className={`${btn} ml-auto bg-fuchsia-600`}
                        onClick={() => launchCombo(info, ga, combo)}
                      >
                        Launch this config
                      </button>
                    </div>
                    <div className="text-xs text-white/70 mt-1">{comboLabel(ga, combo)}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {mode === 'retry' && <RetryList info={info} runs={runs} />}

      {mode === 'all' && (
        <section className="space-y-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
            Only configs without a Pass on {version}
          </label>
          <ul className="space-y-1.5">
            {all
              .map((combo) => ({ combo, s: statusOf(comboKey(info.gameType, combo), runs, version) }))
              .filter(({ s }) => !onlyMissing || s.kind !== 'tested')
              .map(({ combo, s }) => (
                <li key={comboKey(info.gameType, combo)} className="rounded bg-black/30 p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill s={s} />
                    <button
                      type="button"
                      className={`${btn} ml-auto bg-black/40`}
                      onClick={() => launchCombo(info, ga, combo)}
                    >
                      Launch this config
                    </button>
                  </div>
                  <div className="text-xs text-white/70 mt-1">{comboLabel(ga, combo)}</div>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ── Launch-modal badge ──

/** "Tested?" for the options currently set in the Launch modal (1 vs several devices). */
export function CoverageBadge({ gameTypeName, config }: { gameTypeName: string; config: GameConfig }) {
  const { runs, version, error } = useRuns();
  const ga = axesFor(gameTypeName);
  if (!ga) return <span className="text-xs text-white/50">Coverage: not defined for this game type yet.</span>;
  if (error) return <span className="text-xs text-white/50">Coverage unavailable (tester installs only).</span>;
  if (!runs) return <span className="text-xs text-white/50">Coverage: loading…</span>;
  const one = comboOf(ga, config, { devices: 1 });
  const several = comboOf(ga, config, { devices: 2 });
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-white/60">These options:</span>
      <span>1 device</span>
      <StatusPill s={statusOf(comboKey(gameTypeName, one), runs, version)} />
      <span>several</span>
      <StatusPill s={statusOf(comboKey(gameTypeName, several), runs, version)} />
    </span>
  );
}
