// Full CRUD UI for the local `cards` table (playground-side).
//
// Reads from cardsRepo. Writes also go through cardsRepo, which marks rows
// `sync_state='pending'` so syncOrchestrator's push step replays them to
// studio on the next cycle. CSV import bypasses the local table — it hits
// studio's import_csv endpoint directly and then triggers a manual sync
// cycle so the resulting rows flow back as if they came from any other
// device.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { runCycleNow, getState } from '../../services/syncOrchestrator';
import { on } from '../../services/syncEvents';
import { useAuth } from '../auth/AuthProvider';

type EditState =
  | { kind: 'none' }
  | { kind: 'register'; idStr: string; keyNumberStr: string; keyName: string; color: string }
  | { kind: 'edit'; id: number; keyNumberStr: string; keyName: string; color: string };

type ImportState = { open: false } | { open: true; busy: boolean; dragActive: boolean };

export function CardsManager() {
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
      flashMessage('error', 'Chip ID must be a positive integer');
      return;
    }
    if (!Number.isFinite(keyNumber) || keyNumber <= 0) {
      flashMessage('error', 'Key number must be a positive integer');
      return;
    }
    if (editState.keyName.trim() === '') {
      flashMessage('error', 'Name is required');
      return;
    }
    if (cards.some((c) => c.id === id)) {
      flashMessage('error', `Chip ${id} is already registered locally`);
      return;
    }
    if (cards.some((c) => c.key_number === keyNumber)) {
      setKeyNumberError('This key number is already taken by another card');
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
      flashMessage('success', `Registered ${editState.keyName} (#${keyNumber})`);
      setEditState({ kind: 'none' });
      await reload();
      // Best-effort: trigger an immediate sync cycle so the studio sees it
      // soon. If offline / sync busy, no-op — next normal cycle handles it.
      void runCycleNow('manual').catch(() => undefined);
    } catch (err) {
      flashMessage('error', err instanceof Error ? err.message : 'Register failed');
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async () => {
    if (editState.kind !== 'edit') return;
    setKeyNumberError(null);
    const keyNumber = parseInt(editState.keyNumberStr, 10);
    if (!Number.isFinite(keyNumber) || keyNumber <= 0) {
      flashMessage('error', 'Key number must be a positive integer');
      return;
    }
    if (editState.keyName.trim() === '') {
      flashMessage('error', 'Name is required');
      return;
    }
    if (cards.some((c) => c.id !== editState.id && c.key_number === keyNumber)) {
      setKeyNumberError('This key number is already taken by another card');
      return;
    }
    setBusy(true);
    try {
      await cardsRepo.update(editState.id, {
        key_number: keyNumber,
        key_name: editState.keyName.trim(),
        color: editState.color.trim() === '' ? null : editState.color.trim(),
      });
      flashMessage('success', 'Card updated');
      setEditState({ kind: 'none' });
      await reload();
      void runCycleNow('manual').catch(() => undefined);
    } catch (err) {
      flashMessage('error', err instanceof Error ? err.message : 'Update failed');
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
      flashMessage('success', 'Card deleted');
      setConfirmDelete(null);
      await reload();
      void runCycleNow('manual').catch(() => undefined);
    } catch (err) {
      flashMessage('error', err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const openImport = () => setImportState({ open: true, busy: false, dragActive: false });
  const closeImport = () => setImportState({ open: false });

  const handleImport = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      flashMessage('error', 'Only CSV files are allowed');
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
      if (!token) throw new Error('Not authenticated');

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
        throw new Error(body.error || `Import failed (${res.status})`);
      }
      flashMessage(
        body.skipped > 0 ? 'info' : 'success',
        `Import: ${body.inserted ?? 0} inserted, ${body.updated ?? 0} updated${body.skipped ? `, ${body.skipped} skipped` : ''}`
      );
      await runCycleNow('manual').catch(() => undefined);
      closeImport();
      await reload();
    } catch (err) {
      flashMessage('error', err instanceof Error ? err.message : 'Import failed');
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
    <div className="bg-slate-800/50 rounded-lg p-6">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <CreditCard className="text-blue-400" size={24} />
            <span>Cards</span>
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            {cards.length} card{cards.length === 1 ? '' : 's'} · version {version.toFixed(2)}
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
            onClick={() => runCycleNow('manual')}
            disabled={busy || getState().cycleInFlight}
            className="inline-flex items-center gap-2 px-3 py-2 border border-slate-600 text-slate-300 rounded-lg hover:bg-slate-700 transition-colors text-sm disabled:opacity-50"
            title="Sync cards with studio"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Refresh</span>
          </button>
          <button
            onClick={openImport}
            disabled={busy}
            className="inline-flex items-center gap-2 px-3 py-2 border border-slate-600 text-slate-300 rounded-lg hover:bg-slate-700 transition-colors text-sm disabled:opacity-50"
          >
            <Upload className="w-4 h-4" />
            <span>Import CSV</span>
          </button>
          <button
            onClick={openRegister}
            disabled={busy || editState.kind !== 'none'}
            className="inline-flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-sm disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            <span>Register card</span>
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
        <div className="mb-4 p-4 border border-slate-700 rounded-lg bg-slate-900/40">
          <h3 className="text-sm font-semibold text-white mb-3">Register a new card</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Field label="Chip ID" hint="from the chip itself">
              <input
                type="number"
                min={1}
                value={editState.idStr}
                onChange={(e) => setEditState({ ...editState, idStr: e.target.value })}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. 2145811"
                autoFocus
              />
            </Field>
            <Field label="Key #" hint="display number" error={keyNumberError ?? undefined}>
              <input
                type="number"
                min={1}
                value={editState.keyNumberStr}
                onChange={(e) => setEditState({ ...editState, keyNumberStr: e.target.value })}
                className={`w-full px-3 py-2 bg-slate-800 border rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  keyNumberError ? 'border-red-500' : 'border-slate-600'
                }`}
              />
            </Field>
            <Field label="Name" hint="required">
              <input
                type="text"
                value={editState.keyName}
                onChange={(e) => setEditState({ ...editState, keyName: e.target.value })}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. Alpha"
              />
            </Field>
            <Field label="Color" hint="optional">
              <input
                type="text"
                value={editState.color}
                onChange={(e) => setEditState({ ...editState, color: e.target.value })}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. red"
              />
            </Field>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={submitRegister}
              disabled={busy}
              className="inline-flex items-center gap-2 px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>Save</span>
            </button>
            <button
              onClick={cancelEdit}
              disabled={busy}
              className="inline-flex items-center gap-2 px-3 py-2 border border-slate-600 text-slate-300 hover:bg-slate-700 rounded-lg text-sm disabled:opacity-50"
            >
              <X className="w-4 h-4" />
              <span>Cancel</span>
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <RefreshCw className="w-8 h-8 text-slate-500 animate-spin" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-10 text-center">
          <CreditCard className="w-12 h-12 text-slate-500 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-white mb-1">No cards registered yet</h3>
          <p className="text-slate-400 text-sm">
            Click <strong>Register card</strong> to add one, or use <strong>Import CSV</strong> for bulk import.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-slate-700 rounded-lg">
          <table className="min-w-full divide-y divide-slate-700">
            <thead className="bg-slate-900/60">
              <tr>
                <Th>Key #</Th>
                <Th>Name</Th>
                <Th>Color</Th>
                <Th>Chip ID</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody className="bg-slate-900/20 divide-y divide-slate-700/60">
              {sorted.map((card) => {
                const isEditing = editState.kind === 'edit' && editState.id === card.id;
                if (isEditing) {
                  return (
                    <tr key={card.id} className="bg-slate-900/50">
                      <td className="px-4 py-2">
                        <input
                          type="number"
                          min={1}
                          value={editState.keyNumberStr}
                          onChange={(e) =>
                            setEditState({ ...editState, keyNumberStr: e.target.value })
                          }
                          className={`w-24 px-2 py-1 bg-slate-800 border rounded text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                            keyNumberError ? 'border-red-500' : 'border-slate-600'
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
                          className="w-full px-2 py-1 bg-slate-800 border border-slate-600 rounded text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="text"
                          value={editState.color}
                          onChange={(e) =>
                            setEditState({ ...editState, color: e.target.value })
                          }
                          className="w-full px-2 py-1 bg-slate-800 border border-slate-600 rounded text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </td>
                      <td className="px-4 py-2 text-sm text-slate-400 font-mono">{card.id}</td>
                      <td className="px-4 py-2 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            onClick={submitEdit}
                            disabled={busy}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-xs disabled:opacity-50"
                          >
                            <Save className="w-3 h-3" />
                            <span>Save</span>
                          </button>
                          <button
                            onClick={cancelEdit}
                            disabled={busy}
                            className="inline-flex items-center gap-1 px-2 py-1 border border-slate-600 text-slate-300 hover:bg-slate-700 rounded text-xs disabled:opacity-50"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={card.id} className="hover:bg-slate-800/40 transition-colors">
                    <td className="px-4 py-2 text-sm font-medium text-white">
                      #{card.key_number}
                    </td>
                    <td className="px-4 py-2 text-sm text-white">{card.key_name}</td>
                    <td className="px-4 py-2 text-sm text-slate-300">
                      {card.color || <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-2 text-sm text-slate-400 font-mono">{card.id}</td>
                    <td className="px-4 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => openEdit(card)}
                          disabled={busy || editState.kind !== 'none'}
                          className="inline-flex items-center gap-1 px-2 py-1 text-slate-400 hover:text-white hover:bg-slate-700 rounded text-xs disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Edit"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => handleDelete(card)}
                          disabled={busy || editState.kind !== 'none'}
                          className="inline-flex items-center gap-1 px-2 py-1 text-red-400 hover:text-red-300 hover:bg-red-500/20 rounded text-xs disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Delete"
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-white">Import cards from CSV</h3>
          <button
            onClick={onCancel}
            disabled={busy}
            className="p-1 text-slate-400 hover:text-white disabled:opacity-50"
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
          className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
            busy
              ? 'border-slate-700 bg-slate-800/40 cursor-wait'
              : dragActive
                ? 'border-blue-400 bg-blue-500/10 cursor-pointer'
                : 'border-slate-700 hover:border-slate-500 hover:bg-slate-800/40 cursor-pointer'
          }`}
        >
          <Upload className="w-10 h-10 text-slate-400 mx-auto mb-3" />
          <p className="font-semibold text-white mb-1">
            {busy ? 'Importing…' : 'Drop CSV here or click to browse'}
          </p>
          <p className="text-xs text-slate-400">
            Expected headers: <code className="bg-slate-800 text-slate-200 px-1 rounded">key_name, color, key_number, id</code>
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Existing rows are upserted by chip ID. Upload pushes to studio, then re-syncs locally.
          </p>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 rounded-lg disabled:opacity-50"
          >
            Cancel
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-md p-6">
        <h3 className="text-lg font-bold text-white mb-2">Delete card?</h3>
        <p className="text-sm text-slate-300 mb-1">
          <strong className="text-white">{card.key_name}</strong> (chip <code className="font-mono text-slate-400">{card.id}</code>, key #{card.key_number})
        </p>
        <p className="text-xs text-slate-400 mb-6">
          This deletes the card on studio and on every device on the next sync. It cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 rounded-lg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2 text-left text-xs font-medium text-slate-400 uppercase tracking-wider ${className}`}
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
      <span className="block text-xs font-medium text-slate-300">{label}</span>
      {hint && <span className="block text-xs text-slate-500 mb-1">{hint}</span>}
      {children}
      {error && <span className="block text-xs text-red-400 mt-1">{error}</span>}
    </label>
  );
}

// Re-export the warning icon to keep an import alive — used in callers that
// embed a pending-sync indicator.
export const SyncPendingBadge = ({ operation }: { operation: cardsRepo.CardOperation }) => (
  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 text-amber-300 text-xs rounded-full border border-amber-500/30">
    {operation === 'delete' ? <AlertCircle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
    {operation === 'delete' ? 'pending delete' : operation === 'update' ? 'pending edit' : 'pending'}
  </span>
);
