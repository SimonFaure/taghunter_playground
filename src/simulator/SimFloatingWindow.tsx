// Game simulator floating mini-window on the game page (tester builds only).
// Draggable + collapsible; shown on every Simulated-session game page (Start /
// New seed when idle) and whenever THIS game is being simulated on this
// device. Talks to the executor directly (same JS context).
// Internal tool - English only.

import { useEffect, useRef, useState } from 'react';
import {
  getFieldSnapshot,
  getLastBip,
  getPlannedPurgeAt,
  getSimStatus,
  simCommand,
  simConfigFromMeta,
  subscribeSimStatus,
} from './executor';
import { getLaunchedGameMeta } from '../services/launchedGames';
import { FieldList } from './FieldList';
import { CampaignStrip, useCampaign } from './CampaignPanel';
import { useGameInfo } from './CoveragePanels';
import type { SimStatus } from './types';

const POS_KEY = 'sim.floating.pos';
const COLLAPSED_KEY = 'sim.floating.collapsed';
const CONFIG_OPEN_KEY = 'sim.floating.configOpen';
/** How long the "SIM bip" chip stays up after a simulated bip (real ms). */
const BIP_FLASH_MS = 4000;

function readPos(): { x: number; y: number } {
  try {
    const v = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null');
    if (v && typeof v.x === 'number' && typeof v.y === 'number') return v;
  } catch {
    /* storage unavailable */
  }
  return { x: 16, y: 80 };
}

function clampToViewport(p: { x: number; y: number }) {
  return {
    x: Math.min(Math.max(0, p.x), Math.max(0, window.innerWidth - 120)),
    y: Math.min(Math.max(0, p.y), Math.max(0, window.innerHeight - 40)),
  };
}

