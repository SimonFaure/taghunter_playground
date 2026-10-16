// Top-bar "Devices" modal: every device paired to the mother, whatever it is
// doing - in a game (and which), off its game page, idle, on the logo screen,
// locked, or not connected to the mother - with remote Lock / Logo screen
// actions, per row or on a selection, and "Back to the game" for a device that
// is registered in a game but no longer showing it.
//
// Reads the mother's `list_fleet` (the launched_games route already points at
// the mother on a child) every 2s while open. Commands reach a satellite on its
// next ping (~10s); a command aimed at the mother runs in-process on it. THIS
// device's own row acts locally instead (no round trip), and is left out of
// the selection so "lock everything" never locks the console doing it.

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
} from 'lucide-react';
import {
  listFleet,
  queueLockDeviceBulk,
  queueShowLogoBulk,
  queueJoinGameCommandBulk,
  type FleetDeviceRow,
  type QueueCommandBulkResp,
} from '../services/launchedGames';
import { subscribeScreenState, type ScreenState } from '../services/screenState';
import { displayDeviceLabel } from '../services/lanPairing';
import { getDeviceLockState, type LockReason } from '../services/deviceLock';
import { formatStaleness } from '../utils/staleness';
import { GameLockGate } from './GameLockGate';
import { ReaderBadge } from './GameDevicesModal';

interface DevicesFleetModalProps {
  onClose: () => void;
  // This device's own Lock / Logo actions run locally (App owns both screens).
  onLockSelf: () => void;
  onShowLogoSelf: () => void;
}

const POLL_MS = 2000;
// No per-target ack short of the device's next ping - the spinner just marks
// the push as in flight, like the game Devices modal.
const BUSY_MS = 1500;

type Action = 'lock' | 'logo' | 'rejoin';

export function DevicesFleetModal({ onClose, onLockSelf, onShowLogoSelf }: DevicesFleetModalProps) {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<FleetDeviceRow[] | null>(null);
  const [callerId, setCallerId] = useState<number | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<Map<number, Action>>(new Map());
  const [errorFor, setErrorFor] = useState<Map<number, string>>(new Map());
  const [selfState, setSelfState] = useState<ScreenState | null>(null);
  useEffect(() => subscribeScreenState(setSelfState), []);

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
    window.setTimeout(() => {
      setBusy((m) => {
        const n = new Map(m);
        for (const id of ids) n.delete(id);
        return n;
      });
    }, BUSY_MS);
  }

  async function send(ids: number[], action: Action, call: () => Promise<QueueCommandBulkResp>) {
    if (ids.length === 0) return;
    markBusy(ids, action);
    try {
      const res = await call();
      const failed = res.results.filter((r) => r.error);
      if (failed.length > 0) {
        setErrorFor((m) => {
          const n = new Map(m);
          for (const r of failed) n.set(r.target_device_id, r.error || t('fleet:errorFailed'));
          return n;
        });
      }
    } catch (e) {
      const msg = (e as Error).message || t('fleet:errorFailed');
      setErrorFor((m) => {
        const n = new Map(m);
        for (const id of ids) n.set(id, msg);
        return n;
      });
    }
  }

  function onLock(row: FleetDeviceRow) {
    if (isMe(row)) return onLockSelf();
    void send([row.id], 'lock', () => queueLockDeviceBulk([row.id]));
  }

  function onLogo(row: FleetDeviceRow) {
    if (isMe(row)) return onShowLogoSelf();
    void send([row.id], 'logo', () => queueShowLogoBulk([row.id]));
  }

  async function onRejoin(row: FleetDeviceRow, gameId: number) {
    if (await blockedByLock(() => void onRejoin(row, gameId))) return;
    void send([row.id], 'rejoin', () => queueJoinGameCommandBulk([row.id], gameId, { rejoin: true }));
  }

  function onBulk(action: 'lock' | 'logo') {
    const ids = Array.from(selected);
    void send(ids, action, () => (action === 'lock' ? queueLockDeviceBulk(ids) : queueShowLogoBulk(ids)));
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
          <p className="text-sm text-[var(--pg-text-dim)] mb-5">{t('fleet:subtitle')}</p>

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
                  className="px-3 py-1.5 bg-[var(--pg-surface-2)] hover:bg-[var(--pg-surface-3)] disabled:opacity-40 disabled:hover:bg-[var(--pg-surface-2)] text-[var(--pg-text)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] text-sm flex items-center gap-1.5"
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
                      onLock={() => onLock(row)}
                      onLogo={() => onLogo(row)}
                      onRejoin={(gid) => void onRejoin(row, gid)}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
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
}: {
  row: FleetDeviceRow;
  me: boolean;
  state: ScreenState | null;
  selected: boolean;
  onToggle: () => void;
  busy: Action | null;
  error: string | undefined;
  onLock: () => void;
  onLogo: () => void;
  onRejoin: (launchedGameId: number) => void;
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

  const actionBtn =
    'p-2 bg-[var(--pg-surface-2)] hover:bg-[var(--pg-surface-3)] disabled:opacity-40 disabled:hover:bg-[var(--pg-surface-2)] text-[var(--pg-text)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] flex items-center';
  const spinner = (
    <span className="p-2 bg-[var(--pg-surface-3)] text-[var(--pg-text-muted)] rounded-[var(--pg-radius-md)] flex items-center">
      <Loader2 size={16} className="animate-spin" />
    </span>
  );
  const offlineTitle = t('fleet:offlineActionTitle');

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
      </div>
      <StatusPill row={row} state={state} />
      <ReaderBadge has={row.has_reader} />
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
      {busy === 'logo' ? (
        spinner
      ) : (
        <button
          onClick={onLogo}
          disabled={!row.online}
          title={row.online ? t('fleet:logoTitle') : offlineTitle}
          aria-label={t('fleet:logo')}
          className={actionBtn}
        >
          <ImageIcon size={16} />
        </button>
      )}
      {busy === 'lock' ? (
        spinner
      ) : (
        <button
          onClick={onLock}
          disabled={!row.online}
          title={row.online ? t('fleet:lockTitle') : offlineTitle}
          aria-label={t('fleet:lock')}
          className={actionBtn}
        >
          <Lock size={16} />
        </button>
      )}
      {error && (
        <span className="basis-full text-xs text-red-400 px-2 py-0.5 bg-red-500/10 rounded">{error}</span>
      )}
    </div>
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
        label = t('fleet:statusLocked');
        cls = 'bg-red-500/10 text-red-400';
        icon = <Lock size={12} />;
        break;
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
        label = state.boardHidden ? t('fleet:statusInGameIdleScreen') : t('fleet:statusInGame');
        cls = 'bg-green-500/10 text-green-400';
        icon = state.boardHidden ? <Moon size={12} /> : <Gamepad2 size={12} />;
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
