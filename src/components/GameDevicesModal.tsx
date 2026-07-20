// In-game Devices modal shared by GamePage (in-session view) and
// LaunchedGamesList (post-launch detail view).
//
// Three buckets, each in its own section. In-game devices (section A) double
// as targets for operator-triggered video playback: tick checkboxes and use
// the Play/Stop action bar at the top of the section. Each also carries a
// "Reconnect" button that re-pushes the same join_game command, pulling a
// device that drifted away (to a ranking / idle / another game's screen) back
// into this game's page. Available paired devices (section B) get a per-row
// "Launch here" button that queues a join_game command via /ping.php pickup
// (latency up to one ping cycle, ~10s). Offline devices (section C) are
// read-only with relative-time staleness.
//
// The modal polls list_paired_with_status every 2s while open; clicked launch
// rows show a spinner that clears when the device crosses into bucket A on a
// subsequent poll. A 30s timeout reverts the spinner with a retry hint.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, X, Play, StopCircle, Loader2, Usb, Trophy, Gamepad2, Moon, RefreshCw, LogOut } from 'lucide-react';
import {
  listPairedWithStatus,
  queueJoinGameCommandBulk,
  queuePlayVideoBulk,
  queueStopVideoBulk,
  queueDisconnectDeviceBulk,
  getLaunchedGameState,
  getLaunchedGameMeta,
  mergeLaunchedGameMeta,
  broadcastConfigReload,
  type ListPairedWithStatusResp,
  type PairedDeviceStatusRow,
} from '../services/launchedGames';
import { emitPendingConfigReload } from '../services/pendingJoinStore';
// Station-based registration assignments (Clash 'self' / TagQuest team mode):
// while the game is still registering, the mother can re-pin each in-game
// device to specific team(s) here - pushed live via reload_config.
// Design: project_selfregister_team_device_assignment.
import {
  parseRegAssignments,
  serializeRegAssignments,
  REG_ASSIGNMENTS_META_KEY,
  type RegAssignmentMap,
} from '../services/regAssignments';
import { RegAssignChips, type RegTeamDef } from './RegAssignChips';
import { displayDeviceLabel } from '../services/lanPairing';
import {
  subscribeScreenState,
  type ScreenState,
} from '../services/screenState';
import { HelpDot } from '../help';
import { GameLockGate } from './GameLockGate';
import { getDeviceLockState, type LockReason } from '../services/deviceLock';

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
  // Whether to surface the per-device video play/stop controls inside this
  // modal. The in-session GamePage keeps them here; the launched-games list
  // sets this false and exposes video in a dedicated <GameVideoModal> instead.
  showVideoControls?: boolean;
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
  showVideoControls = true,
  onClose,
}: GameDevicesModalProps) {
  const { t } = useTranslation();
  const [buckets, setBuckets] = useState<ListPairedWithStatusResp>({
    in_game: [],
    available_online: [],
    offline: [],
  });
  const [launching, setLaunching] = useState<Set<number>>(new Set());
  // Per-device "join_game re-pushed" spinner for the in-game Reconnect button.
  // Unlike `launching` (cleared when the device crosses into bucket A), an
  // already-in-game device never crosses in, so there is no transition signal
  // to watch - clear optimistically after a short beat, like the video calls.
  const [reconnecting, setReconnecting] = useState<Set<number>>(new Set());
  // Per-device "disconnect pushed" spinner. Like reconnecting, there's no
  // crossing-bucket signal to watch (the row leaves section A on the next poll
  // once the mother drops its registration), so clear optimistically.
  const [disconnecting, setDisconnecting] = useState<Set<number>>(new Set());
  const [errorFor, setErrorFor] = useState<Map<number, string>>(new Map());
  const [selectedForVideo, setSelectedForVideo] = useState<Set<number>>(new Set());
  const [videoBusy, setVideoBusy] = useState<Set<number>>(new Set());
  const [playMenuOpen, setPlayMenuOpen] = useState(false);
  const launchTimers = useRef<Map<number, number>>(new Map());
  // Device-lock gate (emergency-disabled / past billing grace): launching a game
  // on another device is a privileged action, so a locked device must clear the
  // recovery-code gate first. A reprieve re-runs the attempted launch.
  const [lockGate, setLockGate] = useState<{ reason: Exclude<LockReason, null>; run: () => void } | null>(null);
  const blockedByLock = async (run: () => void): Promise<boolean> => {
    const lock = await getDeviceLockState();
    if (lock.locked && lock.reason) {
      setLockGate({ reason: lock.reason, run });
      return true;
    }
    return false;
  };

  // This (mother) device never pings itself, so its own row carries no
  // server-reported screen_state. Read it from the local store instead, live.
  const [selfState, setSelfState] = useState<ScreenState | null>(null);
  useEffect(() => subscribeScreenState(setSelfState), []);

  // Registration-station assignments: non-null only while the game is a
  // still-registering station-based self-register launch (Clash 'self' /
  // TagQuest team mode) - the per-device team chips render in section A then.
  const [regCtx, setRegCtx] = useState<{ teams: RegTeamDef[]; map: RegAssignmentMap } | null>(null);
  // Serialise saves: mergeLaunchedGameMeta is read-merge-write, so concurrent
  // toggles could clobber each other. One in-flight save at a time.
  const [regSaving, setRegSaving] = useState(false);
  useEffect(() => {
    if (!isMother) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const state = await getLaunchedGameState(launchedGameId, 0);
        const gt = state.game_type?.toLowerCase();
        if (!state.started && !state.ended && (gt === 'clash' || gt === 'tagquest')) {
          const meta = await getLaunchedGameMeta(launchedGameId);
          const qualifies =
            gt === 'clash'
              ? (meta.clashRegistrationMode ?? 'self') === 'self'
              : meta.tagquestSelfRegister === 'true' && meta.playMode === 'team';
          if (qualifies) {
            const teams: RegTeamDef[] = state.teams
              .slice()
              .sort((a, b) => a.team_number - b.team_number)
              .map((t) => ({ number: t.team_number, name: t.team_name || `Équipe ${t.team_number}` }));
            if (!cancelled) {
              setRegCtx({ teams, map: parseRegAssignments(meta[REG_ASSIGNMENTS_META_KEY]) });
            }
            return;
          }
        }
        if (!cancelled) setRegCtx(null);
      } catch {
        /* transient - next tick retries */
      }
    };
    void tick();
    const h = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(h);
    };
  }, [launchedGameId, isMother]);

  async function onToggleRegTeam(deviceId: number, teamNumber: number) {
    if (!regCtx || regSaving) return;
    const cur = regCtx.map[deviceId] ?? [];
    const nextTeams = cur.includes(teamNumber)
      ? cur.filter((n) => n !== teamNumber)
      : [...cur, teamNumber].sort((a, b) => a - b);
    const nextMap: RegAssignmentMap = { ...regCtx.map };
    if (nextTeams.length > 0) nextMap[deviceId] = nextTeams;
    else delete nextMap[deviceId];
    setRegCtx({ ...regCtx, map: nextMap }); // optimistic - the 5s tick reconciles
    setRegSaving(true);
    try {
      await mergeLaunchedGameMeta(launchedGameId, {
        [REG_ASSIGNMENTS_META_KEY]: serializeRegAssignments(nextMap),
      });
      // Satellites re-read via reload_config; the mother's own game page gets
      // the local emit (the broadcast excludes self).
      await broadcastConfigReload(launchedGameId);
      emitPendingConfigReload(launchedGameId);
    } catch (err) {
      console.error('[GameDevicesModal] reg-assignment save failed:', err);
    } finally {
      setRegSaving(false);
    }
  }

  // Resolve the screen state to render for a row: the local store for the self
  // row, the server-reported value for every peer.
  const stateForRow = (row: PairedDeviceStatusRow): ScreenState | null =>
    row.is_self ? selfState : row.screen_state ?? null;

  // Poll loop - fetch every 2s; on each fetch, devices that crossed into
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
            // Clear any prior error too - the device made it.
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
    if (await blockedByLock(() => void onLaunchHere(deviceId))) return;
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
      setErrorFor((m) => new Map(m).set(deviceId, t('devicesModal:errorNoResponse')));
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
        setErrorFor((m) => new Map(m).set(deviceId, r.error || t('devicesModal:errorFailed')));
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

  // Re-push join_game to a device that's already in this game but has drifted
  // off the game page. Same command as "Launch here"; the satellite navigates
  // back to the GamePage no matter what it's currently showing.
  async function onReconnect(deviceId: number) {
    if (await blockedByLock(() => void onReconnect(deviceId))) return;
    setReconnecting((s) => new Set(s).add(deviceId));
    setErrorFor((m) => {
      if (!m.has(deviceId)) return m;
      const n = new Map(m);
      n.delete(deviceId);
      return n;
    });
    try {
      const res = await queueJoinGameCommandBulk([deviceId], launchedGameId, { rejoin: true });
      const r = res.results[0];
      if (r?.error) {
        setErrorFor((m) => new Map(m).set(deviceId, r.error || t('devicesModal:errorFailed')));
      }
    } catch (e) {
      setErrorFor((m) => new Map(m).set(deviceId, (e as Error).message));
    } finally {
      // No per-target ack short of the satellite re-mounting the game page; the
      // spinner just marks the push as in-flight, then clears.
      window.setTimeout(() => {
        setReconnecting((s) => {
          if (!s.has(deviceId)) return s;
          const n = new Set(s);
          n.delete(deviceId);
          return n;
        });
      }, 1500);
    }
  }

  // Remove a device from this game: the mother drops its participation row and
  // pushes a command telling it to leave the in-game page. The row leaves
  // section A on the next poll once the mother-side registration is gone.
  async function onDisconnect(deviceId: number) {
    if (await blockedByLock(() => void onDisconnect(deviceId))) return;
    setDisconnecting((s) => new Set(s).add(deviceId));
    setErrorFor((m) => {
      if (!m.has(deviceId)) return m;
      const n = new Map(m);
      n.delete(deviceId);
      return n;
    });
    try {
      const res = await queueDisconnectDeviceBulk([deviceId], launchedGameId);
      const r = res.results[0];
      if (r?.error) {
        setErrorFor((m) => new Map(m).set(deviceId, r.error || t('devicesModal:errorFailed')));
      }
    } catch (e) {
      setErrorFor((m) => new Map(m).set(deviceId, (e as Error).message));
    } finally {
      window.setTimeout(() => {
        setDisconnecting((s) => {
          if (!s.has(deviceId)) return s;
          const n = new Set(s);
          n.delete(deviceId);
          return n;
        });
      }, 1500);
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
      // Optimistically clear busy after a short beat - there's no per-target
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
    <>
    <div
      className="pg-overlay p-4"
      onClick={onClose}
    >
      <div
        className="bg-[var(--pg-surface)] border-2 border-[var(--pg-line-strong)] rounded-[var(--pg-radius-lg)] p-6 max-w-2xl w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-2xl font-bold text-[var(--pg-text)] flex items-center gap-2">
            <Monitor size={24} className="text-purple-500" />
            {t('devicesModal:title')}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="pg-modal-close"
              aria-label={t('devicesModal:close')}
            >
              <X size={24} />
            </button>
          </div>
        </div>

        {/* Section A - In this game */}
        <section className="mb-6">
          <SectionHeader title={t('devicesModal:sectionInGame')} count={buckets.in_game.length} dotClass="bg-green-500" helpDot={<HelpDot topic="devices.bucket-in-game" />} />
          {isMother && showVideoControls && buckets.in_game.length > 0 && (
            <div className="flex items-center gap-3 mb-3 px-1 flex-wrap">
              {inGameSelectableCount > 0 ? (
                <label className="flex items-center gap-2 text-sm text-[var(--pg-text-muted)] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-[var(--pg-accent)]"
                    checked={
                      selectedForVideo.size > 0 &&
                      buckets.in_game
                        .filter((r) => !r.is_self)
                        .every((r) => selectedForVideo.has(r.id))
                    }
                    onChange={toggleSelectAll}
                  />
                  {t('devicesModal:selectAll')}
                </label>
              ) : (
                <span className="text-xs text-[var(--pg-text-dim)] italic">
                  {t('devicesModal:addSatelliteHint')}
                </span>
              )}
              <div className="flex-1" />
              <span className="text-xs text-[var(--pg-text-dim)]">
                {t('devicesModal:selectedCount', { count: selectedForVideo.size })}
              </span>
              <div className="relative">
                <button
                  className="px-3 py-1.5 bg-[var(--pg-accent)] hover:bg-[var(--pg-accent-hover)] disabled:bg-[var(--pg-surface-3)] disabled:text-[var(--pg-text-dim)] text-white rounded-[var(--pg-radius-md)] text-sm flex items-center gap-1.5"
                  disabled={selectedForVideo.size === 0}
                  title={
                    inGameSelectableCount === 0
                      ? t('devicesModal:playTitleNoSatellites')
                      : selectedForVideo.size === 0
                        ? t('devicesModal:playTitleTickOne')
                        : t('devicesModal:playTitlePick')
                  }
                  onClick={() => setPlayMenuOpen((v) => !v)}
                >
                  <Play size={14} />
                  {t('devicesModal:play')}
                  <span className="text-xs opacity-70">▾</span>
                </button>
                {playMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] shadow-xl z-10 min-w-[160px]">
                    <PlayMenuItem
                      label={t('devicesModal:videoIntro')}
                      disabled={!hasIntro}
                      onClick={() => onPlayVideo(['intro'])}
                    />
                    <PlayMenuItem
                      label={t('devicesModal:videoTutorial')}
                      disabled={!hasTutorial}
                      onClick={() => onPlayVideo(['tutorial'])}
                    />
                    <PlayMenuItem
                      label={t('devicesModal:videoIntroTutorial')}
                      disabled={!hasIntro || !hasTutorial}
                      onClick={() => onPlayVideo(['intro', 'tutorial'])}
                    />
                  </div>
                )}
              </div>
              <HelpDot topic="devices.play" />
              <button
                className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 disabled:bg-[var(--pg-surface-3)] disabled:text-[var(--pg-text-dim)] text-white rounded-[var(--pg-radius-md)] text-sm flex items-center gap-1.5"
                disabled={selectedForVideo.size === 0}
                title={
                  selectedForVideo.size === 0
                    ? t('devicesModal:playTitleTickOne')
                    : t('devicesModal:stopTitle')
                }
                onClick={onStopVideo}
              >
                <StopCircle size={14} />
                {t('devicesModal:stop')}
              </button>
              <HelpDot topic="devices.stop" />
            </div>
          )}
          {buckets.in_game.length === 0 ? (
            <EmptyHint text={t('devicesModal:emptyInGame')} />
          ) : (
            <ul className="space-y-2">
              {buckets.in_game.map((row) => (
                <li key={row.id}>
                  <InGameRow
                    row={row}
                    state={stateForRow(row)}
                    thisGameId={launchedGameId}
                    selected={selectedForVideo.has(row.id)}
                    onToggle={() => toggleOne(row.id)}
                    canSelect={isMother && showVideoControls && !row.is_self}
                    canReconnect={isMother && !row.is_self}
                    reconnecting={reconnecting.has(row.id)}
                    onReconnect={() => onReconnect(row.id)}
                    canDisconnect={isMother && !row.is_self}
                    disconnecting={disconnecting.has(row.id)}
                    onDisconnect={() => onDisconnect(row.id)}
                    busy={videoBusy.has(row.id)}
                    error={errorFor.get(row.id)}
                  />
                  {isMother && regCtx && regCtx.teams.length > 0 && (
                    <div className="mt-1 mb-1 flex flex-wrap items-center gap-2 px-3">
                      <span className="text-xs text-[var(--pg-text-dim)] shrink-0">
                        {t('devicesModal:regAssignLabel')}
                      </span>
                      <RegAssignChips
                        teams={regCtx.teams}
                        value={regCtx.map[row.id] ?? []}
                        onToggle={(n) => void onToggleRegTeam(row.id, n)}
                        disabled={regSaving}
                        trailing={
                          (regCtx.map[row.id]?.length ?? 0) === 0 ? (
                            <span className="text-xs italic text-[var(--pg-text-dim)]">
                              {t('devicesModal:regAssignAllTeams')}
                            </span>
                          ) : undefined
                        }
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Section B - Paired, available to launch */}
        <section className="mb-6">
          <SectionHeader
            title={t('devicesModal:sectionAvailable')}
            count={buckets.available_online.length}
            dotClass="bg-[var(--pg-accent)]"
            helpDot={<HelpDot topic="devices.bucket-available" />}
          />
          {buckets.available_online.length === 0 ? (
            <EmptyHint text={t('devicesModal:emptyAvailable')} />
          ) : (
            <ul className="space-y-2">
              {buckets.available_online.map((row) => (
                <li key={row.id}>
                  <AvailableRow
                    row={row}
                    state={stateForRow(row)}
                    thisGameId={launchedGameId}
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

        {/* Section C - Paired, offline */}
        <section>
          <SectionHeader
            title={t('devicesModal:sectionOffline')}
            count={buckets.offline.length}
            dotClass="bg-[var(--pg-text-dim)]"
            helpDot={<HelpDot topic="devices.bucket-offline" />}
          />
          {buckets.offline.length === 0 ? (
            <EmptyHint text={t('devicesModal:emptyOffline')} />
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

    {lockGate && (
      <GameLockGate
        reason={lockGate.reason}
        onReprieve={() => {
          const run = lockGate.run;
          setLockGate(null);
          run();
        }}
        onClose={() => setLockGate(null)}
      />
    )}
    </>
  );
}

function SectionHeader({
  title,
  count,
  dotClass,
  helpDot,
}: {
  title: string;
  count: number;
  dotClass: string;
  helpDot?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className={`w-2 h-2 rounded-full ${dotClass}`} />
      <h4 className="text-sm font-semibold text-[var(--pg-text-muted)] uppercase tracking-wide">
        {title}
      </h4>
      <span className="text-xs text-[var(--pg-text-dim)]">({count})</span>
      {helpDot}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="text-sm text-[var(--pg-text-dim)] italic px-1">{text}</p>;
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
      className="block w-full text-left px-3 py-2 text-sm text-[var(--pg-text)] hover:bg-[var(--pg-surface-3)] disabled:text-[var(--pg-text-dim)] disabled:hover:bg-transparent disabled:cursor-not-allowed"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function InGameRow({
  row,
  state,
  thisGameId,
  selected,
  onToggle,
  canSelect,
  canReconnect,
  reconnecting,
  onReconnect,
  canDisconnect,
  disconnecting,
  onDisconnect,
  busy,
  error,
}: {
  row: PairedDeviceStatusRow;
  state: ScreenState | null;
  thisGameId: number;
  selected: boolean;
  onToggle: () => void;
  canSelect: boolean;
  canReconnect: boolean;
  reconnecting: boolean;
  onReconnect: () => void;
  canDisconnect: boolean;
  disconnecting: boolean;
  onDisconnect: () => void;
  busy: boolean;
  error: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 p-3 bg-[var(--pg-bg)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)]">
      {canSelect && (
        <input
          type="checkbox"
          className="w-4 h-4 accent-[var(--pg-accent)]"
          checked={selected}
          onChange={onToggle}
        />
      )}
      <DeviceLabelBlock row={row} />
      <div className="flex-1" />
      <StatePill state={state} thisGameId={thisGameId} />
      <ReaderBadge has={row.has_reader} />
      <OnlineBadge online={row.online} />
      {busy && <Loader2 size={16} className="animate-spin text-[var(--pg-accent-bright)]" />}
      {canReconnect &&
        (reconnecting ? (
          <span className="p-2 bg-[var(--pg-surface-3)] text-[var(--pg-text-muted)] rounded-[var(--pg-radius-md)] flex items-center">
            <Loader2 size={16} className="animate-spin" />
          </span>
        ) : (
          <button
            onClick={onReconnect}
            disabled={!row.online}
            title={row.online ? t('devicesModal:reconnectTitle') : t('devicesModal:reconnectOfflineTitle')}
            aria-label={t('devicesModal:reconnect')}
            className="p-2 bg-[var(--pg-surface-2)] hover:bg-[var(--pg-surface-3)] disabled:opacity-40 disabled:hover:bg-[var(--pg-surface-2)] text-[var(--pg-text)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] flex items-center"
          >
            <RefreshCw size={16} />
          </button>
        ))}
      {canDisconnect &&
        (disconnecting ? (
          <span className="p-2 bg-[var(--pg-surface-3)] text-[var(--pg-text-muted)] rounded-[var(--pg-radius-md)] flex items-center">
            <Loader2 size={16} className="animate-spin" />
          </span>
        ) : (
          <button
            onClick={onDisconnect}
            title={t('devicesModal:disconnectTitle')}
            aria-label={t('devicesModal:disconnect')}
            className="p-2 bg-red-600/10 hover:bg-red-600/20 text-red-400 border border-red-600/30 rounded-[var(--pg-radius-md)] flex items-center"
          >
            <LogOut size={16} />
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

function AvailableRow({
  row,
  state,
  thisGameId,
  canLaunch,
  launching,
  error,
  onLaunch,
}: {
  row: PairedDeviceStatusRow;
  state: ScreenState | null;
  thisGameId: number;
  canLaunch: boolean;
  launching: boolean;
  error: string | undefined;
  onLaunch: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 p-3 bg-[var(--pg-bg)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)]">
      <DeviceLabelBlock row={row} />
      <div className="flex-1" />
      <StatePill state={state} thisGameId={thisGameId} />
      <ReaderBadge has={row.has_reader} />
      <OnlineBadge online={row.online} />
      {canLaunch &&
        (launching ? (
          <span className="px-3 py-1.5 bg-[var(--pg-surface-3)] text-[var(--pg-text-muted)] rounded-[var(--pg-radius-md)] text-sm flex items-center gap-1.5">
            <Loader2 size={14} className="animate-spin" />
            {t('devicesModal:launching')}
          </span>
        ) : (
          <button
            onClick={onLaunch}
            className="px-3 py-1.5 bg-[var(--pg-accent)] hover:bg-[var(--pg-accent-hover)] text-white rounded-[var(--pg-radius-md)] text-sm"
          >
            {t('devicesModal:launchHere')}
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
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 p-3 bg-[var(--pg-bg)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] opacity-70">
      <DeviceLabelBlock row={row} />
      <div className="flex-1" />
      <span className="text-xs text-[var(--pg-text-dim)]">
        {t('devicesModal:lastSeen', { time: formatStaleness(row.last_seen_at, t) })}
      </span>
    </div>
  );
}

function DeviceLabelBlock({ row }: { row: PairedDeviceStatusRow }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0">
      <div className="text-sm font-medium text-[var(--pg-text)] truncate">
        {displayDeviceLabel(row.device_label) ||
          (row.is_self ? t('devicesModal:thisDeviceName') : t('devicesModal:unknownDevice'))}
        {row.is_self && displayDeviceLabel(row.device_label) != null && (
          <span className="ml-2 text-xs text-[var(--pg-text-dim)]">{t('devicesModal:thisDevice')}</span>
        )}
      </div>
      {row.peer_os && (
        <div className="text-xs text-[var(--pg-text-dim)] truncate">{row.peer_os}</div>
      )}
    </div>
  );
}

// The live "what's it showing" pill. Honest silence (renders nothing) when the
// peer hasn't reported a state - never a guessed "idle". The game name is shown
// only when the device is in a DIFFERENT launched game than this modal's; for
// this game (or no id) the bucket already conveys that, so the pill stays plain.
function StatePill({
  state,
  thisGameId,
}: {
  state: ScreenState | null;
  thisGameId: number;
}) {
  const { t } = useTranslation();
  if (!state) return null;

  let label: string;
  let cls: string;
  let icon: React.ReactNode;
  let title: string | undefined;

  switch (state.kind) {
    case 'ranking':
      label = t('devicesModal:stateRanking');
      cls = 'bg-amber-500/10 text-amber-400';
      icon = <Trophy size={12} />;
      break;
    case 'video':
      label = t('devicesModal:stateVideo');
      cls = 'bg-blue-500/10 text-blue-400';
      icon = <Play size={12} />;
      break;
    case 'home':
      label = t('devicesModal:stateIdle');
      cls = 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)]';
      icon = <Moon size={12} />;
      break;
    case 'in_game': {
      // Within-game sub-screen (instructions / reveal) demoted to a tooltip.
      title =
        state.sub === 'instructions'
          ? t('devicesModal:stateSubInstructions')
          : state.sub === 'reveal'
            ? t('devicesModal:stateSubReveal')
            : undefined;
      if (state.boardHidden) {
        label = t('devicesModal:stateInGameIdleScreen');
        cls = 'bg-green-500/5 text-green-300';
        icon = <Moon size={12} />;
      } else if (state.launchedGameId != null && state.launchedGameId !== thisGameId) {
        label = t('devicesModal:stateInGameOther', { name: state.gameName ?? '' });
        cls = 'bg-amber-500/10 text-amber-400';
        icon = <Gamepad2 size={12} />;
      } else {
        label = t('devicesModal:stateInGame');
        cls = 'bg-green-500/10 text-green-400';
        icon = <Gamepad2 size={12} />;
      }
      break;
    }
  }

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${cls}`}
      title={title}
    >
      {icon}
      {label}
    </span>
  );
}

function ReaderBadge({ has }: { has: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
        has ? 'bg-green-500/10 text-green-400' : 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)]'
      }`}
      title={has ? t('devicesModal:readerAttached') : t('devicesModal:noReaderTitle')}
    >
      <Usb size={12} />
      {has ? t('devicesModal:reader') : t('devicesModal:noReader')}
    </span>
  );
}

function OnlineBadge({ online }: { online: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs ${
        online ? 'bg-green-500/10 text-green-400' : 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)]'
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          online ? 'bg-green-500' : 'bg-[var(--pg-text-dim)]'
        }`}
      />
      {online ? t('devicesModal:online') : t('devicesModal:offline')}
    </span>
  );
}

function formatStaleness(iso: string | null, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!iso) return t('devicesModal:stalenessNever');
  // The server returns 'YYYY-MM-DD HH:MM:SS' in UTC; parse with a trailing 'Z'.
  const parsed = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(parsed)) return t('devicesModal:stalenessNever');
  const diff = Date.now() - parsed;
  if (diff < 60_000) return t('devicesModal:stalenessJustNow');
  if (diff < 3_600_000) return t('devicesModal:stalenessMinutes', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('devicesModal:stalenessHours', { n: Math.floor(diff / 3_600_000) });
  return t('devicesModal:stalenessDays', { n: Math.floor(diff / 86_400_000) });
}
