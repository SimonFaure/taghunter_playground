// Simulation campaigns UI (tester builds only): the Campaign tab of the
// in-app simulator panel (start a series, follow it, judge the runs) and the
// campaign strip on the game page's floating window. Internal tool - English
// only.

import { useEffect, useMemo, useState } from 'react';
import {
  CAMPAIGN_GAME_TYPES,
  buildItems,
  clearCampaign,
  estimateSeconds,
  getCampaign,
  pauseCampaign,
  recordVerdict,
  resumeCampaign,
  skipCurrent,
  startCampaign,
  stopCampaign,
  subscribeCampaign,
  type Campaign,
  type CampaignItem,
  type CampaignSource,
} from './campaign';
import type { Verdict } from './coverage';

export function useCampaign(): Campaign | null {
  const [c, setC] = useState<Campaign | null>(getCampaign());
  const [, tick] = useState(0);
  // Items are mutated in place: re-render on every change notice.
  useEffect(() => subscribeCampaign((next) => {
    setC(next);
    tick((n) => n + 1);
  }), []);
  return c;
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

const STATE_STYLE: Record<CampaignItem['state'], string> = {
  queued: 'bg-white/10',
  launching: 'bg-sky-700/70',
  running: 'bg-fuchsia-600/80',
  done: 'bg-emerald-700/70',
  skipped: 'bg-white/20',
  error: 'bg-red-700/70',
  stopped: 'bg-white/20',
  interrupted: 'bg-amber-700/70',
};

/** One-line campaign status + controls (floating window and tab header). */
export function CampaignStrip({ compact }: { compact?: boolean }) {
  const c = useCampaign();
  if (!c || c.state === 'done' || c.state === 'stopped') return null;
  const finished = c.items.filter((i) => i.state !== 'queued' && i.state !== 'launching' && i.state !== 'running').length;
  const cur = c.current !== null ? c.items[c.current] : null;
  const btn = 'px-2 py-1 rounded text-xs';
  return (
    <div className="rounded border border-fuchsia-500/40 bg-fuchsia-900/20 p-1.5 space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        <span className="font-semibold text-fuchsia-300">Campaign</span>
        <span>
          {finished}/{c.items.length}
        </span>
        <span className="text-white/60">{c.state}</span>
        <span className="ml-auto flex gap-1">
          {c.state === 'running' ? (
            <button type="button" className={`${btn} bg-white/10`} onClick={pauseCampaign} title="Finish this run, then wait">
              Pause after this run
            </button>
          ) : (
            <button type="button" className={`${btn} bg-fuchsia-600`} onClick={resumeCampaign}>
              Resume
            </button>
          )}
          {cur && (
            <button type="button" className={`${btn} bg-white/10`} onClick={skipCurrent}>
              Skip run
            </button>
          )}
          <button type="button" className={`${btn} bg-red-700`} onClick={() => void stopCampaign()}>
            Stop
          </button>
        </span>
      </div>
      {cur && !compact && <div className="text-white/70">Run {cur.index + 1}: {cur.label}</div>}
      {cur && compact && <div className="text-white/70 truncate" title={cur.label}>Run {cur.index + 1}: {cur.label}</div>}
    </div>
  );
}

function ItemVerdict({ item }: { item: CampaignItem }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (item.verdict) {
    return (
      <span className="text-xs text-white/70">
        Verdict: <b>{item.verdict.verdict}</b>
        {item.verdict.note ? ` - ${item.verdict.note}` : ''}
      </span>
    );
  }
  if (!item.result || (item.state !== 'done' && item.state !== 'error')) return null;
  const save = async (v: Verdict) => {
    setBusy(true);
    setError(null);
    try {
      let tester = '';
      try {
        tester = localStorage.getItem('sim.testerName') ?? '';
      } catch {
        /* storage unavailable */
      }
      await recordVerdict(item.index, v, note, tester);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  const btn = 'px-2 py-1 rounded text-xs disabled:opacity-40';
  return (
    <div className="flex flex-wrap items-center gap-1">
      <input
        className="bg-black/30 rounded px-2 py-1 text-xs flex-1 min-w-[120px]"
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button type="button" disabled={busy} className={`${btn} bg-emerald-600`} onClick={() => void save('pass')}>
        Pass
      </button>
      <button type="button" disabled={busy} className={`${btn} bg-amber-600`} onClick={() => void save('partial')}>
        Partial
      </button>
      <button type="button" disabled={busy} className={`${btn} bg-red-700`} onClick={() => void save('fail')}>
        Fail
      </button>
      {error && <span className="text-red-400 text-xs w-full">{error}</span>}
    </div>
  );
}

function CampaignView({ c }: { c: Campaign }) {
  const running = c.current !== null;
  const counts = useMemo(() => {
    const n: Partial<Record<CampaignItem['state'], number>> = {};
    for (const i of c.items) n[i.state] = (n[i.state] ?? 0) + 1;
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, c.items.map((i) => i.state).join()]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{c.name}</span>
        <span className="text-xs text-white/60">
          app {c.appVersion} · ×{c.speed} · {c.teams} mock teams · game{' '}
          {c.gameDuration ? `${c.gameDuration} min` : 'default duration'}
        </span>
        {(c.state === 'done' || c.state === 'stopped') && !running && (
          <button type="button" className="ml-auto px-3 py-2 rounded bg-black/40" onClick={clearCampaign}>
            New campaign
          </button>
        )}
      </div>
      <div className="text-xs text-white/70">
        {Object.entries(counts)
          .map(([k, v]) => `${v} ${k}`)
          .join(' · ')}
      </div>
      <CampaignStrip />
      <ul className="space-y-1.5">
        {c.items.map((item) => (
          <li key={item.index} className="rounded bg-black/30 p-2 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">#{item.index + 1}</span>
              <span className={`px-2 py-0.5 rounded text-xs ${STATE_STYLE[item.state]}`}>{item.state}</span>
              <span className="text-xs text-white/50">{item.gameType}</span>
              {item.scenarioTitle && <span className="text-xs text-white/50 truncate">· {item.scenarioTitle}</span>}
              {item.result && (
                <span className="ml-auto text-xs text-white/60">
                  reads {item.result.readsDone}/{item.result.readsTotal}
                </span>
              )}
            </div>
            <div className="text-xs text-white/70">{item.label}</div>
            {item.reason && <div className="text-xs text-amber-400">{item.reason}</div>}
            {item.result?.anomalies.map((a) => (
              <div key={a} className="text-xs text-red-400">
                ⚠ {a}
              </div>
            ))}
            <ItemVerdict item={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Start form: which series, which game types, speed. */
function CampaignForm({ scenarioUniqid, gameType }: { scenarioUniqid?: string; gameType?: string }) {
  const [source, setSource] = useState<Exclude<CampaignSource, 'custom' | 'preset'>>('gaps');
  const [types, setTypes] = useState<string[]>(() => (gameType ? [gameType] : [...CAMPAIGN_GAME_TYPES]));
  const [thisScenario, setThisScenario] = useState(!!scenarioUniqid);
  const [speed, setSpeed] = useState(20);
  const [teams, setTeams] = useState(6);
  /** Game time limit in minutes; '' = each scenario's default. */
  const [gameDuration, setGameDuration] = useState('');
  const durationMin = parseInt(gameDuration, 10) > 0 ? parseInt(gameDuration, 10) : undefined;
  /** Clash: planned Purge minute after Start; '' = random. */
  const [purgeAt, setPurgeAt] = useState('');
  const purgeAtMin = parseInt(purgeAt, 10) > 0 ? parseInt(purgeAt, 10) : undefined;
  const [planned, setPlanned] = useState<Array<{ gameType: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const spec = {
    source,
    gameTypes: types,
    scenarioUniqid: thisScenario ? scenarioUniqid : undefined,
    speed,
    teams,
    gameDuration: durationMin,
    clashPurgeAt: purgeAtMin,
  };
  useEffect(() => {
    let cancelled = false;
    setPlanned(null);
    buildItems({ source, gameTypes: types })
      .then((items) => !cancelled && setPlanned(items))
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [source, types]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await startCampaign(spec);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  const btn = 'px-3 py-2 rounded min-h-[40px]';
  return (
    <div className="space-y-3 text-sm">
      <p className="text-white/70">
        A campaign launches each configuration through the Launch wizard, plays it on this device's game page, ends the
        game and goes on. Judge each run below, or from Claude Desktop.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`${btn} ${source === 'gaps' ? 'bg-fuchsia-600' : 'bg-black/30'}`}
          onClick={() => setSource('gaps')}
        >
          Coverage gaps (pairwise)
        </button>
        <button
          type="button"
          className={`${btn} ${source === 'all' ? 'bg-fuchsia-600' : 'bg-black/30'}`}
          onClick={() => setSource('all')}
        >
          Every config not yet passed
        </button>
      </div>
      <div className="flex flex-wrap gap-3">
        {CAMPAIGN_GAME_TYPES.map((t) => (
          <label key={t} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={types.includes(t)}
              onChange={(e) => setTypes((prev) => (e.target.checked ? [...prev, t] : prev.filter((x) => x !== t)))}
            />
            {t}
          </label>
        ))}
      </div>
      {scenarioUniqid && (
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={thisScenario} onChange={(e) => setThisScenario(e.target.checked)} />
          Prefer this game's scenario (else the first downloaded one that fits)
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          Speed
          <select className="bg-black/30 rounded px-2 py-1" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {[5, 10, 20].map((s) => (
              <option key={s} value={s}>
                ×{s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Game duration
          <input
            type="number"
            min={1}
            max={600}
            placeholder="default"
            className="w-24 bg-black/30 rounded px-2 py-1"
            value={gameDuration}
            onChange={(e) => setGameDuration(e.target.value)}
          />
          min
        </label>
        {types.includes('clash') && (
          <label className="flex items-center gap-2" title="Clash runs with the Purge. Empty = random (25-60 % of the game).">
            Clash Purge at
            <input
              type="number"
              min={1}
              max={600}
              placeholder="random"
              className="w-24 bg-black/30 rounded px-2 py-1"
              value={purgeAt}
              onChange={(e) => setPurgeAt(e.target.value)}
            />
            min
          </label>
        )}
        <label className="flex items-center gap-2">
          Mock teams
          <input
            type="number"
            min={1}
            max={50}
            className="w-20 bg-black/30 rounded px-2 py-1"
            value={teams}
            onChange={(e) => setTeams(Math.min(50, Math.max(1, parseInt(e.target.value || '1', 10) || 1)))}
          />
        </label>
      </div>
      <div className="text-white/70">
        {planned === null
          ? 'Counting…'
          : `${planned.length} run(s), roughly ${fmtDuration(estimateSeconds(planned, speed, durationMin))} at ×${speed}.`}
      </div>
      {error && <p className="text-red-400">{error}</p>}
      <button
        type="button"
        className={`${btn} bg-fuchsia-600 disabled:opacity-40`}
        disabled={busy || !planned?.length || types.length === 0}
        onClick={() => void start()}
      >
        {busy ? 'Starting…' : 'Start the campaign'}
      </button>
    </div>
  );
}

export function CampaignTab({ scenarioUniqid, gameType }: { scenarioUniqid?: string; gameType?: string }) {
  const c = useCampaign();
  return c ? <CampaignView c={c} /> : <CampaignForm scenarioUniqid={scenarioUniqid} gameType={gameType} />;
}
