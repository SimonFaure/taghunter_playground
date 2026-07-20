import { useEffect, useState, useCallback, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Monitor, Smartphone, Tablet, Trash2, Loader2, RefreshCw, LogOut, Pencil, Check, X } from 'lucide-react';
import { listMyDevices, revokeDevice, renameDevice, signOutOfThisDevice, MyDeviceListItem } from '../../services/auth';
import { ApiError } from '../../services/api';

const MAX_DISPLAY_NAME = 120;

interface MyDevicesScreenProps {
  onLoggedOut?: () => void;
  /** Rendered inside the unified DevicesScreen: skip the page container + title. */
  embedded?: boolean;
}

export function MyDevicesScreen({ onLoggedOut, embedded = false }: MyDevicesScreenProps) {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<MyDeviceListItem[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listMyDevices();
      setDevices(res.devices);
      setCurrentDeviceId(res.current_device_id);
    } catch (err) {
      setError(extractErrorMessage(err, t));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleRevoke(deviceId: number) {
    setRevokingId(deviceId);
    setError(null);
    try {
      await revokeDevice(deviceId);
      if (deviceId === currentDeviceId) {
        // Self-revoke. Clean up locally and exit.
        await signOutOfThisDevice();
        onLoggedOut?.();
        return;
      }
      await refresh();
    } catch (err) {
      setError(extractErrorMessage(err, t));
    } finally {
      setRevokingId(null);
    }
  }

  async function handleSignOut() {
    setError(null);
    try {
      await signOutOfThisDevice();
      onLoggedOut?.();
    } catch (err) {
      setError(extractErrorMessage(err, t));
    }
  }

  function startEdit(d: MyDeviceListItem) {
    setEditingId(d.id);
    setDraft(d.display_name ?? d.device_label ?? '');
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft('');
  }

  async function saveEdit(d: MyDeviceListItem) {
    const trimmed = draft.trim();
    if (trimmed.length > MAX_DISPLAY_NAME) {
      setError(t('myDevices:nameTooLong', { max: MAX_DISPLAY_NAME }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await renameDevice(d.id, trimmed === '' ? null : trimmed);
      setEditingId(null);
      setDraft('');
      // Let the footer re-resolve the friendly name for the current device.
      window.dispatchEvent(new CustomEvent('device:renamed'));
      await refresh();
    } catch (err) {
      setError(extractErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  }

  function handleRenameKeyDown(e: KeyboardEvent<HTMLInputElement>, d: MyDeviceListItem) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void saveEdit(d);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }

  return (
    <div className={embedded ? '' : 'container mx-auto px-6 py-8 max-w-3xl'}>
      <div className={`flex items-center mb-6 ${embedded ? 'justify-end' : 'justify-between'}`}>
        {!embedded && (
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-[var(--pg-text)]">{t('myDevices:title')}</h1>
          </div>
        )}
        <div className="flex gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="px-3 py-2 rounded-lg text-[var(--pg-text-muted)] hover:bg-[var(--pg-surface-3)] flex items-center gap-2 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {t('myDevices:refresh')}
          </button>
          <button
            onClick={handleSignOut}
            className="px-3 py-2 rounded-lg text-red-300 hover:bg-red-500/20 flex items-center gap-2"
          >
            <LogOut className="w-4 h-4" />
            {t('myDevices:signOut')}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/15 border border-red-500/40 text-red-300 rounded-lg text-sm">
          {error}
        </div>
      )}

      {loading && devices.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-[var(--pg-text-dim)] animate-spin" />
        </div>
      ) : (
        <div className="space-y-2">
          {devices.length === 0 && (
            <div className="text-[var(--pg-text-dim)] text-center py-8">{t('myDevices:noDevices')}</div>
          )}
          {devices.map((d) => {
            const Icon = osIcon(d.os);
            const isCurrent = d.id === currentDeviceId;
            const hasActive = (d.active_sessions ?? 0) > 0;
            return (
              <div
                key={d.id}
                className={`p-4 rounded-xl border flex items-center gap-4 ${
                  isCurrent
                    ? 'bg-[var(--pg-accent-tint)] border-[var(--pg-accent-line)]'
                    : 'bg-[var(--pg-surface-2)] border-[var(--pg-line)]'
                }`}
              >
                <Icon className="w-6 h-6 text-[var(--pg-text-muted)] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {editingId === d.id ? (
                      <div className="flex items-center gap-1 min-w-0">
                        <input
                          type="text"
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => handleRenameKeyDown(e, d)}
                          maxLength={MAX_DISPLAY_NAME + 1}
                          placeholder={d.device_label ?? t('myDevices:deviceNamePlaceholder')}
                          className="pg-input w-44 !py-1 text-sm font-medium"
                        />
                        <button
                          type="button"
                          onClick={() => saveEdit(d)}
                          disabled={saving}
                          title={t('myDevices:save')}
                          className="p-1 rounded text-green-300 hover:bg-green-500/20 disabled:opacity-50"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={saving}
                          title={t('myDevices:cancel')}
                          className="p-1 rounded text-[var(--pg-text-dim)] hover:bg-[var(--pg-surface-3)] disabled:opacity-50"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 min-w-0 group">
                        <span className="text-[var(--pg-text)] font-medium truncate">
                          {d.display_name || d.device_label || t('myDevices:deviceNameFallback', { os: d.os ?? t('myDevices:unknownOs') })}
                        </span>
                        <button
                          type="button"
                          onClick={() => startEdit(d)}
                          title={t('myDevices:rename')}
                          className="opacity-60 hover:opacity-100 p-1 rounded text-[var(--pg-text-dim)] hover:text-[var(--pg-accent-bright)] hover:bg-[var(--pg-surface-3)] transition-opacity shrink-0"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                    {isCurrent && (
                      <span className="pg-badge pg-badge--accent">
                        {t('myDevices:thisDevice')}
                      </span>
                    )}
                    {!hasActive && !isCurrent && (
                      <span className="pg-badge">
                        {t('myDevices:loggedOut')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-[var(--pg-text-dim)] mt-1">
                    {[d.os, d.os_version, d.app_version && t('myDevices:appVersion', { version: d.app_version })]
                      .filter(Boolean)
                      .join(' · ')}
                    {d.last_seen_at && ` · ${t('myDevices:lastSeen', { time: formatTimestamp(d.last_seen_at) })}`}
                  </div>
                </div>
                <button
                  onClick={() => handleRevoke(d.id)}
                  disabled={revokingId === d.id}
                  className="p-2 rounded-lg text-red-300 hover:bg-red-500/20 disabled:opacity-50"
                  title={isCurrent ? t('myDevices:signOutThisDevice') : t('myDevices:revokeDevice')}
                >
                  {revokingId === d.id ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <Trash2 className="w-5 h-5" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function osIcon(os: string | null) {
  switch ((os ?? '').toLowerCase()) {
    case 'ios':
    case 'android':
      return Smartphone;
    case 'ipados':
      return Tablet;
    default:
      return Monitor;
  }
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function extractErrorMessage(err: unknown, t: TFunction): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string } | null;
    return body?.error || t('myDevices:requestFailed', { status: err.status });
  }
  if (err instanceof Error) return err.message;
  return t('myDevices:genericError');
}
