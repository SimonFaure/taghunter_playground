// Top-bar "Devices" modal: every device paired to the mother, whatever it is
// doing - in a game (and which), on its registration screen or a result
// waiting to be cleared, off its game page, idle, on the logo screen, locked,
// or not connected to the mother - with remote Lock / Logo screen actions, per
// row or on a selection, "Back to the game" for a device that is registered in
// a game but no longer showing it, Start / Reset display when its game page
// waits on the operator, and one icon per action: Logo, Lock, Home, sound,
// SI reader (refresh) and its test beep, restart. Logo, Lock, sound and reader
// show the device's state by their colour and toggle it (unlock / hide the
// logo / unmute). Each row also shows the app version and what the device
// needs (FleetUpkeep): an app update and/or a content sync, with the buttons to
// run them remotely (one row, or "all").
//
// Reads the mother's `list_fleet` (the launched_games route already points at
// the mother on a child) every 2s while open. Commands reach a satellite on its
// next ping (~10s); a command aimed at the mother runs in-process on it. The
// target answers once it ran the command (sendRemote): a refusal shows on its
// row. A newer action is greyed out for an older build that can't run it.
// THIS device's own row acts locally instead (no round trip), and is left out
// of the selection so "lock everything" never locks the console doing it.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MonitorSmartphone,
  X,
  Loader2,
  Lock,
  Image as ImageIcon,
  RefreshCw,
  Crown,
  Gamepad2,
  Moon,
  Trophy,
  Play,
  WifiOff,
  Circle,
  LogOut,
  Home,
  Volume2,
  VolumeX,
  Usb,
  BellRing,
  Power,
  RotateCcw,
} from 'lucide-react';
import {
  listFleet,
  queueLockDeviceBulk,
  queueShowLogoBulk,
  queueJoinGameCommandBulk,
  queueSyncContentBulk,
  queueUpdateAppBulk,
  queueGoHomeBulk,
  queueUnlockDeviceBulk,
  queueHideLogoBulk,
  queueSetMuteBulk,
  queueReaderRefreshBulk,
  queueReaderBeepBulk,
  queueRestartAppBulk,
  queueStartGameBulk,
  queueResetDisplayBulk,
  deviceSupports,
  type FleetDeviceRow,
  type FleetMotherInfo,
  type QueueCommandBulkResp,
} from '../services/launchedGames';
import { subscribeScreenState, type ScreenState } from '../services/screenState';
import { subscribeUpkeep, type UpkeepReport } from '../services/upkeepState';
import { syncContentNow, updateAppNow } from '../services/deviceUpkeep';
import { displayDeviceLabel } from '../services/lanPairing';
import { getDeviceLockState, type LockReason } from '../services/deviceLock';
import { formatStaleness } from '../utils/staleness';
import { GameLockGate } from './GameLockGate';
import { ConfirmDialog } from './ConfirmDialog';
import { runLocalCommand, type CommandResult } from '../services/lanCommands';
import { sendRemote, commandErrorText } from './RemoteCommandUi';
import {
  SyncButton,
  UpdateButton,
  UpkeepLine,
  needsSync,
  updateBusy,
  updateNeedOf,
  type UpdateNeed,
} from './FleetUpkeep';

interface DevicesFleetModalProps {
  onClose: () => void;
  // This device's own Lock / Logo actions run locally (App owns both screens).
  onLockSelf: () => void;
  onShowLogoSelf: () => void;
}

const POLL_MS = 2000;
// Shortest spinner: a command run in-process (the mother's row, this device's
// row) answers at once.
const BUSY_MS = 1500;

type Action =
  | 'lock'
  | 'logo'
  | 'rejoin'
  | 'sync'
  | 'update'
  | 'home'
  | 'mute'
  | 'reader'
  | 'beep'
  | 'restart'
  | 'start'
  | 'reset';

// An update restarts the app: confirm first when it is this device, when the
// operator forces it past a running game, or for several devices at once.
type UpdateConfirm =
  | { kind: 'self'; force: boolean }
  | { kind: 'force'; row: FleetDeviceRow }
  | { kind: 'bulk'; ids: number[] };