export function SimFloatingWindow({ launchedGameId }: { launchedGameId: number }) {
  const [status, setStatus] = useState<SimStatus>(getSimStatus());
  const [pos, setPos] = useState(() => clampToViewport(readPos()));
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [, tick] = useState(0);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [configOpen, setConfigOpen] = useState(() => {
    try {
      return localStorage.getItem(CONFIG_OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => subscribeSimStatus(setStatus), []);
  const campaign = useCampaign();
  // Is this a Simulated session? Then the window stays up even when idle, so a
  // run can be started (or replayed) without leaving the game page.
  const [meta, setMeta] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    getLaunchedGameMeta(launchedGameId)
      .then((m) => !cancelled && setMeta(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [launchedGameId]);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);

  const launchDevices = Number(meta?.simDevices) || status.devices || 1;
  const info = useGameInfo(launchedGameId, launchDevices);

  const mine = status.launchedGameId === launchedGameId;
  const live = mine && status.phase !== 'idle' && status.phase !== 'stopped';
  const simulatedGame = meta?.simulated === 'true';
  if (!live && !simulatedGame) return null;
  const busyElsewhere =
    !mine && (status.phase === 'running' || status.phase === 'paused' || status.phase === 'opening');
  // A campaign ends this game and moves on by itself: no replay over it.
  const campaignGame =
    campaign?.current !== null && campaign?.current !== undefined && campaign.items[campaign.current]?.launchedGameId === launchedGameId;
  const canStart = !busyElsewhere && !campaignGame && (!live || status.phase === 'done' || status.phase === 'error');
  const start = (freshSeed: boolean) => {
    const cfg = simConfigFromMeta(launchedGameId, meta ?? {});
    if (freshSeed) cfg.seed = Math.floor(Math.random() * 1_000_000);
    else if (mine && status.seed !== undefined) cfg.seed = status.seed;
    simCommand({ kind: 'start', config: cfg });
  };

  const clock = status.clock;
  const field = getFieldSnapshot();
  const bip = getLastBip();
  const flashing = bip && Date.now() - bip.realAt < BIP_FLASH_MS;
  const virtualNow = clock
    ? clock.virtualAnchor + ((clock.pausedAt ?? Date.now()) - clock.realAnchor) * clock.speed
    : null;

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPos(clampToViewport({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }));
  };
  const onPointerUp = () => {
    drag.current = null;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {
      /* storage unavailable */
    }
  };
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !c;
    });
  };

  const toggleConfig = () => {
    setConfigOpen((o) => {
      try {
        localStorage.setItem(CONFIG_OPEN_KEY, o ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !o;
    });
  };
  let simSpec: { speed?: number; seed?: number; dynamicTeamCount?: number; clashPurgeAtMin?: number } = {};
  try {
    simSpec = meta?.simAutoStart ? JSON.parse(meta.simAutoStart) : {};
  } catch {
    simSpec = {};
  }
  const durationMin = parseInt(meta?.duration ?? '0', 10) || 0;
  const dynamicTeams = info?.combo?.registration === 'auto' || info?.combo?.registration === 'self';

  const btn = 'px-2 py-1 rounded text-xs';
  return (
    <div
      className="fixed z-[150] w-[340px] max-w-[calc(100vw-16px)] rounded-lg border border-fuchsia-500/60 bg-black/85 text-[#e6e6e6] text-xs shadow-xl select-none"
      style={{ left: pos.x, top: pos.y }}
    >
      <div
        className="flex items-center gap-2 px-2 py-1.5 cursor-move bg-fuchsia-700/40 rounded-t-lg touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span className="font-semibold text-fuchsia-300">SIM ×{clock?.speed ?? 1}</span>
        <span className="font-mono">{virtualNow ? new Date(virtualNow).toLocaleTimeString() : ''}</span>
        <span className="ml-auto">{live ? status.phase : 'ready'}</span>
        <button
          type="button"
          className="px-1"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={toggle}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      {!collapsed && meta && (
        <div className="px-2 pt-2">
          <button
            type="button"
            className="w-full text-left text-fuchsia-300 font-semibold"
            onClick={toggleConfig}
          >
            {configOpen ? '▾' : '▸'} Config
            {info && <span className="ml-1 font-normal text-white/60">· {info.gameType}</span>}
          </button>
          {configOpen && (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 max-h-[35vh] overflow-auto pr-1">
              {info && (
                <>
                  <dt className="text-white/50">Scenario</dt>
                  <dd className="truncate" title={info.scenarioTitle}>
                    {info.scenarioTitle}
                  </dd>
                </>
              )}
              <dt className="text-white/50">Game duration</dt>
              <dd>{durationMin > 0 ? `${durationMin} min` : 'no time limit'}</dd>
              {info?.ga && info.combo
                ? info.ga.axes.map((a) => (
                    <div key={a.id} className="contents">
                      <dt className="text-white/50">{a.label}</dt>
                      <dd>{a.values.find((v) => v.v === info.combo![a.id])?.label ?? info.combo![a.id]}</dd>
                    </div>
                  ))
                : info && (
                    <>
                      <dt className="text-white/50">Options</dt>
                      <dd className="text-amber-400">no coverage axes for {info.gameType}</dd>
                    </>
                  )}
              <dt className="text-white/50">Simulation</dt>
              <dd>
                ×{clock?.speed ?? simSpec.speed ?? 10}
                {` · seed ${mine && status.seed !== undefined ? status.seed : simSpec.seed ?? '-'}`}
                {dynamicTeams && ` · ${status.teams ?? simSpec.dynamicTeamCount ?? 10} mock teams`}
              </dd>
              {info?.combo?.purge === 'on' && (
                <>
                  <dt className="text-white/50">Planned Purge</dt>
                  <dd>
                    {simSpec.clashPurgeAtMin ? `${simSpec.clashPurgeAtMin} min after Start` : 'random (25-60 %)'}
                    {mine && getPlannedPurgeAt() !== undefined &&
                      ` · at ${new Date(getPlannedPurgeAt()!).toLocaleTimeString()}`}
                  </dd>
                </>
              )}
              <dt className="text-white/50">Devices</dt>
              <dd>
                {launchDevices} launched
                {mine && status.devices !== undefined && status.devices !== launchDevices && ` · ${status.devices} playing`}
              </dd>
            </dl>
          )}
        </div>
      )}
      {!collapsed && campaign && (
        <div className="px-2 pt-2">
          <CampaignStrip compact />
        </div>
      )}
      {!collapsed && !live && !campaignGame && (
        <div className="p-2 space-y-1.5">
          {busyElsewhere ? (
            <div className="text-amber-400">Another game (#{status.launchedGameId}) is being simulated here.</div>
          ) : (
            <>
              <div className="text-white/70">
                Simulated session: start the mock teams here
                {meta?.simAutoStart ? ' (launch settings)' : ''}.
              </div>
              <div className="flex gap-1">
                <button type="button" className={`${btn} bg-fuchsia-600`} onClick={() => start(false)}>
                  {mine && status.seed !== undefined ? 'Replay (same seed)' : 'Start simulation'}
                </button>
                <button type="button" className={`${btn} bg-white/10`} onClick={() => start(true)}>
                  New seed
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {!collapsed && live && (
        <div className="p-2 space-y-1.5">
          <div className={status.pageListening ? 'text-emerald-400' : 'text-amber-400'}>
            ● {status.pageListening ? 'Listening' : 'Not listening'}
          </div>
          <div>
            Reads {status.done}/{status.total}
            {status.queued > 0 && ` · ${status.queued} at the reader`}
          </div>
          {status.message && <div className="text-amber-400">{status.message}</div>}
          {flashing && (
            <div className="rounded bg-fuchsia-600/80 px-2 py-1 font-semibold">
              SIM bip: {bip.team} · {bip.intent}
            </div>
          )}
          <div className="max-h-[45vh] overflow-auto pr-1 border-t border-white/10 pt-1.5">
            <FieldList rows={field} virtualNow={virtualNow} compact />
          </div>
          <div className="flex gap-1 pt-1">
            {status.phase === 'running' && (
              <button type="button" className={`${btn} bg-white/10`} onClick={() => simCommand({ kind: 'pause' })}>
                Pause
              </button>
            )}
            {status.phase === 'paused' && !status.pausedByPage && (
              <button type="button" className={`${btn} bg-white/10`} onClick={() => simCommand({ kind: 'resume' })}>
                Resume
              </button>
            )}
            {canStart && (
              <>
                <button type="button" className={`${btn} bg-fuchsia-600`} onClick={() => start(false)}>
                  Replay
                </button>
                <button type="button" className={`${btn} bg-white/10`} onClick={() => start(true)}>
                  New seed
                </button>
              </>
            )}
            <button type="button" className={`${btn} bg-red-700 ml-auto`} onClick={() => simCommand({ kind: 'stop' })}>
              Stop
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
