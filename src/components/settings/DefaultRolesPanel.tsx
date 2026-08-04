import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { loadConfig, saveConfig, CONFIG_CHANGED_EVENT } from '../../utils/config';
import {
  setDefaultMother,
  enqueuePendingOp,
  getDefaultMotherLocal,
  setDefaultMotherLocal,
} from '../../services/lanNetworks';

// Post-onboarding editability (grill Q9). The hotspot creds themselves are now
// authored in studio and pushed down on sync (see plans/studio-authoritative-
// hotspot-creds.md), so there is no per-device "default hotspot" upload toggle
// anymore - "Be the mother on this device" governs whether this machine raises
// the (studio-defined) hotspot. The "default mother" inventory bit stays (no
// secret leaves the device). Writes are best-effort with a durable retry.
export function DefaultRolesPanel() {
  const { t } = useTranslation('onboarding');
  const { t: ts } = useTranslation('settings');
  const [motherOn, setMotherOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // "Be the mother on this device" - an AppConfig flag (mother/hotspot role
  // rework). When on, the device runs `becomeMother` at boot (subject to the LAN
  // fence) and, in hotspot mode, raises the Wi-Fi AP. Not Windows-only: a
  // router-mode mother hosts on any platform. Applied + persisted immediately.
  const [beMother, setBeMother] = useState<boolean | null>(null);

  useEffect(() => {
    const refresh = async () => {
      setMotherOn(await getDefaultMotherLocal());
      const cfg = await loadConfig();
      setBeMother(Boolean(cfg.beMotherWhenAvailable));
    };
    void refresh();
    // Re-read when another flow changes the config (e.g. NotMotherPanel just
    // below cleared beMotherWhenAvailable) so the toggle doesn't go stale.
    const onChanged = () => void refresh();
    window.addEventListener(CONFIG_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CONFIG_CHANGED_EVENT, onChanged);
  }, []);

  async function toggleBeMother(next: boolean) {
    setBusy(true);
    const cfg = await loadConfig();
    await saveConfig({ ...cfg, beMotherWhenAvailable: next });
    setBeMother(next);
    setBusy(false);
  }

  async function toggleMother(next: boolean) {
    setBusy(true);
    try {
      await setDefaultMother(next);
    } catch (err) {
      console.error('[network] set_default_mother failed, queued:', err);
      await enqueuePendingOp({ kind: 'mother', on: next, motherUuid: null });
    }
    await setDefaultMotherLocal(next);
    setMotherOn(next);
    setBusy(false);
  }

  if (motherOn === null) {
    return (
      <div className="pg-panel p-4 flex items-center gap-2 text-[var(--pg-text-dim)]">
        <Loader2 className="w-4 h-4 animate-spin" /> …
      </div>
    );
  }

  return (
    <div className="pg-panel divide-y divide-[var(--pg-line)]">
      <RoleToggle
        label={t('mother.title')}
        description={t('mother.subtitle')}
        value={motherOn}
        busy={busy}
        onChange={toggleMother}
      />
      {beMother !== null && (
        <RoleToggle
          label={ts('beMotherLabel')}
          description={ts('beMotherDesc')}
          value={beMother}
          busy={busy}
          onChange={toggleBeMother}
        />
      )}
    </div>
  );
}

function RoleToggle({
  label,
  description,
  value,
  busy,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  busy: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-4">
      <div className="min-w-0">
        <div className="font-semibold text-[var(--pg-text)]">{label}</div>
        <div className="text-sm text-[var(--pg-text-dim)]">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        disabled={busy}
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-7 w-14 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
          value ? 'bg-[var(--pg-accent)]' : 'bg-[var(--pg-surface-3)]'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 shrink-0 transform rounded-full bg-white transition-transform ${
            value ? 'translate-x-8' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}
