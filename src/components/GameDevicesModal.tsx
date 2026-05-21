// In-game Devices modal shared by GamePage (in-session view) and
// LaunchedGamesList (post-launch detail view).
//
// Three buckets, each in its own section. In-game devices (section A) double
// as targets for operator-triggered video playback: tick checkboxes and use
// the Play/Stop action bar at the top of the section. Available paired
// devices (section B) get a per-row "Launch here" button that queues a
// join_game command via /ping.php pickup (latency up to one ping cycle, ~10s).
// Offline devices (section C) are read-only with relative-time staleness.
//
// The modal polls list_paired_with_status every 2s while open; clicked launch
// rows show a spinner that clears when the device crosses into bucket A on a
// subsequent poll. A 30s timeout reverts the spinner with a retry hint.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, X, Play, StopCircle, Loader2, Usb } from 'lucide-react';
import {
  listPairedWithStatus,
  queueJoinGameCommandBulk,
  queuePlayVideoBulk,
  queueStopVideoBulk,
  type ListPairedWithStatusResp,
  type PairedDeviceStatusRow,
} from '../services/launchedGames';

interface GameDevicesModalProps {
  launchedGameId: number;
  // Used to render the language label on play_video commands. Empty string is
  // accepted; the satellite resolves to its default if absent.
  gameLanguage: string;
  // Only the mother device renders the Launch/Play/Stop action surfaces. On a
  // satellite this is false and the modal is purely read-only.
  isMother: boolean;
  // Whether the scenario / game type advertise an intro / tutorial video.
  // If unknown, default both to true and let the server's per-target result
  // surface a "no asset" error if applicable.
  hasIntro?: boolean;
  hasTutorial?: boolean;
  onClose: () => void;
}

const POLL_MS = 2000;
const LAUNCH_TIMEOUT_MS = 30_000;

