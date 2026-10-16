// Full CRUD UI for the local `cards` table (playground-side).
//
// Reads from cardsRepo. Writes also go through cardsRepo, which marks rows
// `sync_state='pending'` so syncOrchestrator's push step replays them to
// studio on the next cycle. CSV import bypasses the local table - it hits
// studio's import_csv endpoint directly and then triggers a manual sync
// cycle so the resulting rows flow back as if they came from any other
// device.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import {
  CreditCard,
  Plus,
  Upload,
  Pencil,
  Trash2,
  Save,
  X,
  RefreshCw,
  Clock,
  AlertCircle,
} from 'lucide-react';
import * as cardsRepo from '../../services/cardsRepo';
import * as cardsStore from '../../services/cardsStore';
import { syncCardsNow, getState } from '../../services/syncOrchestrator';
import { on } from '../../services/syncEvents';
import { useAuth } from '../auth/AuthProvider';

type EditState =
  | { kind: 'none' }
  | { kind: 'register'; idStr: string; keyNumberStr: string; keyName: string; color: string }
  | { kind: 'edit'; id: number; keyNumberStr: string; keyName: string; color: string };

type ImportState = { open: false } | { open: true; busy: boolean; dragActive: boolean };

export function CardsManager() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [cards, setCards] = useState<cardsRepo.CardRow[]>([]);
  const [version, setVersion] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editState, setEditState] = useState<EditState>({ kind: 'none' });
  const [importState, setImportState] = useState<ImportState>({ open: false });
  const [confirmDelete, setConfirmDelete] = useState<cardsRepo.CardRow | null>(null);
  const [keyNumberError, setKeyNumberError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'info' | 'success' | 'error'; text: string } | null>(
    null
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [rows, state] = await Promise.all([
        cardsRepo.list(),
        cardsStore.get(user.client_id),
      ]);
      setCards(rows);
      setVersion(state?.local_version ?? 0);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void reload();
    const off = on('content:updated', (e) => {
      if (e.kind === 'cards' || e.kind === 'on_demand_cards') void reload();
    });
    return () => off();
  }, [reload]);

  const flashMessage = (kind: 'info' | 'success' | 'error', text: string) => {
    setMessage({ kind, text });
    window.setTimeout(() => setMessage(null), 5000);
  };

  const sorted = useMemo(
    () => [...cards].sort((a, b) => a.key_number - b.key_number || a.id - b.id),
    [cards]
  );

  const suggestNextKeyNumber = () =>
    cards.length === 0 ? 1 : Math.max(...cards.map((c) => c.key_number)) + 1;

  const openRegister = () => {
    setKeyNumberError(null);
    setEditState({
      kind: 'register',
      idStr: '',
      keyNumberStr: String(suggestNextKeyNumber()),
      keyName: '',
      color: '',
    });
  };

  const openEdit = (card: cardsRepo.CardRow) => {
    setKeyNumberError(null);
    setEditState({
      kind: 'edit',
      id: card.id,
      keyNumberStr: String(card.key_number),
      keyName: card.key_name,
      color: card.color ?? '',
    });
  };

  const cancelEdit = () => {
    setEditState({ kind: 'none' });
    setKeyNumberError(null);
  };

  const submitRegister = async () => {
    if (editState.kind !== 'register') return;
    setKeyNumberError(null);
    const id = parseInt(editState.idStr, 10);
    const keyNumber = parseInt(editState.keyNumberStr, 10);
    if (!Number.isFinite(id) || id <= 0) {
      flashMessage('error', t('cardsManager:errChipIdPositive'));
      return;
    }
    if (!Number.isFinite(keyNumber) || keyNumber <= 0) {
      flashMessage('error', t('cardsManager:errKeyNumberPositive'));
      return;
    }
    if (editState.keyName.trim() === '') {
      flashMessage('error', t('cardsManager:errNameRequired'));
      return;
    }
    if (cards.some((c) => c.id === id)) {
      flashMessage('error', t('cardsManager:errChipAlreadyRegistered', { id }));
      return;
    }
    if (cards.some((c) => c.key_number === keyNumber)) {
      setKeyNumberError(t('cardsManager:errKeyNumberTaken'));
      return;
    }

    setBusy(true);
    try {
      await cardsRepo.create({
        id,
        key_number: keyNumber,
        key_name: editState.keyName.trim(),
        color: editState.color.trim() === '' ? null : editState.color.trim(),
      });
      flashMessage(
        'success',
        t('cardsManager:registeredSuccess', { name: editState.keyName, keyNumber })
      );
      setEditState({ kind: 'none' });
      await reload();
      // Best-effort: trigger an immediate sync cycle so the studio sees it
      // soon. If offline / sync busy, no-op - next normal cycle handles it.
      void syncCardsNow().catch(() => undefined);
    } catch (err) {
      flashMessage('error', err instanceof Error ? err.message : t('cardsManager:errRegisterFailed'));
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async () => {
    if (editState.kind !== 'edit') return;
    setKeyNumberError(null);
    const keyNumber = parseInt(editState.keyNumberStr, 10);
    if (!Number.isFinite(keyNumber) || keyNumber <= 0) {
      flashMessage('error', t('cardsManager:errKeyNumberPositive'));
      return;
    }
    if (editState.keyName.trim() === '') {
      flashMessage('error', t('cardsManager:errNameRequired'));
      return;
    }
    if (cards.some((c) => c.id !== editState.id && c.key_number === keyNumber)) {
      setKeyNumberError(t('cardsManager:errKeyNumberTaken'));
      return;
    }
    setBusy(true);
    try {
      await cardsRepo.update(editState.id, {
        key_number: keyNumber,
        key_name: editState.keyName.trim(),
        color: editState.color.trim() === '' ? null : editState.color.trim(),
      });
      flashMessage('success', t('cardsManager:cardUpdated'));
      setEditState({ kind: 'none' });
      await reload();
      void syncCardsNow().catch(() => undefined);
    } catch (err) {
      flashMessage('error', err instanceof Error ? err.message : t('cardsManager:errUpdateFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (card: cardsRepo.CardRow) => {
    setConfirmDelete(card);
  };

  const performDelete = async () => {
    if (!confirmDelete) return;
    const card = confirmDelete;
    setBusy(true);
    try {
      await cardsRepo.remove(card.id);
      flashMessage('success', t('cardsManager:cardDeleted'));
      setConfirmDelete(null);
      await reload();
      void syncCardsNow().catch(() => undefined);
    } catch (err) {
      flashMessage('error', err instanceof Error ? err.message : t('cardsManager:errDeleteFailed'));
    } finally {
      setBusy(false);
    }
  };

  const openImport = () => setImportState({ open: true, busy: false, dragActive: false });
  const closeImport = () => setImportState({ open: false });

  const handleImport = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      flashMessage('error', t('cardsManager:errOnlyCsv'));
      return;
    }
    setImportState({ open: true, busy: true, dragActive: false });
    try {
      // Send the CSV directly to studio. Studio parses + upserts, bumps
      // client_cards_metadata.version, and the next sync cycle pulls all
      // the rows back into our local table.
      const formData = new FormData();
      formData.append('file', file);

      const { loadJwt } = await import('../../services/strongholdStore');
      const token = await loadJwt();
      if (!token) throw new Error(t('cardsManager:errNotAuthenticated'));

      const apiBase =
        (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ||
        'https://studio.taghunter.fr/backend/api';
      const res = await fetch(`${apiBase}/cards.php?action=import_csv`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || t('cardsManager:errImportFailedStatus', { status: res.status }));
      }
      flashMessage(
        body.skipped > 0 ? 'info' : 'success',
        t('cardsManager:importResult', { inserted: body.inserted ?? 0, updated: body.updated ?? 0 }) +
          (body.skipped ? t('cardsManager:importResultSkipped', { skipped: body.skipped }) : '')
      );
      await syncCardsNow().catch(() => undefined);
      closeImport();
      await reload();
    } catch (err) {
      flashMessage('error', err instanceof Error ? err.message : t('cardsManager:errImportFailed'));
      setImportState({ open: true, busy: false, dragActive: false });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    void handleImport(file);
  };

  return (
    <div className="pg-panel p-6">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold text-[var(--pg-text)] flex items-center gap-2">
            <CreditCard className="text-[var(--pg-accent-bright)]" size={24} />
            <span>{t('cardsManager:title')}</span>
          </h2>
          <p className="text-sm text-[var(--pg-text-dim)] mt-1">
            {t('cardsManager:cardCount', { count: cards.length, version: version.toFixed(2) })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={onFileChange}
            className="hidden"
          />
          <button
            onClick={() => void syncCardsNow().catch(() => undefined)}
            disabled={busy || getState().cycleInFlight}
            className="pg-btn pg-btn--ghost pg-btn--sm disabled:opacity-50"
            title={t('cardsManager:refreshTitle')}
          >
            <RefreshCw className="w-4 h-4" />
            <span>{t('cardsManager:refresh')}</span>
          </button>
          <button
            onClick={openImport}
            disabled={busy}
            className="pg-btn pg-btn--ghost pg-btn--sm disabled:opacity-50"
          >
            <Upload className="w-4 h-4" />
            <span>{t('cardsManager:importCsv')}</span>
          </button>
          <button
            onClick={openRegister}
            disabled={busy || editState.kind !== 'none'}
            className="pg-btn pg-btn--primary pg-btn--sm disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            <span>{t('cardsManager:registerCard')}</span>
          </button>
        </div>
      </div>

      {message && (
        <div
          className={`mb-4 px-4 py-2 rounded-lg text-sm border ${
            message.kind === 'success'
              ? 'bg-green-500/10 border-green-500/40 text-green-300'
              : message.kind === 'error'
                ? 'bg-red-500/10 border-red-500/40 text-red-300'
                : 'bg-blue-500/10 border-blue-500/40 text-blue-300'
          }`}
        >
          {message.text}
        </div>
      )}

      {editState.kind === 'register' && (
        <div className="mb-4 p-4 border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] bg-[var(--pg-surface)]">
          <h3 className="text-sm font-semibold text-[var(--pg-text)] mb-3">{t('cardsManager:registerFormTitle')}</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Field label={t('cardsManager:fieldChipId')} hint={t('cardsManager:fieldChipIdHint')}>
              <input
                type="number"
                min={1}
                value={editState.idStr}
                onChange={(e) => setEditState({ ...editState, idStr: e.target.value })}
                className="pg-input !py-2 text-sm"
                placeholder={t('cardsManager:placeholderChipId')}
                autoFocus
              />
            </Field>
            <Field label={t('cardsManager:fieldKeyNumber')} hint={t('cardsManager:fieldKeyNumberHint')} error={keyNumberError ?? undefined}>
              <input
                type="number"
                min={1}
                value={editState.keyNumberStr}
                onChange={(e) => setEditState({ ...editState, keyNumberStr: e.target.value })}
                className={`pg-input !py-2 text-sm ${
                  keyNumberError ? '!border-red-500' : ''
                }`}
              />
            </Field>
            <Field label={t('cardsManager:fieldName')} hint={t('cardsManager:fieldNameHint')}>
              <input
                type="text"
                value={editState.keyName}
                onChange={(e) => setEditState({ ...editState, keyName: e.target.value })}
                className="pg-input !py-2 text-sm"
                placeholder={t('cardsManager:placeholderName')}
              />
            </Field>
            <Field label={t('cardsManager:fieldColor')} hint={t('cardsManager:fieldColorHint')}>
              <input
                type="text"
                value={editState.color}
                onChange={(e) => setEditState({ ...editState, color: e.target.value })}
                className="pg-input !py-2 text-sm"
                placeholder={t('cardsManager:placeholderColor')}
              />
            </Field>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={submitRegister}
              disabled={busy}
              className="inline-flex items-center gap-2 px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded-[var(--pg-radius-md)] text-sm disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{t('cardsManager:save')}</span>
            </button>
            <button
              onClick={cancelEdit}
              disabled={busy}
              className="pg-btn pg-btn--ghost pg-btn--sm disabled:opacity-50"
            >
              <X className="w-4 h-4" />
              <span>{t('cardsManager:cancel')}</span>
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <RefreshCw className="w-8 h-8 text-[var(--pg-text-dim)] animate-spin" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-[var(--pg-radius-md)] border border-[var(--pg-line)] bg-[var(--pg-surface)] p-10 text-center">
          <CreditCard className="w-12 h-12 text-[var(--pg-text-dim)] mx-auto mb-3" />
          <h3 className="text-base font-semibold text-[var(--pg-text)] mb-1">{t('cardsManager:emptyTitle')}</h3>
          <p className="text-[var(--pg-text-dim)] text-sm">
            <Trans i18nKey="cardsManager:emptyBody" components={{ 1: <strong />, 3: <strong /> }} />
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-[var(--pg-line)] rounded-[var(--pg-radius-md)]">
          <table className="min-w-full divide-y divide-[var(--pg-line)]">
            <thead className="bg-[var(--pg-bg)]">
              <tr>
                <Th>{t('cardsManager:thKeyNumber')}</Th>
                <Th>{t('cardsManager:thName')}</Th>
                <Th>{t('cardsManager:thColor')}</Th>
                <Th>{t('cardsManager:thChipId')}</Th>
                <Th className="text-right">{t('cardsManager:thActions')}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--pg-line)]">
              {sorted.map((card) => {
                const isEditing = editState.kind === 'edit' && editState.id === card.id;
                if (isEditing) {
                  return (
                    <tr key={card.id} className="bg-[var(--pg-surface-2)]">
                      <td className="px-4 py-2">
                        <input
                          type="number"
                          min={1}
                          value={editState.keyNumberStr}
                          onChange={(e) =>
                            setEditState({ ...editState, keyNumberStr: e.target.value })
                          }
                          className={`pg-input !w-24 !py-1 text-sm ${
                            keyNumberError ? '!border-red-500' : ''
                          }`}
                        />
                        {keyNumberError && (
                          <div className="text-xs text-red-400 mt-1">{keyNumberError}</div>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="text"
                          value={editState.keyName}
                          onChange={(e) =>
                            setEditState({ ...editState, keyName: e.target.value })
                          }
                          className="pg-input !py-1 text-sm"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="text"
                          value={editState.color}
                          onChange={(e) =>
                            setEditState({ ...editState, color: e.target.value })
                          }
                          className="pg-input !py-1 text-sm"
                        />
                      </td>
                      <td className="px-4 py-2 text-sm text-[var(--pg-text-dim)] font-mono">{card.id}</td>
                      <td className="px-4 py-2 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            onClick={submitEdit}
                            disabled={busy}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-xs disabled:opacity-50"
                          >
                            <Save className="w-3 h-3" />
                            <span>{t('cardsManager:save')}</span>
                          </button>
                          <button
                            onClick={cancelEdit}
                            disabled={busy}
                            className="inline-flex items-center gap-1 px-2 py-1 border border-[var(--pg-line)] text-[var(--pg-text-muted)] hover:bg-[var(--pg-surface-3)] rounded text-xs disabled:opacity-50"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={card.id} className="hover:bg-[var(--pg-surface-2)] transition-colors">
                    <td className="px-4 py-2 text-sm font-medium text-[var(--pg-text)]">
                      #{card.key_number}
                    </td>
                    <td className="px-4 py-2 text-sm text-[var(--pg-text)]">{card.key_name}</td>
                    <td className="px-4 py-2 text-sm text-[var(--pg-text-muted)]">
                      {card.color || <span className="text-[var(--pg-text-dim)]">-</span>}
                    </td>
                    <td className="px-4 py-2 text-sm text-[var(--pg-text-dim)] font-mono">{card.id}</td>
                    <td className="px-4 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => openEdit(card)}
                          disabled={busy || editState.kind !== 'none'}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] hover:bg-[var(--pg-surface-3)] rounded text-xs disabled:opacity-30 disabled:cursor-not-allowed"
                          title={t('cardsManager:editTitle')}
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => handleDelete(card)}
                          disabled={busy || editState.kind !== 'none'}
                          className="inline-flex items-center gap-1 px-2 py-1 text-red-400 hover:text-red-300 hover:bg-red-500/20 rounded text-xs disabled:opacity-30 disabled:cursor-not-allowed"
                          title={t('cardsManager:deleteTitle')}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {importState.open && (
        <ImportCsvModal
          busy={importState.busy}
          dragActive={importState.dragActive}
          onDragChange={(active) =>
            setImportState((s) => (s.open ? { ...s, dragActive: active } : s))
          }
          onCancel={closeImport}
          onPick={() => fileInputRef.current?.click()}
          onDrop={(file) => handleImport(file)}
        />
      )}

      {confirmDelete && (
        <ConfirmDeleteModal
          card={confirmDelete}
          busy={busy}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={performDelete}
        />
      )}
    </div>
  );
}

interface ImportCsvModalProps {
  busy: boolean;
  dragActive: boolean;
  onDragChange: (active: boolean) => void;
  onCancel: () => void;
  onPick: () => void;
  onDrop: (file: File) => void;
}

function ImportCsvModal({
  busy,
  dragActive,
  onDragChange,
  onCancel,
  onPick,
  onDrop,
}: ImportCsvModalProps) {
  const { t } = useTranslation();
  const handleDragEvent = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      onDragChange(true);
    } else if (e.type === 'dragleave') {
      onDragChange(false);
    }
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDragChange(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onDrop(file);
  };
  return (
    <div className="pg-overlay">
      <div className="pg-modal max-w-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-[var(--pg-text)]">{t('cardsManager:importModalTitle')}</h3>
          <button
            onClick={onCancel}
            disabled={busy}
            className="pg-modal-close disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div
          onClick={busy ? undefined : onPick}
          onDragEnter={handleDragEvent}
          onDragOver={handleDragEvent}
          onDragLeave={handleDragEvent}
          onDrop={busy ? undefined : handleDrop}
          className={`border-2 border-dashed rounded-[var(--pg-radius-md)] p-8 text-center transition-colors ${
            busy
              ? 'border-[var(--pg-line)] bg-[var(--pg-surface-2)] cursor-wait'
              : dragActive
                ? 'border-[var(--pg-accent-line)] bg-[var(--pg-accent-tint)] cursor-pointer'
                : 'border-[var(--pg-line)] hover:border-[var(--pg-line-strong)] hover:bg-[var(--pg-surface-2)] cursor-pointer'
          }`}
        >
          <Upload className="w-10 h-10 text-[var(--pg-text-dim)] mx-auto mb-3" />
          <p className="font-semibold text-[var(--pg-text)] mb-1">
            {busy ? t('cardsManager:importing') : t('cardsManager:importDropPrompt')}
          </p>
          <p className="text-xs text-[var(--pg-text-dim)]">
            <Trans
              i18nKey="cardsManager:importExpectedHeaders"
              components={{
                1: <code className="bg-[var(--pg-surface-3)] text-[var(--pg-text-muted)] px-1 rounded" />,
              }}
            />
          </p>
          <p className="text-xs text-[var(--pg-text-dim)] mt-1">
            {t('cardsManager:importUpsertNote')}
          </p>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={onCancel}
            disabled={busy}
            className="pg-btn pg-btn--ghost disabled:opacity-50"
          >
            {t('cardsManager:cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ConfirmDeleteModalProps {
  card: cardsRepo.CardRow;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDeleteModal({ card, busy, onCancel, onConfirm }: ConfirmDeleteModalProps) {
  const { t } = useTranslation();
  return (
    <div className="pg-overlay">
      <div className="pg-modal max-w-md p-6">
        <h3 className="text-lg font-bold text-[var(--pg-text)] mb-2">{t('cardsManager:deleteModalTitle')}</h3>
        <p className="text-sm text-[var(--pg-text-muted)] mb-1">
          <Trans
            i18nKey="cardsManager:deleteModalBody"
            values={{ name: card.key_name, id: card.id, keyNumber: card.key_number }}
            components={{
              0: <strong className="text-[var(--pg-text)]" />,
              2: <code className="font-mono text-[var(--pg-text-dim)]" />,
            }}
          />
        </p>
        <p className="text-xs text-[var(--pg-text-dim)] mb-6">
          {t('cardsManager:deleteModalWarning')}
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="pg-btn pg-btn--ghost disabled:opacity-50"
          >
            {t('cardsManager:cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="pg-btn pg-btn--danger disabled:opacity-50"
          >
            {busy ? t('cardsManager:deleting') : t('cardsManager:delete')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2 text-left text-xs font-medium text-[var(--pg-text-dim)] uppercase tracking-wider ${className}`}
    >
      {children}
    </th>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-[var(--pg-text-muted)]">{label}</span>
      {hint && <span className="block text-xs text-[var(--pg-text-dim)] mb-1">{hint}</span>}
      {children}
      {error && <span className="block text-xs text-red-400 mt-1">{error}</span>}
    </label>
  );
}

// Re-export the warning icon to keep an import alive - used in callers that
// embed a pending-sync indicator.
export const SyncPendingBadge = ({ operation }: { operation: cardsRepo.CardOperation }) => {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 text-amber-300 text-xs rounded-full border border-amber-500/30">
      {operation === 'delete' ? <AlertCircle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
      {operation === 'delete'
        ? t('cardsManager:pendingDelete')
        : operation === 'update'
          ? t('cardsManager:pendingEdit')
          : t('cardsManager:pending')}
    </span>
  );
};
