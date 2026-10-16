// Game simulator control panel (tester builds only). A thin remote: the
// simulation always runs on a TARGET device's executor (main window, next to
// its live game page). Two transports:
//   - local:  this device - Tauri events (sim://cmd, sim://status, ...)
//   - remote: another device of the game (mother or satellite, e.g. driven from
//     an Android tablet) - `sim_control` LAN command out, status polled back
//     from launched-game meta `sim_status:<deviceId>`.
// Rendered as the desktop pop-out window (`?simulator=<id>`, local only - that
// window has no LAN route) or in-app from the launched games list.
// Internal tool - English only, not translated.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { BaseDirectory, mkdir, writeTextFile } from '@tauri-apps/plugin-fs';
import {
  getLaunchedGameMeta,
  listPairedWithStatus,
  queueJoinGameCommandBulk,
  queueSimControl,
  type PairedDeviceStatusRow,
} from '../services/launchedGames';
import {
  EVT_SIM_CMD,
  EVT_SIM_FIELD,
  EVT_SIM_JOURNAL,
  EVT_SIM_STATUS,
  type FieldRow,
  SIM_STATUS_PREFIX,
  type JournalEntry,
  type ProfileId,
  type SimCommand,
  type SimConfig,
  type SimRemoteStatus,
  type SimStatus,
} from './types';
import { FieldList } from './FieldList';
import { CoverageTab, VerdictForm, useGameInfo } from './CoveragePanels';
import { CampaignTab } from './CampaignPanel';
import { fromMotherClock, motherNow } from '../services/motherTime';

const PROFILE_LABELS: Record<ProfileId, string> = {
  fast: 'Fast / good',
  average: 'Average',
  slow: 'Slow / lost',
  chaotic: 'Chaotic',
};
const SPEEDS = [1, 2, 5, 10, 20];
const REMOTE_POLL_MS = 1500;
const DEVICES_POLL_MS = 5000;
/** A running remote executor that hasn't mirrored for this long is flagged. */
const REMOTE_STALE_MS = 10_000;

type Target = 'local' | number;

function fmtTime(ms: number) {
  return new Date(ms).toLocaleTimeString();
}

function screenLabel(d: PairedDeviceStatusRow, gid: number): { text: string; ok: boolean } {
  const s = d.screen_state;
  if (!d.online) return { text: 'offline', ok: false };
  if (!s) return { text: 'online', ok: true };
  if (s.kind === 'in_game') {
    return s.launchedGameId === gid
      ? { text: 'on this game', ok: true }
      : { text: `in another game`, ok: false };
  }
  return { text: s.kind, ok: false };
}

export interface SimulatorPanelProps {
  launchedGameId: number;
  /** This device can run the simulation itself (desktop). */
  allowLocal: boolean;
  /** Other devices can be targeted (needs the in-app LAN route). */
  allowRemote: boolean;
  onClose?: () => void;
  /** Desktop in-app: open the pop-out window for a local run. */
  onPopOut?: () => void;
}

