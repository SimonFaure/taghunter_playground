// Devices modal upkeep: for each device, the app version it runs and what it
// needs - an app update, a content sync - read from the upkeep report it sends
// on every ping (services/upkeepState), compared with what the mother runs and
// the installers it holds.

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, ArrowUpCircle, CheckCircle2, FolderSync, Loader2 } from 'lucide-react';
import type { FleetDeviceRow, FleetMotherInfo } from '../services/launchedGames';
import type { UpkeepReport } from '../services/upkeepState';
import { channelOk, compareSemver } from '../services/updateService';

export interface UpdateNeed {
  /** The version it should move to; null = nothing newer known. */
  target: string | null;
  /** It runs an older version than the mother (even with no installer known). */
  behindMother: boolean;
}

/** What this device should update to: what its own check found, or a newer
 *  installer the mother holds for its platform and channel. */
export function updateNeedOf(row: FleetDeviceRow, upkeep: UpkeepReport | null, mother: FleetMotherInfo | null): UpdateNeed {
  const v = row.app_version ?? null;
  const u = upkeep?.update;
  const newer = (x: string | null | undefined): x is string => !!x && (!v || compareSemver(x, v) > 0);
  let target: string | null = null;
  if (u && u.phase !== 'up_to_date' && newer(u.latest)) target = u.latest;
  const inst = mother?.installers.find(
    (i) => i.platform === row.platform && (!u?.channel || channelOk(u.channel, i.channel))
  );
  if (inst && newer(inst.version) && (!target || compareSemver(inst.version, target) > 0)) target = inst.version;
  const behindMother = !!(mother && v && !row.is_self && compareSemver(mother.app_version, v) > 0);
  return { target, behindMother };
}

/** The device holds less content than it should. */
export function needsSync(upkeep: UpkeepReport | null): boolean {
  const c = upkeep?.content;
  return !!c && (c.phase === 'pending' || c.phase === 'error');
}

/** The device is mid-way through an update or a sync: no new command. */
export function updateBusy(upkeep: UpkeepReport | null): boolean {
  return ['checking', 'downloading', 'installing'].includes(upkeep?.update.phase ?? '');
}

/** "Zanimos", or "#cards" -> "Liste des puces". */
function itemName(t: TFunction, name: string): string {
  if (!name.startsWith('#')) return name;
  const [kind, label] = name.slice(1).split(/:(.*)/s);
  return t(`sync:pendingKind_${kind}`, { name: label ?? '', defaultValue: t('sync:pendingKind_other') });
}

export function UpkeepLine({
  row,
  upkeep,
  need,
}: {
  row: FleetDeviceRow;
  upkeep: UpkeepReport | null;
  need: UpdateNeed;
}) {
  const { t } = useTranslation();
  const v = row.app_version;
  const u = upkeep?.update;
  const c = upkeep?.content;

  const parts: React.ReactNode[] = [];

  // App version + update state.
  let updateText: string | null = null;
  let updateCls = 'text-[var(--pg-text-dim)]';
  if (u) {
    switch (u.phase) {
      case 'checking':
        updateText = t('fleet:updChecking');
        break;
      case 'downloading':
        updateText = u.progress != null ? t('fleet:updDownloadingPct', { pct: u.progress }) : t('fleet:updDownloading');
        updateCls = 'text-blue-400';
        break;
      case 'ready':
        updateText =
          u.blocked === 'game_running'
            ? t('fleet:updReadyGameRunning')
            : u.blocked === 'confirm_on_device'
              ? t('fleet:updReadyConfirm')
              : t('fleet:updReady');
        updateCls = 'text-amber-400';
        break;
      case 'installing':
        updateText = t('fleet:updInstalling');
        updateCls = 'text-blue-400';
        break;
      case 'error':
        updateText = u.error === 'unreachable' ? t('fleet:updUnreachable') : t('fleet:updError');
        updateCls = 'text-red-400';
        break;
      case 'store_only':
        if (need.target) updateText = t('fleet:updStoreOnly');
        break;
    }
  }
  parts.push(
    <span key="ver" className="inline-flex items-center gap-1 whitespace-nowrap" title={u?.error && u.error !== 'unreachable' ? u.error : undefined}>
      <span className={need.target ? 'text-amber-400' : 'text-[var(--pg-text-dim)]'}>
        {v ? `v${v}` : t('fleet:versionUnknown')}
      </span>
      {need.target && <span className="text-amber-400">→ v{need.target}</span>}
      {!need.target && need.behindMother && !upkeep && (
        <span className="text-amber-400" title={t('fleet:oldBuildTitle')}>
          {t('fleet:behindMother')}
        </span>
      )}
      {!need.target && !updateText && u?.phase === 'up_to_date' && (
        <CheckCircle2 size={12} className="text-green-400" aria-label={t('fleet:updUpToDate')} />
      )}
      {updateText && <span className={updateCls}>· {updateText}</span>}
    </span>
  );

  // Content.
  if (c && c.phase !== 'unknown') {
    let node: React.ReactNode;
    const names = c.names.map((n) => itemName(t, n));
    const list = names.join(', ') + (c.pending > names.length ? '…' : '');
    if (c.phase === 'syncing') {
      node = (
        <span className="text-blue-400 inline-flex items-center gap-1">
          <Loader2 size={11} className="animate-spin" />
          {t('fleet:syncSyncing')}
        </span>
      );
    } else if (c.phase === 'error') {
      node = (
        <span className="text-red-400 inline-flex items-center gap-1" title={c.error ?? undefined}>
          <AlertTriangle size={11} />
          {c.error === 'no_source' ? t('fleet:syncNoSource') : t('fleet:syncError')}
        </span>
      );
    } else if (c.phase === 'pending') {
      const waitsInternet = !c.online && c.from_mother === 0 && !c.mother_newer;
      node = (
        <span className="text-amber-400" title={list || undefined}>
          {c.pending > 0 ? t('fleet:syncPending', { count: c.pending }) : t('fleet:syncMotherNewer')}
          {list && <span className="text-[var(--pg-text-muted)]"> : {list}</span>}
          {c.declined && <span className="text-[var(--pg-text-dim)]"> · {t('fleet:syncDeclined')}</span>}
          {waitsInternet && <span className="text-[var(--pg-text-dim)]"> · {t('fleet:syncNeedsInternet')}</span>}
        </span>
      );
    } else {
      node = (
        <span className="text-green-400 inline-flex items-center gap-1">
          <CheckCircle2 size={11} />
          {t('fleet:syncUpToDate')}
        </span>
      );
    }
    parts.push(
      <span key="content" className="min-w-0 truncate">
        {node}
      </span>
    );
  }

  return <div className="text-xs flex items-center gap-x-3 gap-y-0.5 flex-wrap min-w-0 mt-0.5">{parts}</div>;
}

const btn =
  'px-2.5 py-1.5 border rounded-[var(--pg-radius-md)] text-sm flex items-center gap-1.5 disabled:opacity-40 whitespace-nowrap';
const amberBtn = `${btn} bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border-amber-500/30`;

export function UpdateButton({
  label,
  title,
  onClick,
  disabled,
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} aria-label={label} className={amberBtn}>
      <ArrowUpCircle size={14} />
      {label}
    </button>
  );
}

export function SyncButton({
  label,
  title,
  onClick,
  disabled,
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} aria-label={label} className={amberBtn}>
      <FolderSync size={14} />
      {label}
    </button>
  );
}