export function GameDevicesModal({
  launchedGameId,
  gameLanguage,
  isMother,
  hasIntro = true,
  hasTutorial = true,
  onClose,
}: GameDevicesModalProps) {
  const [buckets, setBuckets] = useState<ListPairedWithStatusResp>({
    in_game: [],
    available_online: [],
    offline: [],
  });
  const [launching, setLaunching] = useState<Set<number>>(new Set());
  const [errorFor, setErrorFor] = useState<Map<number, string>>(new Map());
  const [selectedForVideo, setSelectedForVideo] = useState<Set<number>>(new Set());
  const [videoBusy, setVideoBusy] = useState<Set<number>>(new Set());
  const [playMenuOpen, setPlayMenuOpen] = useState(false);
  const launchTimers = useRef<Map<number, number>>(new Map());

  // Poll loop — fetch every 2s; on each fetch, devices that crossed into
  // section A get their launching-spinner cleared (and their 30s timer).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const next = await listPairedWithStatus(launchedGameId).catch(() => null);
      if (cancelled || !next) return;
      setBuckets(next);
      const inGameIds = new Set(next.in_game.map((r) => r.id));
      setLaunching((prev) => {
        const out = new Set<number>();
        for (const id of prev) {
          if (inGameIds.has(id)) {
            const t = launchTimers.current.get(id);
            if (t) {
              window.clearTimeout(t);
              launchTimers.current.delete(id);
            }
            // Clear any prior error too — the device made it.
            setErrorFor((m) => {
              if (!m.has(id)) return m;
              const n = new Map(m);
              n.delete(id);
              return n;
            });
          } else {
            out.add(id);
          }
        }
        return out;
      });
      // Drop video-busy entries that no longer appear in section A (e.g. the
      // device left the game). Otherwise a stale spinner could persist.
      setVideoBusy((prev) => {
        if (prev.size === 0) return prev;
        const out = new Set<number>();
        for (const id of prev) if (inGameIds.has(id)) out.add(id);
        return out;
      });
      // Drop video-select entries for devices no longer in section A.
      setSelectedForVideo((prev) => {
        if (prev.size === 0) return prev;
        const out = new Set<number>();
        for (const id of prev) if (inGameIds.has(id)) out.add(id);
        return out;
      });
    };
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      for (const t of launchTimers.current.values()) window.clearTimeout(t);
      launchTimers.current.clear();
    };
  }, [launchedGameId]);

  async function onLaunchHere(deviceId: number) {
    setLaunching((s) => {
      const n = new Set(s);
      n.add(deviceId);
      return n;
    });
    setErrorFor((m) => {
      if (!m.has(deviceId)) return m;
      const n = new Map(m);
      n.delete(deviceId);
      return n;
    });
    const timer = window.setTimeout(() => {
      setLaunching((s) => {
        const n = new Set(s);
        n.delete(deviceId);
        return n;
      });
      setErrorFor((m) => new Map(m).set(deviceId, 'No response — retry'));
      launchTimers.current.delete(deviceId);
    }, LAUNCH_TIMEOUT_MS);
    launchTimers.current.set(deviceId, timer);
    try {
      const res = await queueJoinGameCommandBulk([deviceId], launchedGameId);
      const r = res.results[0];
      if (r?.error) {
        window.clearTimeout(timer);
        launchTimers.current.delete(deviceId);
        setLaunching((s) => {
          const n = new Set(s);
          n.delete(deviceId);
          return n;
        });
        setErrorFor((m) => new Map(m).set(deviceId, r.error || 'Failed'));
      }
    } catch (e) {
      window.clearTimeout(timer);
      launchTimers.current.delete(deviceId);
      setLaunching((s) => {
        const n = new Set(s);
        n.delete(deviceId);
        return n;
      });
      setErrorFor((m) => new Map(m).set(deviceId, (e as Error).message));
    }
  }

  async function onPlayVideo(kinds: Array<'intro' | 'tutorial'>) {
    setPlayMenuOpen(false);
    const targets = Array.from(selectedForVideo);
    if (targets.length === 0) return;
    setVideoBusy((s) => {
      const n = new Set(s);
      for (const id of targets) n.add(id);
      return n;
    });
    try {
      await queuePlayVideoBulk(targets, launchedGameId, kinds, gameLanguage);
    } catch (e) {
      const msg = (e as Error).message;
      setErrorFor((m) => {
        const n = new Map(m);
        for (const id of targets) n.set(id, msg);
        return n;
      });
    } finally {
      // Optimistically clear busy after a short beat — there's no per-target
      // ack signal short of the satellite mounting the overlay (we don't track
      // that on the mother). The spinner just shows "in-flight".
      window.setTimeout(() => {
        setVideoBusy((s) => {
          if (s.size === 0) return s;
          const n = new Set(s);
          for (const id of targets) n.delete(id);
          return n;
        });
      }, 1500);
    }
  }

  async function onStopVideo() {
    const targets = Array.from(selectedForVideo);
    if (targets.length === 0) return;
    setVideoBusy((s) => {
      const n = new Set(s);
      for (const id of targets) n.add(id);
      return n;
    });
    try {
      await queueStopVideoBulk(targets, launchedGameId);
    } catch (e) {
      const msg = (e as Error).message;
      setErrorFor((m) => {
        const n = new Map(m);
        for (const id of targets) n.set(id, msg);
        return n;
      });
    } finally {
      window.setTimeout(() => {
        setVideoBusy((s) => {
          if (s.size === 0) return s;
          const n = new Set(s);
          for (const id of targets) n.delete(id);
          return n;
        });
      }, 1500);
    }
  }

  function toggleSelectAll() {
    setSelectedForVideo((prev) => {
      const eligible = buckets.in_game.filter((r) => !r.is_self).map((r) => r.id);
      const allSelected = eligible.every((id) => prev.has(id)) && eligible.length > 0;
      if (allSelected) return new Set();
      return new Set(eligible);
    });
  }

  function toggleOne(deviceId: number) {
    setSelectedForVideo((prev) => {
      const n = new Set(prev);
      if (n.has(deviceId)) n.delete(deviceId);
      else n.add(deviceId);
      return n;
    });
  }

  const inGameSelectableCount = useMemo(
    () => buckets.in_game.filter((r) => !r.is_self).length,
    [buckets.in_game]
  );

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-800 border-2 border-slate-700 rounded-lg p-6 max-w-2xl w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-2xl font-bold text-white flex items-center gap-2">
            <Monitor size={24} className="text-purple-500" />
            Game Devices
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1"
            aria-label="Close"
          >
            <X size={24} />
          </button>
        </div>

        {/* Section A — In this game */}
        <section className="mb-6">
          <SectionHeader title="In this game" count={buckets.in_game.length} dotClass="bg-green-500" />
          {isMother && inGameSelectableCount > 0 && (
            <div className="flex items-center gap-3 mb-3 px-1">
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="w-4 h-4 bg-slate-700 border-slate-600 rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                  checked={
                    selectedForVideo.size > 0 &&
                    buckets.in_game
                      .filter((r) => !r.is_self)
                      .every((r) => selectedForVideo.has(r.id))
                  }
                  onChange={toggleSelectAll}
                />
                Select all
              </label>
              <div className="flex-1" />
              <span className="text-xs text-slate-400">
                {selectedForVideo.size} selected
              </span>
              <div className="relative">
                <button
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg text-sm flex items-center gap-1.5"
                  disabled={selectedForVideo.size === 0}
                  onClick={() => setPlayMenuOpen((v) => !v)}
                >
                  <Play size={14} />
                  Play
                  <span className="text-xs opacity-70">▾</span>
                </button>
                {playMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-10 min-w-[160px]">
                    <PlayMenuItem
                      label="Intro"
                      disabled={!hasIntro}
                      onClick={() => onPlayVideo(['intro'])}
                    />
                    <PlayMenuItem
                      label="Tutorial"
                      disabled={!hasTutorial}
                      onClick={() => onPlayVideo(['tutorial'])}
                    />
                    <PlayMenuItem
                      label="Intro + Tutorial"
                      disabled={!hasIntro || !hasTutorial}
                      onClick={() => onPlayVideo(['intro', 'tutorial'])}
                    />
                  </div>
                )}
              </div>
              <button
                className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg text-sm flex items-center gap-1.5"
                disabled={selectedForVideo.size === 0}
                onClick={onStopVideo}
              >
                <StopCircle size={14} />
                Stop
              </button>
            </div>
          )}
          {buckets.in_game.length === 0 ? (
            <EmptyHint text="No devices have joined this game yet." />
          ) : (
            <ul className="space-y-2">
              {buckets.in_game.map((row) => (
                <li key={row.id}>
                  <InGameRow
                    row={row}
                    selected={selectedForVideo.has(row.id)}
                    onToggle={() => toggleOne(row.id)}
                    canSelect={isMother && !row.is_self}
                    busy={videoBusy.has(row.id)}
                    error={errorFor.get(row.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Section B — Paired, available to launch */}
        <section className="mb-6">
          <SectionHeader
            title="Paired, available to launch"
            count={buckets.available_online.length}
            dotClass="bg-blue-500"
          />
          {buckets.available_online.length === 0 ? (
            <EmptyHint text="No other paired devices are online right now." />
          ) : (
            <ul className="space-y-2">
              {buckets.available_online.map((row) => (
                <li key={row.id}>
                  <AvailableRow
                    row={row}
                    canLaunch={isMother && !row.is_self}
                    launching={launching.has(row.id)}
                    error={errorFor.get(row.id)}
                    onLaunch={() => onLaunchHere(row.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Section C — Paired, offline */}
        <section>
          <SectionHeader
            title="Paired, offline"
            count={buckets.offline.length}
            dotClass="bg-slate-500"
          />
          {buckets.offline.length === 0 ? (
            <EmptyHint text="No offline paired devices." />
          ) : (
            <ul className="space-y-2">
              {buckets.offline.map((row) => (
                <li key={row.id}>
                  <OfflineRow row={row} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  count,
  dotClass,
}: {
  title: string;
  count: number;
  dotClass: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className={`w-2 h-2 rounded-full ${dotClass}`} />
      <h4 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">
        {title}
      </h4>
      <span className="text-xs text-slate-500">({count})</span>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="text-sm text-slate-500 italic px-1">{text}</p>;
}

function PlayMenuItem({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="block w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 disabled:text-slate-500 disabled:hover:bg-transparent disabled:cursor-not-allowed"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function InGameRow({
  row,
  selected,
  onToggle,
  canSelect,
  busy,
  error,
}: {
  row: PairedDeviceStatusRow;
  selected: boolean;
  onToggle: () => void;
  canSelect: boolean;
  busy: boolean;
  error: string | undefined;
}) {
  return (
    <div className="flex items-center gap-3 p-3 bg-slate-900 border border-slate-700 rounded-lg">
      {canSelect && (
        <input
          type="checkbox"
          className="w-4 h-4 bg-slate-700 border-slate-600 rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
          checked={selected}
          onChange={onToggle}
        />
      )}
      <DeviceLabelBlock row={row} />
      <div className="flex-1" />
      <ReaderBadge has={row.has_reader} />
      <OnlineBadge online={row.online} />
      {busy && <Loader2 size={16} className="animate-spin text-blue-400" />}
      {error && (
        <span className="text-xs text-red-400 px-2 py-0.5 bg-red-500/10 rounded">
          {error}
        </span>
      )}
    </div>
  );
}

function AvailableRow({
  row,
  canLaunch,
  launching,
  error,
  onLaunch,
}: {
  row: PairedDeviceStatusRow;
  canLaunch: boolean;
  launching: boolean;
  error: string | undefined;
  onLaunch: () => void;
}) {
  return (
    <div className="flex items-center gap-3 p-3 bg-slate-900 border border-slate-700 rounded-lg">
      <DeviceLabelBlock row={row} />
      <div className="flex-1" />
      <ReaderBadge has={row.has_reader} />
      <OnlineBadge online={row.online} />
      {canLaunch &&
        (launching ? (
          <span className="px-3 py-1.5 bg-slate-700 text-slate-300 rounded-lg text-sm flex items-center gap-1.5">
            <Loader2 size={14} className="animate-spin" />
            Launching…
          </span>
        ) : (
          <button
            onClick={onLaunch}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm"
          >
            Launch here
          </button>
        ))}
      {error && (
        <span className="text-xs text-red-400 px-2 py-0.5 bg-red-500/10 rounded">
          {error}
        </span>
      )}
    </div>
  );
}

function OfflineRow({ row }: { row: PairedDeviceStatusRow }) {
  return (
    <div className="flex items-center gap-3 p-3 bg-slate-900/50 border border-slate-700/50 rounded-lg opacity-70">
      <DeviceLabelBlock row={row} />
      <div className="flex-1" />
      <span className="text-xs text-slate-500">
        last seen {formatStaleness(row.last_seen_at)}
      </span>
    </div>
  );
}

function DeviceLabelBlock({ row }: { row: PairedDeviceStatusRow }) {
  return (
    <div className="min-w-0">
      <div className="text-sm font-medium text-white truncate">
        {row.device_label}
        {row.is_self && <span className="ml-2 text-xs text-slate-500">(this device)</span>}
      </div>
      {row.peer_os && (
        <div className="text-xs text-slate-500 truncate">{row.peer_os}</div>
      )}
    </div>
  );
}

function ReaderBadge({ has }: { has: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
        has ? 'bg-green-500/10 text-green-400' : 'bg-slate-700/50 text-slate-500'
      }`}
      title={has ? 'Reader attached' : 'No reader'}
    >
      <Usb size={12} />
      {has ? 'reader' : 'no reader'}
    </span>
  );
}

function OnlineBadge({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs ${
        online ? 'bg-green-500/10 text-green-400' : 'bg-slate-700/50 text-slate-500'
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          online ? 'bg-green-500' : 'bg-slate-500'
        }`}
      />
      {online ? 'online' : 'offline'}
    </span>
  );
}

function formatStaleness(iso: string | null): string {
  if (!iso) return 'never';
  // The server returns 'YYYY-MM-DD HH:MM:SS' in UTC; parse with a trailing 'Z'.
  const t = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return 'never';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