export function SimulatorPanel({ launchedGameId, allowLocal, allowRemote, onClose, onPopOut }: SimulatorPanelProps) {
  const [cfg, setCfg] = useState<SimConfig>({
    launchedGameId,
    seed: Math.floor(Math.random() * 1_000_000),
    speed: 10,
    profileMix: { fast: 2, average: 4, slow: 2, chaotic: 1 },
    dynamicTeamCount: 10,
    arrivalWindowMin: 10,
    spreadAcrossDevices: true,
  });
  const [target, setTarget] = useState<Target | null>(allowLocal ? 'local' : null);
  const [devices, setDevices] = useState<PairedDeviceStatusRow[]>([]);
  const [meId, setMeId] = useState<number | null>(null);
  const [status, setStatus] = useState<SimStatus | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [remoteUpdatedAt, setRemoteUpdatedAt] = useState<number | null>(null);
  /** Other devices currently running a simulation of this game. */
  const [othersRunning, setOthersRunning] = useState<string[]>([]);
  /** Every device's mirrored status (multi-device runs are summed per runKey). */
  const [runStatuses, setRunStatuses] = useState<Array<{ devId: number; s: SimStatus; updatedAt: number }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const [exported, setExported] = useState<string | null>(null);
  const [tab, setTab] = useState<'controls' | 'field' | 'journal' | 'coverage' | 'campaign'>('controls');
  const [fieldRows, setFieldRows] = useState<FieldRow[]>([]);

  // ── devices of this game (remote targets) ──
  useEffect(() => {
    if (!allowRemote) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await listPairedWithStatus(launchedGameId);
        if (cancelled) return;
        setDevices(r.in_game);
        setMeId(r.caller_device_id ?? null);
      } catch (err) {
        if (!cancelled) setError(`Device list failed: ${String(err)}`);
      }
    };
    void load();
    const id = setInterval(load, DEVICES_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [allowRemote, launchedGameId]);

  // Coverage: this game's type/scenario/config combo (devices in the game count
  // toward the "devices" axis). Needs the in-app route, so in-app panel only.
  const gameInfo = useGameInfo(launchedGameId, devices.length);

  const remoteDevices = useMemo(
    // Operator-only devices (tablets) never play, so they can't run a simulation.
    () => devices.filter((d) => !d.operator_only && !(allowLocal && d.id === meId)),
    [devices, allowLocal, meId],
  );

  // ── local transport ──
  useEffect(() => {
    if (target !== 'local') return;
    setStatus(null);
    setJournal([]);
    const offs = [
      listen<SimStatus>(EVT_SIM_STATUS, (e) => setStatus(e.payload)),
      listen<JournalEntry>(EVT_SIM_JOURNAL, (e) => setJournal((j) => [...j, e.payload])),
      listen<FieldRow[]>(EVT_SIM_FIELD, (e) => setFieldRows(e.payload)),
    ];
    void emit(EVT_SIM_CMD, { kind: 'status' } satisfies SimCommand);
    return () => offs.forEach((p) => void p.then((off) => off()));
  }, [target]);

  // ── remote transport: poll the mirrored status (also spots parallel runs) ──
  useEffect(() => {
    if (!allowRemote) return;
    let cancelled = false;
    setRemoteUpdatedAt(null);
    if (typeof target === 'number') {
      setStatus(null);
      setJournal([]);
    }
    const poll = async () => {
      try {
        const meta = await getLaunchedGameMeta(launchedGameId);
        if (cancelled) return;
        const running: string[] = [];
        const all: Array<{ devId: number; s: SimStatus; updatedAt: number }> = [];
        for (const [k, v] of Object.entries(meta)) {
          if (!k.startsWith(SIM_STATUS_PREFIX)) continue;
          const devId = Number(k.slice(SIM_STATUS_PREFIX.length));
          let parsed: SimRemoteStatus | null = null;
          try {
            parsed = JSON.parse(v) as SimRemoteStatus;
          } catch {
            continue;
          }
          const isTarget = typeof target === 'number' ? devId === target : devId === meId;
          all.push({ devId, s: parsed.status, updatedAt: parsed.updatedAt });
          if (typeof target === 'number' && devId === target) {
            // Mirrored clocks are in mother time: back to this device's clock.
            setStatus({
              ...parsed.status,
              clock: parsed.status.clock ? fromMotherClock(parsed.status.clock) : null,
            });
            setJournal(parsed.journal);
            setFieldRows(parsed.field ?? []);
            setRemoteUpdatedAt(parsed.updatedAt);
          }
          const live = parsed.status.phase === 'running' || parsed.status.phase === 'paused';
          if (live && !isTarget && motherNow() - parsed.updatedAt < 5 * 60_000) {
            running.push(`${devId}|${parsed.status.runKey ?? ''}|${devices.find((d) => d.id === devId)?.device_label ?? `device #${devId}`}`);
          }
        }
        setOthersRunning(running);
        setRunStatuses(all);
      } catch (err) {
        if (!cancelled) setError(`Status poll failed: ${String(err)}`);
      }
    };
    void poll();
    const id = setInterval(poll, REMOTE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [allowRemote, target, launchedGameId, meId, devices]);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);

  const send = useCallback(
    async (cmd: SimCommand) => {
      setError(null);
      if (target === 'local') {
        await emit(EVT_SIM_CMD, cmd);
        return;
      }
      if (typeof target !== 'number') return;
      try {
        const res = await queueSimControl(target, launchedGameId, cmd as unknown as Record<string, unknown>);
        const failed = res.results.find((r) => r.error);
        if (failed) setError(`Device refused: ${failed.error}`);
      } catch (err) {
        setError(`Send failed: ${String(err)}`);
      }
    },
    [target, launchedGameId],
  );

  const targetRow = typeof target === 'number' ? devices.find((d) => d.id === target) : undefined;
  const targetScreen = targetRow ? screenLabel(targetRow, launchedGameId) : null;

  const clock = status?.clock ?? null;
  const virtualNow = clock
    ? clock.virtualAnchor + ((clock.pausedAt ?? Date.now()) - clock.realAnchor) * clock.speed
    : null;
  // A remote status' clock was converted from mother time on arrival.
  const remoteStale =
    typeof target === 'number' &&
    (status?.phase === 'running' || status?.phase === 'paused') &&
    remoteUpdatedAt !== null &&
    motherNow() - remoteUpdatedAt > REMOTE_STALE_MS;

  // A multi-device run: sum every participant's progress (each device mirrors
  // its own share). Devices of the same run are not "parallel runs".
  const runKey = status?.runKey;
  const shared = runKey && status?.role !== 'solo' ? runStatuses.filter((r) => r.s.runKey === runKey) : [];
  const runTotals =
    shared.length > 1
      ? shared.reduce(
          (acc, r) => ({
            done: acc.done + r.s.done,
            total: acc.total + r.s.total,
            errors: acc.errors + (r.s.errors ?? 0),
          }),
          { done: 0, total: 0, errors: 0 },
        )
      : null;
  const parallelRuns = othersRunning
    .map((x) => x.split('|'))
    .filter(([, rk]) => !runKey || rk !== runKey)
    .map(([, , label]) => label);
  const verdictStatus: SimStatus | null =
    status && runTotals ? { ...status, done: runTotals.done, total: runTotals.total, errors: runTotals.errors } : status;

  const busy = status?.phase === 'running' || status?.phase === 'paused' || status?.phase === 'opening';
  const otherGame = busy && status?.launchedGameId !== launchedGameId;

  const start = () => {
    if (target === 'local') setJournal([]);
    void send({ kind: 'start', config: cfg });
  };

  const openGameOnTarget = async () => {
    if (typeof target !== 'number') return;
    try {
      await queueJoinGameCommandBulk([target], launchedGameId, { rejoin: true });
    } catch (err) {
      setError(`Could not open the game on the device: ${String(err)}`);
    }
  };

  // Written under AppData (the fs scope); replay = same seed on the same launch config.
  const exportRun = async () => {
    try {
      const name = `simulations/game${launchedGameId}-seed${cfg.seed}-${Date.now()}.json`;
      await mkdir('simulations', { baseDir: BaseDirectory.AppData, recursive: true });
      await writeTextFile(name, JSON.stringify({ config: cfg, target, status, journal }, null, 2), {
        baseDir: BaseDirectory.AppData,
      });
      setExported(`Saved to AppData/${name}`);
    } catch (err) {
      setExported(`Export failed: ${String(err)}`);
    }
  };

  const num = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, parseInt(v || '0', 10) || 0));
  const field = 'bg-black/30 rounded px-2 py-2 w-full';
  const btn = 'px-3 py-2 rounded min-h-[40px]';

  return (
    <div className="min-h-full bg-[var(--pg-bg,#0b0f14)] text-[var(--pg-text,#e6e6e6)] p-4 space-y-4 text-sm">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-fuchsia-400">Game simulator · game #{launchedGameId}</h1>
        <span className="font-mono">
          {target === null ? 'pick a device' : (status?.phase ?? 'waiting for the device…')}
          {virtualNow && ` · ${fmtTime(virtualNow)} ×${clock?.speed}`}
        </span>
        {onClose && (
          <button type="button" className={`${btn} bg-black/40`} onClick={onClose}>
            Close
          </button>
        )}
      </header>

      {/* Target device */}
      {allowRemote && tab === 'controls' && (
        <section className="space-y-2">
          <div>Run the simulation on</div>
          <div className="flex flex-wrap gap-2">
            {allowLocal && (
              <button
                type="button"
                className={`${btn} ${target === 'local' ? 'bg-fuchsia-600' : 'bg-black/30'}`}
                onClick={() => setTarget('local')}
              >
                This device
              </button>
            )}
            {remoteDevices.map((d) => {
              const sc = screenLabel(d, launchedGameId);
              return (
                <button
                  key={d.id}
                  type="button"
                  className={`${btn} text-left ${target === d.id ? 'bg-fuchsia-600' : 'bg-black/30'}`}
                  onClick={() => setTarget(d.id)}
                >
                  <div>
                    {d.device_label}
                    {d.is_self ? ' (mother)' : ''}
                  </div>
                  <div className={`text-xs ${sc.ok ? 'text-emerald-400' : 'text-amber-400'}`}>{sc.text}</div>
                </button>
              );
            })}
            {remoteDevices.length === 0 && !allowLocal && (
              <p className="text-amber-400">No other device is in this game yet.</p>
            )}
          </div>
          {targetScreen && !targetScreen.ok && (
            <div className="flex flex-wrap items-center gap-2 text-amber-400">
              The game page must be open on that device for the reads to count.
              <button type="button" className={`${btn} bg-black/40 text-[var(--pg-text,#e6e6e6)]`} onClick={() => void openGameOnTarget()}>
                Open the game there
              </button>
            </div>
          )}
          {target === 'local' && onPopOut && (
            <button type="button" className={`${btn} bg-black/40`} onClick={onPopOut}>
              Pop out (keep the game screen visible)
            </button>
          )}
        </section>
      )}

      {parallelRuns.length > 0 && (
        <p className="text-amber-400">
          ⚠ A separate simulation of this game is running on: {parallelRuns.join(', ')}. Two separate runs
          double-play every team.
        </p>
      )}
      {otherGame && (
        <p className="text-amber-400">That device is simulating another game (#{status?.launchedGameId}).</p>
      )}
      {remoteStale && (
        <p className="text-amber-400">
          No update from the device for {Math.round((Date.now() - (remoteUpdatedAt ?? 0)) / 1000)} s.
        </p>
      )}
      {error && <p className="text-red-400">{error}</p>}

      <nav className="flex gap-1 border-b border-white/10">
        {(allowRemote
          ? allowLocal
            ? (['controls', 'field', 'journal', 'coverage', 'campaign'] as const)
            : (['controls', 'field', 'journal', 'coverage'] as const)
          : (['controls', 'field', 'journal'] as const)
        ).map((t) => (
          <button
            key={t}
            type="button"
            className={`px-3 py-2 capitalize ${tab === t ? 'border-b-2 border-fuchsia-500 text-fuchsia-300' : 'text-white/60'}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === 'controls' && (
      <>
      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          Seed
          <input
            type="number"
            className={field}
            value={cfg.seed}
            disabled={busy}
            onChange={(e) => setCfg({ ...cfg, seed: num(e.target.value, 0, 2 ** 31) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          Speed
          <div className="flex flex-wrap gap-1">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                className={`${btn} ${cfg.speed === s ? 'bg-fuchsia-600' : 'bg-black/30'}`}
                onClick={() => {
                  setCfg({ ...cfg, speed: s });
                  if (busy) void send({ kind: 'speed', speed: s });
                }}
              >
                ×{s}
              </button>
            ))}
          </div>
        </label>
        <label className="flex flex-col gap-1">
          Teams (auto/self-register games)
          <input
            type="number"
            className={field}
            value={cfg.dynamicTeamCount}
            disabled={busy}
            onChange={(e) => setCfg({ ...cfg, dynamicTeamCount: num(e.target.value, 1, 500) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          Arrival window (min)
          <input
            type="number"
            className={field}
            value={cfg.arrivalWindowMin}
            disabled={busy}
            onChange={(e) => setCfg({ ...cfg, arrivalWindowMin: num(e.target.value, 0, 240) })}
          />
        </label>
      </section>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={cfg.spreadAcrossDevices !== false}
          disabled={busy}
          onChange={(e) => setCfg({ ...cfg, spreadAcrossDevices: e.target.checked })}
        />
        Spread the mock teams over every device of the game (each bips its teams on its own reader)
      </label>

      <section>
        <div className="mb-1">Behaviour mix (weights)</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {(Object.keys(PROFILE_LABELS) as ProfileId[]).map((p) => (
            <label key={p} className="flex flex-col gap-1">
              {PROFILE_LABELS[p]}
              <input
                type="number"
                className={field}
                value={cfg.profileMix[p]}
                disabled={busy}
                onChange={(e) =>
                  setCfg({ ...cfg, profileMix: { ...cfg.profileMix, [p]: num(e.target.value, 0, 100) } })
                }
              />
            </label>
          ))}
        </div>
      </section>
      </>
      )}

      <section className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`${btn} bg-fuchsia-600 disabled:opacity-40`}
          disabled={busy || target === null}
          onClick={start}
        >
          {status?.phase === 'done' || status?.phase === 'stopped' ? 'Replay (same seed)' : 'Start'}
        </button>
        {status?.phase === 'running' && (
          <button type="button" className={`${btn} bg-black/40`} onClick={() => void send({ kind: 'pause' })}>
            Pause
          </button>
        )}
        {status?.phase === 'paused' && !status.pausedByPage && (
          <button type="button" className={`${btn} bg-black/40`} onClick={() => void send({ kind: 'resume' })}>
            Resume
          </button>
        )}
        {(busy || status?.phase === 'done') && (
          <button type="button" className={`${btn} bg-red-700`} onClick={() => void send({ kind: 'stop' })}>
            Stop (back to real time)
          </button>
        )}
        <button
          type="button"
          className={`${btn} sm:ml-auto bg-black/40`}
          disabled={journal.length === 0}
          onClick={() => void exportRun()}
        >
          Export JSON
        </button>
      </section>
      {typeof target === 'number' && (
        <p className="text-xs text-[var(--pg-text-dim,#999)]">
          Remote commands reach the device on its next contact with the mother (a few seconds); the journal shows
          the last 40 reads.
        </p>
      )}

      {exported && <p className="text-xs text-[var(--pg-text-dim,#999)]">{exported}</p>}

      {tab === 'controls' &&
        status &&
        (status.phase === 'done' || status.phase === 'stopped') &&
        status.total > 0 &&
        (allowRemote && gameInfo ? (
          <VerdictForm
            info={gameInfo}
            status={verdictStatus ?? status}
            speed={status.clock?.speed ?? cfg.speed}
            devices={devices.length}
          />
        ) : !allowRemote ? (
          <p className="text-xs text-[var(--pg-text-dim,#999)]">
            Record the verdict from the in-app panel (launched games list → Simulate…).
          </p>
        ) : null)}

      {status && (
        <section className="space-y-1">
          {status.phase !== 'idle' && status.phase !== 'stopped' && (
            <div className={status.pageListening ? 'text-emerald-400' : 'text-amber-400'}>
              ● {status.pageListening ? 'Game page open and listening' : 'Game page not open: bips are held'}
            </div>
          )}
          {status.role && status.role !== 'solo' && (
            <div className="text-sky-300">
              {status.role === 'director' ? 'Directing' : 'Following'} a run over {status.devices ?? '?'} devices
              {runTotals && ` · all devices: ${runTotals.done}/${runTotals.total} reads`}
              {runTotals && runTotals.errors > 0 && ` · ${runTotals.errors} errors`}
            </div>
          )}
          <div>
            {status.role && status.role !== 'solo' ? 'This device: reads' : 'Reads'} {status.done}/{status.total}
            {status.queued > 0 && ` · ${status.queued} waiting at the reader`}
          </div>
          {status.message && <div className="text-red-400">{status.message}</div>}
          {status.warnings.map((w) => (
            <div key={w} className="text-amber-400">⚠ {w}</div>
          ))}
        </section>
      )}

      {tab === 'coverage' && allowRemote && <CoverageTab info={gameInfo} />}
      {tab === 'campaign' && allowRemote && allowLocal && (
        <CampaignTab scenarioUniqid={gameInfo?.scenarioUniqid} gameType={gameInfo?.ga?.gameType} />
      )}

      {tab === 'field' && (
        <section className="border border-white/10 rounded p-2 max-h-[60vh] overflow-auto text-xs bg-black/40">
          <FieldList rows={fieldRows} virtualNow={virtualNow} />
        </section>
      )}
      {tab === 'journal' && (
      <section className="border border-white/10 rounded max-h-[50vh] overflow-auto font-mono text-xs">
        <table className="w-full">
          <thead className="sticky top-0 bg-black/60">
            <tr className="text-left">
              <th className="p-1">Time</th>
              <th className="p-1">Team</th>
              <th className="p-1 hidden sm:table-cell">Profile</th>
              <th className="p-1 hidden sm:table-cell">Punches</th>
              <th className="p-1">What they did</th>
            </tr>
          </thead>
          <tbody>
            {journal
              .slice()
              .reverse()
              .map((e, i) => (
                <tr key={`${e.at}-${journal.length - i}`} className={e.ok ? '' : 'text-red-400'}>
                  <td className="p-1">{fmtTime(e.at)}</td>
                  <td className="p-1">{e.team}</td>
                  <td className="p-1 hidden sm:table-cell">{e.profile}</td>
                  <td className="p-1 hidden sm:table-cell">{e.punches}</td>
                  <td className="p-1">
                    {e.intent}
                    {e.error ? ` - ${e.error}` : ''}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
      )}
    </div>
  );
}

/** Desktop pop-out window (`?simulator=<id>`): local only - no LAN route here. */
export function SimulatorWindow({ launchedGameId }: { launchedGameId: number }) {
  return (
    <div className="min-h-screen bg-[var(--pg-bg,#0b0f14)]">
      <SimulatorPanel launchedGameId={launchedGameId} allowLocal allowRemote={false} />
    </div>
  );
}

/** In-app panel (launched games list): any device of the game, incl. remote. */
export function SimulatorOverlay({
  launchedGameId,
  allowLocal,
  onClose,
  onPopOut,
}: {
  launchedGameId: number;
  allowLocal: boolean;
  onClose: () => void;
  onPopOut?: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[200] overflow-auto bg-[var(--pg-bg,#0b0f14)]">
      <SimulatorPanel
        launchedGameId={launchedGameId}
        allowLocal={allowLocal}
        allowRemote
        onClose={onClose}
        onPopOut={onPopOut}
      />
    </div>
  );
}