export function DevicesFleetModal({ onClose, onLockSelf, onShowLogoSelf }: DevicesFleetModalProps) {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<FleetDeviceRow[] | null>(null);
  const [mother, setMother] = useState<FleetMotherInfo | null>(null);
  const [callerId, setCallerId] = useState<number | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<Map<number, Action>>(new Map());
  const [errorFor, setErrorFor] = useState<Map<number, string>>(new Map());
  const [selfState, setSelfState] = useState<ScreenState | null>(null);
  useEffect(() => subscribeScreenState(setSelfState), []);
  // This device's own upkeep, live (its row from the mother lags a ping).
  const [selfUpkeep, setSelfUpkeep] = useState<UpkeepReport | null>(null);
  useEffect(() => subscribeUpkeep(setSelfUpkeep), []);
  const [updateConfirm, setUpdateConfirm] = useState<UpdateConfirm | null>(null);
  // Restart confirm (`force`: even with a game running there).
  const [restartConfirm, setRestartConfirm] = useState<{ row: FleetDeviceRow; force: boolean } | null>(null);

  // Device-lock gate (emergency-disabled / past billing grace): pulling a
  // device into a game counts as joining it, like the game Devices modal's
  // Reconnect. Lock / Logo stay available - they only blank a screen.
  const [lockGate, setLockGate] = useState<{ reason: Exclude<LockReason, null>; run: () => void } | null>(null);
  const blockedByLock = async (run: () => void): Promise<boolean> => {
    const lock = await getDeviceLockState();
    if (lock.locked && lock.reason) {
      setLockGate({ reason: lock.reason, run });
      return true;
    }
    return false;
  };

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await listFleet();
        if (cancelled) return;
        setDevices(res.devices);
        setMother(res.mother ?? null);
        // Older mother: no caller id, and `is_self` is only "me" when we ARE
        // the mother - the best available guess.
        setCallerId(res.caller_device_id ?? res.devices.find((d) => d.is_self)?.id ?? null);
        setUnreachable(false);
        const onlineIds = new Set(res.devices.filter((d) => d.online).map((d) => d.id));
        setSelected((prev) => {
          if (prev.size === 0) return prev;
          const out = new Set<number>();
          for (const id of prev) if (onlineIds.has(id)) out.add(id);
          return out.size === prev.size ? prev : out;
        });
      } catch {
        if (!cancelled) setUnreachable(true);
      }
    };
    void tick();
    const h = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(h);
    };
  }, []);

  const isMe = (row: FleetDeviceRow) => row.id === callerId;
  const stateOf = (row: FleetDeviceRow): ScreenState | null =>
    isMe(row) ? selfState : row.screen_state ?? null;
  const upkeepOf = (row: FleetDeviceRow): UpkeepReport | null =>
    isMe(row) ? selfUpkeep : row.upkeep ?? null;

  // Devices another device can act on (online, reporting upkeep: an older
  // build ignores the commands) that need an update / a sync.
  const actionable = (devices ?? []).filter((d) => d.online && !isMe(d) && upkeepOf(d));
  const toUpdate = actionable.filter((d) => {
    const u = upkeepOf(d);
    return updateNeedOf(d, u, mother).target && !updateBusy(u) && u?.update.phase !== 'store_only';
  });
  const toSync = actionable.filter((d) => needsSync(upkeepOf(d)) && upkeepOf(d)?.content.phase !== 'syncing');

  // Selectable = online and not this device.
  const selectable = (devices ?? []).filter((d) => d.online && !isMe(d));
  const allSelected = selectable.length > 0 && selectable.every((d) => selected.has(d.id));

  function markBusy(ids: number[], action: Action) {
    setBusy((m) => {
      const n = new Map(m);
      for (const id of ids) n.set(id, action);
      return n;
    });
    setErrorFor((m) => {
      if (!ids.some((id) => m.has(id))) return m;
      const n = new Map(m);
      for (const id of ids) n.delete(id);
      return n;
    });
  }

  function clearBusy(ids: number[]) {
    setBusy((m) => {
      const n = new Map(m);
      for (const id of ids) n.delete(id);
      return n;
    });
  }

  function setErrors(errors: Map<number, string | null>) {
    setErrorFor((m) => {
      const n = new Map(m);
      for (const [id, code] of errors) {
        if (code) n.set(id, commandErrorText(t, code));
        else n.delete(id);
      }
      return n;
    });
  }

  // Queue, then keep the spinner until each target answered (or ~20 s).
  async function send(ids: number[], action: Action, call: () => Promise<QueueCommandBulkResp>) {
    if (ids.length === 0) return;
    markBusy(ids, action);
    const startedAt = Date.now();
    try {
      setErrors(await sendRemote(call));
    } catch (e) {
      const msg = (e as Error).message || t('fleet:errorFailed');
      setErrorFor((m) => {
        const n = new Map(m);
        for (const id of ids) n.set(id, msg);
        return n;
      });
    } finally {
      const left = BUSY_MS - (Date.now() - startedAt);
      if (left > 0) window.setTimeout(() => clearBusy(ids), left);
      else clearBusy(ids);
    }
  }

  // This device's own row: run the command here, as a pushed one would run.
  async function runSelf(row: FleetDeviceRow, action: Action, kind: string, payload: Record<string, unknown> = {}) {
    markBusy([row.id], action);
    let result: CommandResult;
    try {
      result = await runLocalCommand(kind, payload);
    } catch {
      result = { ok: false, error: 'failed' };
    }
    setErrors(new Map([[row.id, result.ok ? null : result.error]]));
    window.setTimeout(() => clearBusy([row.id]), BUSY_MS);
  }

  function onHome(row: FleetDeviceRow) {
    if (isMe(row)) {
      // The logo screen replaces this console: close the modal first.
      onClose();
      void runLocalCommand('go_home');
      return;
    }
    void send([row.id], 'home', () => queueGoHomeBulk([row.id]));
  }

  function onMute(row: FleetDeviceRow, muted: boolean) {
    if (isMe(row)) return void runSelf(row, 'mute', 'set_mute', { muted });
    void send([row.id], 'mute', () => queueSetMuteBulk([row.id], muted));
  }

  function onReaderRefresh(row: FleetDeviceRow) {
    if (isMe(row)) return void runSelf(row, 'reader', 'reader_refresh');
    void send([row.id], 'reader', () => queueReaderRefreshBulk([row.id]));
  }

  function onReaderBeep(row: FleetDeviceRow) {
    if (isMe(row)) return void runSelf(row, 'beep', 'reader_beep');
    void send([row.id], 'beep', () => queueReaderBeepBulk([row.id]));
  }

  function confirmRestart() {
    const c = restartConfirm;
    setRestartConfirm(null);
    if (!c) return;
    if (isMe(c.row)) {
      void runSelf(c.row, 'restart', 'restart_app', c.force ? { force: true } : {});
      return;
    }
    void send([c.row.id], 'restart', () => queueRestartAppBulk([c.row.id], { force: c.force }));
  }

  // Start / reset the game page the device shows (it waits on the operator).
  function onStartGame(row: FleetDeviceRow, gameId: number) {
    if (isMe(row)) return void runSelf(row, 'start', 'start_game', { launched_game_id: gameId });
    void send([row.id], 'start', () => queueStartGameBulk([row.id], gameId));
  }

  function onResetDisplay(row: FleetDeviceRow, gameId: number) {
    if (isMe(row)) return void runSelf(row, 'reset', 'reset_display', { launched_game_id: gameId });
    void send([row.id], 'reset', () => queueResetDisplayBulk([row.id], gameId));
  }

  // Toggles: `off` takes the lock / the logo screen away again. This device's
  // own row is never locked nor on its logo while its modal is open.
  function onLock(row: FleetDeviceRow, off: boolean) {
    if (isMe(row)) return onLockSelf();
    void send([row.id], 'lock', () => (off ? queueUnlockDeviceBulk([row.id]) : queueLockDeviceBulk([row.id])));
  }

  function onLogo(row: FleetDeviceRow, off: boolean) {
    if (isMe(row)) return onShowLogoSelf();
    void send([row.id], 'logo', () => (off ? queueHideLogoBulk([row.id]) : queueShowLogoBulk([row.id])));
  }

  async function onRejoin(row: FleetDeviceRow, gameId: number) {
    if (await blockedByLock(() => void onRejoin(row, gameId))) return;
    void send([row.id], 'rejoin', () => queueJoinGameCommandBulk([row.id], gameId, { rejoin: true }));
  }

  function onSync(row: FleetDeviceRow) {
    if (isMe(row)) {
      void syncContentNow();
      return;
    }
    void send([row.id], 'sync', () => queueSyncContentBulk([row.id]));
  }

  // `force`: restart even though a game runs there (the device stopped at
  // "ready" and said so).
  function onUpdate(row: FleetDeviceRow, force: boolean) {
    if (isMe(row)) {
      setUpdateConfirm({ kind: 'self', force });
      return;
    }
    if (force) {
      setUpdateConfirm({ kind: 'force', row });
      return;
    }
    void send([row.id], 'update', () => queueUpdateAppBulk([row.id]));
  }

  function confirmUpdate() {
    const c = updateConfirm;
    setUpdateConfirm(null);
    if (!c) return;
    if (c.kind === 'self') void updateAppNow({ force: c.force });
    else if (c.kind === 'force') void send([c.row.id], 'update', () => queueUpdateAppBulk([c.row.id], { force: true }));
    else void send(c.ids, 'update', () => queueUpdateAppBulk(c.ids));
  }

  function onBulk(action: 'lock' | 'logo' | 'home' | 'mute' | 'unmute') {
    const ids = Array.from(selected);
    switch (action) {
      case 'lock':
        return void send(ids, 'lock', () => queueLockDeviceBulk(ids));
      case 'logo':
        return void send(ids, 'logo', () => queueShowLogoBulk(ids));
      case 'home':
        return void send(ids, 'home', () => queueGoHomeBulk(ids));
      case 'mute':
      case 'unmute':
        return void send(ids, 'mute', () => queueSetMuteBulk(ids, action === 'mute'));
    }
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectable.map((d) => d.id)));
  }

  function toggleOne(id: number) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const onlineCount = (devices ?? []).filter((d) => d.online).length;
  const bulkBtn =
    'px-3 py-1.5 bg-[var(--pg-surface-2)] hover:bg-[var(--pg-surface-3)] disabled:opacity-40 disabled:hover:bg-[var(--pg-surface-2)] text-[var(--pg-text)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] text-sm flex items-center gap-1.5';

  return (
    <>
      <div className="pg-overlay p-4" onClick={onClose}>
        <div
          className="bg-[var(--pg-surface)] border-2 border-[var(--pg-line-strong)] rounded-[var(--pg-radius-lg)] p-6 max-w-3xl w-full max-h-[85vh] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-2xl font-bold text-[var(--pg-text)] flex items-center gap-2">
              <MonitorSmartphone size={24} className="text-purple-500" />
              {t('fleet:title')}
              {devices && (
                <span className="text-sm font-normal text-[var(--pg-text-dim)]">
                  {t('fleet:onlineCount', { online: onlineCount, total: devices.length })}
                </span>
              )}
            </h3>
            <button onClick={onClose} className="pg-modal-close" aria-label={t('fleet:close')}>
              <X size={24} />
            </button>
          </div>
          <p className="text-sm text-[var(--pg-text-dim)] mb-5">
            {t('fleet:subtitle')}
            {mother && <span className="whitespace-nowrap"> {t('fleet:motherVersion', { version: mother.app_version })}</span>}
          </p>

          {(toUpdate.length > 0 || toSync.length > 0) && (
            <div className="mb-4 px-3 py-2 rounded-[var(--pg-radius-md)] bg-amber-500/10 border border-amber-500/30 text-sm text-amber-200 flex items-center gap-3 flex-wrap">
              <span className="flex-1 min-w-0">
                {[
                  toUpdate.length > 0 ? t('fleet:needUpdateCount', { count: toUpdate.length }) : null,
                  toSync.length > 0 ? t('fleet:needSyncCount', { count: toSync.length }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {toSync.length > 0 && (
                <SyncButton
                  label={t('fleet:syncAll')}
                  title={t('fleet:syncAllTitle')}
                  onClick={() => {
                    const ids = toSync.map((d) => d.id);
                    void send(ids, 'sync', () => queueSyncContentBulk(ids));
                  }}
                />
              )}
              {toUpdate.length > 0 && (
                <UpdateButton
                  label={t('fleet:updateAll')}
                  title={t('fleet:updateAllTitle')}
                  onClick={() => setUpdateConfirm({ kind: 'bulk', ids: toUpdate.map((d) => d.id) })}
                />
              )}
            </div>
          )}

          {unreachable && (
            <div className="mb-4 px-3 py-2 rounded-[var(--pg-radius-md)] bg-amber-500/10 border border-amber-500/30 text-sm text-amber-300 flex items-center gap-2">
              <WifiOff size={16} className="shrink-0" />
              {t('fleet:unreachable')}
            </div>
          )}

          {devices === null ? (
            !unreachable && (
              <div className="flex items-center gap-2 text-sm text-[var(--pg-text-dim)] py-6 justify-center">
                <Loader2 size={16} className="animate-spin" />
                {t('fleet:loading')}
              </div>
            )
          ) : devices.length === 0 ? (
            <p className="text-sm text-[var(--pg-text-dim)] italic px-1">{t('fleet:empty')}</p>
          ) : (
            <>
              <div className="flex items-center gap-3 mb-3 px-1 flex-wrap">
                <label className="flex items-center gap-2 text-sm text-[var(--pg-text-muted)] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-[var(--pg-accent)]"
                    checked={allSelected}
                    disabled={selectable.length === 0}
                    onChange={toggleAll}
                  />
                  {t('fleet:selectAll')}
                </label>
                <div className="flex-1" />
                <span className="text-xs text-[var(--pg-text-dim)]">
                  {t('fleet:selectedCount', { count: selected.size })}
                </span>
                <button
                  className={bulkBtn}
                  disabled={selected.size === 0}
                  title={selected.size === 0 ? t('fleet:tickOne') : t('fleet:muteSelectedTitle')}
                  aria-label={t('fleet:mute')}
                  onClick={() => onBulk('mute')}
                >
                  <VolumeX size={14} />
                </button>
                <button
                  className={bulkBtn}
                  disabled={selected.size === 0}
                  title={selected.size === 0 ? t('fleet:tickOne') : t('fleet:unmuteSelectedTitle')}
                  aria-label={t('fleet:unmute')}
                  onClick={() => onBulk('unmute')}
                >
                  <Volume2 size={14} />
                </button>
                <button
                  className={bulkBtn}
                  disabled={selected.size === 0}
                  title={selected.size === 0 ? t('fleet:tickOne') : t('fleet:homeSelectedTitle')}
                  onClick={() => onBulk('home')}
                >
                  <Home size={14} />
                  {t('fleet:home')}
                </button>
                <button
                  className={bulkBtn}
                  disabled={selected.size === 0}
                  title={selected.size === 0 ? t('fleet:tickOne') : t('fleet:logoSelectedTitle')}
                  onClick={() => onBulk('logo')}
                >
                  <ImageIcon size={14} />
                  {t('fleet:logo')}
                </button>
                <button
                  className="px-3 py-1.5 bg-[var(--pg-accent)] hover:bg-[var(--pg-accent-hover)] disabled:bg-[var(--pg-surface-3)] disabled:text-[var(--pg-text-dim)] text-white rounded-[var(--pg-radius-md)] text-sm flex items-center gap-1.5"
                  disabled={selected.size === 0}
                  title={selected.size === 0 ? t('fleet:tickOne') : t('fleet:lockSelectedTitle')}
                  onClick={() => onBulk('lock')}
                >
                  <Lock size={14} />
                  {t('fleet:lock')}
                </button>
              </div>

              <ul className="space-y-2">
                {devices.map((row) => (
                  <li key={row.id}>
                    <FleetRow
                      row={row}
                      me={isMe(row)}
                      state={stateOf(row)}
                      selected={selected.has(row.id)}
                      onToggle={() => toggleOne(row.id)}
                      busy={busy.get(row.id) ?? null}
                      error={errorFor.get(row.id)}
                      onLock={(off) => onLock(row, off)}
                      onLogo={(off) => onLogo(row, off)}
                      onRejoin={(gid) => void onRejoin(row, gid)}
                      upkeep={upkeepOf(row)}
                      need={updateNeedOf(row, upkeepOf(row), mother)}
                      onSync={() => onSync(row)}
                      onUpdate={(force) => onUpdate(row, force)}
                      onHome={() => onHome(row)}
                      onMute={(muted) => onMute(row, muted)}
                      onReaderRefresh={() => onReaderRefresh(row)}
                      onReaderBeep={() => onReaderBeep(row)}
                      onRestart={(force) => setRestartConfirm({ row, force })}
                      onStartGame={(gid) => onStartGame(row, gid)}
                      onResetDisplay={(gid) => onResetDisplay(row, gid)}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={updateConfirm !== null}
        onConfirm={confirmUpdate}
        onCancel={() => setUpdateConfirm(null)}
        title={t('fleet:updateConfirmTitle')}
        message={
          updateConfirm?.kind === 'self'
            ? t(updateConfirm.force ? 'fleet:updateConfirmSelfForce' : 'fleet:updateConfirmSelf')
            : updateConfirm?.kind === 'force'
              ? t('fleet:updateConfirmForce', {
                  name: displayDeviceLabel(updateConfirm.row.device_label) || t('fleet:unknownDevice'),
                })
              : t('fleet:updateConfirmBulk', { count: updateConfirm?.kind === 'bulk' ? updateConfirm.ids.length : 0 })
        }
        confirmText={updateConfirm?.kind === 'bulk' ? t('fleet:updateAll') : t('fleet:update')}
        cancelText={t('fleet:cancel')}
        variant={updateConfirm?.kind === 'bulk' ? 'info' : 'warning'}
      />

      <ConfirmDialog
        isOpen={restartConfirm !== null}
        onConfirm={confirmRestart}
        onCancel={() => setRestartConfirm(null)}
        title={t('fleet:restartConfirmTitle')}
        message={(() => {
          if (!restartConfirm) return '';
          const name = displayDeviceLabel(restartConfirm.row.device_label) || t('fleet:unknownDevice');
          if (restartConfirm.row.is_self) return t('fleet:restartConfirmMother', { name });
          return t(restartConfirm.force ? 'fleet:restartConfirmForce' : 'fleet:restartConfirm', { name });
        })()}
        confirmText={t('fleet:restart')}
        cancelText={t('fleet:cancel')}
        variant="warning"
      />

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

function FleetRow({
  row,
  me,
  state,
  selected,
  onToggle,
  busy,
  error,
  onLock,
  onLogo,
  onRejoin,
  upkeep,
  need,
  onSync,
  onUpdate,
  onHome,
  onMute,
  onReaderRefresh,
  onReaderBeep,
  onRestart,
  onStartGame,
  onResetDisplay,
}: {
  row: FleetDeviceRow;
  me: boolean;
  state: ScreenState | null;
  selected: boolean;
  onToggle: () => void;
  busy: Action | null;
  error: string | undefined;
  onLock: (off: boolean) => void;
  onLogo: (off: boolean) => void;
  onRejoin: (launchedGameId: number) => void;
  upkeep: UpkeepReport | null;
  need: UpdateNeed;
  onSync: () => void;
  onUpdate: (force: boolean) => void;
  onHome: () => void;
  onMute: (muted: boolean) => void;
  onReaderRefresh: () => void;
  onReaderBeep: () => void;
  onRestart: (force: boolean) => void;
  onStartGame: (launchedGameId: number) => void;
  onResetDisplay: (launchedGameId: number) => void;
}) {
  const { t } = useTranslation();
  const label =
    displayDeviceLabel(row.device_label) || (me ? t('fleet:thisDeviceName') : t('fleet:unknownDevice'));

  // The game this device should be showing: the one it reports, else the
  // newest active game it is registered in.
  const shownGameId = row.online && state?.kind === 'in_game' ? state.launchedGameId : null;
  const rejoinGame = row.games[0] ?? null;
  // Registered but not on that game's page (left it, on the logo, locked,
  // idle…). The push lifts a lock / logo screen on the device.
  const canRejoin =
    !me && row.online && !row.operator_only && rejoinGame != null && shownGameId !== rejoinGame.launched_game_id;

  const gameLine =
    state?.kind === 'in_game' && row.online && state.gameName
      ? t('fleet:gameLabel', { name: state.gameName })
      : row.games.length > 0
        ? t('fleet:registeredIn', { names: row.games.map((g) => g.name).join(', ') })
        : null;

  const spinner = (
    <span className="p-2 bg-[var(--pg-surface-3)] text-[var(--pg-text-muted)] rounded-[var(--pg-radius-md)] flex items-center">
      <Loader2 size={16} className="animate-spin" />
    </span>
  );
  const offlineTitle = t('fleet:offlineActionTitle');

  // Upkeep actions: only on a connected device that reports upkeep (an older
  // build ignores the commands), and not while it is already at it.
  const canAct = (me || row.online) && upkeep != null;
  const u = upkeep?.update;
  const readyBlocked = u?.phase === 'ready' && u.blocked === 'game_running';
  const showUpdate =
    canAct && !updateBusy(upkeep) && u?.phase !== 'store_only' && (need.target != null || u?.phase === 'error');
  const showSync = canAct && needsSync(upkeep);

  // Newer remote actions: greyed out for a build that can't run them.
  const reachable = me || row.online;
  const supports = (kind: string) => deviceSupports(row.caps, kind);
  // A build that lists its caps but not this kind can't do it at all (a tablet
  // has no restart / USB reader); one that lists none is older.
  const disabledTitle = (kind: string) =>
    !reachable
      ? offlineTitle
      : !supports(kind)
        ? Array.isArray(row.caps)
          ? t('fleet:notOnThisDevice')
          : t('fleet:needsUpdate')
        : undefined;
  const muted = upkeep?.muted === true;
  // The game page waits on the operator: its registration Start, or a result
  // to clear.
  const waitingGameId = reachable && state?.kind === 'in_game' ? state.launchedGameId : null;
  const showStart = waitingGameId != null && state?.kind === 'in_game' && state.sub === 'register' && supports('start_game');
  const showReset = waitingGameId != null && state?.kind === 'in_game' && state.sub === 'results' && supports('reset_display');
  const locked = row.online && state?.kind === 'locked';
  const onLogoScreen = row.online && state?.kind === 'logo';
  // A restart while it shows a game: say so, and restart it anyway.
  const restartForce = state?.kind === 'in_game' || row.games.length > 0;
  const iconTitle = (kind: string, title: string) => disabledTitle(kind) ?? title;

  return (
    <div
      className={`flex items-center gap-3 p-3 bg-[var(--pg-bg)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] flex-wrap ${
        row.online ? '' : 'opacity-70'
      }`}
    >
      <input
        type="checkbox"
        className="w-4 h-4 accent-[var(--pg-accent)] disabled:opacity-30"
        checked={selected}
        disabled={me || !row.online}
        title={me ? t('fleet:selfNotSelectable') : !row.online ? offlineTitle : undefined}
        onChange={onToggle}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-[var(--pg-text)] truncate flex items-center gap-2">
          {row.is_self && (
            <span title={t('fleet:motherTitle')} className="inline-flex items-center gap-1 text-xs text-green-400">
              <Crown size={12} />
              {t('fleet:mother')}
            </span>
          )}
          <span className="truncate">{label}</span>
          {me && displayDeviceLabel(row.device_label) != null && (
            <span className="text-xs text-[var(--pg-text-dim)]">{t('fleet:thisDevice')}</span>
          )}
        </div>
        <div className="text-xs text-[var(--pg-text-dim)] truncate">
          {gameLine ?? row.peer_os ?? ''}
        </div>
        <UpkeepLine row={row} upkeep={upkeep} need={need} />
      </div>
      <StatusPill row={row} state={state} />
      {showStart &&
        waitingGameId != null &&
        (busy === 'start' ? (
          spinner
        ) : (
          <button
            onClick={() => onStartGame(waitingGameId)}
            title={t('fleet:startGameTitle')}
            className="px-2.5 py-1.5 bg-green-600/15 hover:bg-green-600/25 text-green-400 border border-green-600/30 rounded-[var(--pg-radius-md)] text-sm flex items-center gap-1.5"
          >
            <Play size={14} />
            {t('fleet:startGame')}
          </button>
        ))}
      {showReset &&
        waitingGameId != null &&
        (busy === 'reset' ? (
          spinner
        ) : (
          <button
            onClick={() => onResetDisplay(waitingGameId)}
            title={t('fleet:resetDisplayTitle')}
            className="px-2.5 py-1.5 bg-[var(--pg-surface-2)] hover:bg-[var(--pg-surface-3)] text-[var(--pg-text)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] text-sm flex items-center gap-1.5"
          >
            <RotateCcw size={14} />
            {t('fleet:resetDisplay')}
          </button>
        ))}
      {showSync &&
        (busy === 'sync' ? (
          spinner
        ) : (
          <SyncButton label={t('fleet:sync')} title={t('fleet:syncTitle')} onClick={onSync} />
        ))}
      {showUpdate &&
        (busy === 'update' ? (
          spinner
        ) : (
          <UpdateButton
            label={readyBlocked ? t('fleet:updateForce') : t('fleet:update')}
            title={
              readyBlocked
                ? t('fleet:updateForceTitle')
                : need.target
                  ? t('fleet:updateTitle', { version: need.target })
                  : t('fleet:updateRetryTitle')
            }
            onClick={() => onUpdate(readyBlocked)}
          />
        ))}
      {canRejoin &&
        rejoinGame &&
        (busy === 'rejoin' ? (
          spinner
        ) : (
          <button
            onClick={() => onRejoin(rejoinGame.launched_game_id)}
            title={t('fleet:rejoinTitle', { name: rejoinGame.name })}
            aria-label={t('fleet:rejoin')}
            className="px-2.5 py-1.5 bg-green-600/15 hover:bg-green-600/25 text-green-400 border border-green-600/30 rounded-[var(--pg-radius-md)] text-sm flex items-center gap-1.5"
          >
            <RefreshCw size={14} />
            {t('fleet:rejoin')}
          </button>
        ))}
      <div className="flex items-center gap-1.5">
        <IconAction
          icon={<ImageIcon size={16} />}
          tone={onLogoScreen ? 'blue' : 'default'}
          busy={busy === 'logo'}
          disabled={!row.online || (onLogoScreen && !supports('hide_logo'))}
          label={onLogoScreen ? t('fleet:hideLogo') : t('fleet:logo')}
          title={
            !row.online
              ? offlineTitle
              : onLogoScreen
                ? iconTitle('hide_logo', t('fleet:hideLogoTitle'))
                : t('fleet:logoTitle')
          }
          onClick={() => onLogo(onLogoScreen)}
        />
        <IconAction
          icon={<Lock size={16} />}
          tone={locked ? 'red' : 'default'}
          busy={busy === 'lock'}
          disabled={!row.online || (locked && !supports('unlock_device'))}
          label={locked ? t('fleet:unlock') : t('fleet:lock')}
          title={
            !row.online ? offlineTitle : locked ? iconTitle('unlock_device', t('fleet:unlockTitle')) : t('fleet:lockTitle')
          }
          onClick={() => onLock(locked)}
        />
        <IconAction
          icon={<Home size={16} />}
          busy={busy === 'home'}
          disabled={!reachable || !supports('go_home')}
          label={t('fleet:home')}
          title={iconTitle('go_home', t('fleet:homeTitle'))}
          onClick={onHome}
        />
        <IconAction
          icon={muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          tone={muted ? 'amber' : 'default'}
          busy={busy === 'mute'}
          disabled={!reachable || !supports('set_mute')}
          label={muted ? t('fleet:unmute') : t('fleet:mute')}
          title={iconTitle('set_mute', muted ? t('fleet:unmuteTitle') : t('fleet:muteTitle'))}
          onClick={() => onMute(!muted)}
        />
        <IconAction
          icon={<Usb size={16} />}
          tone={row.has_reader ? 'green' : 'default'}
          busy={busy === 'reader'}
          disabled={!reachable || !supports('reader_refresh')}
          label={t('fleet:readerRefresh')}
          title={iconTitle(
            'reader_refresh',
            row.has_reader ? t('fleet:readerOnTitle') : t('fleet:readerOffTitle'),
          )}
          onClick={onReaderRefresh}
        />
        <IconAction
          icon={<BellRing size={16} />}
          busy={busy === 'beep'}
          disabled={!reachable || !supports('reader_beep')}
          label={t('fleet:readerBeep')}
          title={iconTitle('reader_beep', t('fleet:readerBeepTitle'))}
          onClick={onReaderBeep}
        />
        <IconAction
          icon={<Power size={16} />}
          tone="danger"
          busy={busy === 'restart'}
          disabled={!reachable || !supports('restart_app')}
          label={t('fleet:restart')}
          title={iconTitle('restart_app', t('fleet:restartTitle'))}
          onClick={() => onRestart(restartForce)}
        />
      </div>
      {error && (
        <span className="basis-full text-xs text-red-400 px-2 py-0.5 bg-red-500/10 rounded">{error}</span>
      )}
    </div>
  );
}

type IconTone = 'default' | 'red' | 'green' | 'amber' | 'blue' | 'danger';

const TONES: Record<IconTone, string> = {
  default: 'bg-[var(--pg-surface-2)] hover:bg-[var(--pg-surface-3)] text-[var(--pg-text)] border-[var(--pg-line)]',
  red: 'bg-red-500/15 hover:bg-red-500/25 text-red-400 border-red-500/40',
  green: 'bg-green-500/10 hover:bg-green-500/20 text-green-400 border-green-600/30',
  amber: 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 border-amber-500/40',
  blue: 'bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 border-blue-500/40',
  danger: 'bg-[var(--pg-surface-2)] hover:bg-red-600/20 text-red-400 border-[var(--pg-line)]',
};

/** One row action as an icon button; its colour can carry the device's state. */
function IconAction({
  icon,
  label,
  title,
  onClick,
  disabled,
  busy,
  tone = 'default',
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: IconTone;
}) {
  if (busy) {
    return (
      <span className="p-2 bg-[var(--pg-surface-3)] text-[var(--pg-text-muted)] border border-transparent rounded-[var(--pg-radius-md)] flex items-center">
        <Loader2 size={16} className="animate-spin" />
      </span>
    );
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
      className={`p-2 border rounded-[var(--pg-radius-md)] flex items-center disabled:opacity-40 disabled:cursor-not-allowed ${TONES[tone]}`}
    >
      {icon}
    </button>
  );
}

function StatusPill({ row, state }: { row: FleetDeviceRow; state: ScreenState | null }) {
  const { t } = useTranslation();
  let label: string;
  let cls: string;
  let icon: React.ReactNode;
  let title: string | undefined;

  if (!row.online) {
    label = t('fleet:statusOffline');
    cls = 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)]';
    icon = <WifiOff size={12} />;
    title = t('devicesModal:lastSeen', { time: formatStaleness(row.last_seen_at, t) });
  } else if (!state) {
    // Connected but never reported a screen (older build) - say only that.
    label = t('fleet:statusOnline');
    cls = 'bg-green-500/10 text-green-400';
    icon = <Circle size={10} className="fill-current" />;
  } else {
    switch (state.kind) {
      case 'locked':
        // The row's lock icon turns red instead.
        return null;
      case 'logo':
        label = t('fleet:statusLogo');
        cls = 'bg-[var(--pg-surface-3)] text-[var(--pg-text-muted)]';
        icon = <ImageIcon size={12} />;
        break;
      case 'video':
        label = t('fleet:statusVideo');
        cls = 'bg-blue-500/10 text-blue-400';
        icon = <Play size={12} />;
        break;
      case 'ranking':
        label = t('fleet:statusRanking');
        cls = 'bg-amber-500/10 text-amber-400';
        icon = <Trophy size={12} />;
        break;
      case 'in_game':
        if (state.sub === 'register') {
          label = t('fleet:statusRegistering');
          cls = 'bg-blue-500/10 text-blue-400';
          icon = <Gamepad2 size={12} />;
        } else if (state.sub === 'results') {
          label = t('fleet:statusResults');
          cls = 'bg-amber-500/10 text-amber-400';
          icon = <Trophy size={12} />;
          title = t('fleet:statusResultsTitle');
        } else {
          label = state.boardHidden ? t('fleet:statusInGameIdleScreen') : t('fleet:statusInGame');
          cls = 'bg-green-500/10 text-green-400';
          icon = state.boardHidden ? <Moon size={12} /> : <Gamepad2 size={12} />;
        }
        break;
      case 'home':
        if (row.games.length > 0) {
          label = t('fleet:statusOffPage');
          cls = 'bg-amber-500/10 text-amber-400';
          icon = <LogOut size={12} />;
          title = t('fleet:statusOffPageTitle');
        } else {
          label = t('fleet:statusIdle');
          cls = 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)]';
          icon = <Moon size={12} />;
        }
        break;
    }
  }

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs whitespace-nowrap ${cls}`}
      title={title}
    >
      {icon}
      {label}
    </span>
  );
}
