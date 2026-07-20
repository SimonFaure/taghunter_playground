import { useEffect, useState } from 'react';
import { Wifi, Server, Check, ServerCog } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AuthUser } from '../../../services/authStore';
import { OnboardingShell } from './OnboardingShell';
import { renameDevice } from '../../../services/auth';
import { setCachedDeviceDisplayName, getDeviceMetadata } from '../../../services/device';
import { loadConfig, saveConfig } from '../../../utils/config';
import { setTheme, getStoredTheme, type ThemeName } from '../../../services/theme';
import {
  setDefaultMother,
  enqueuePendingOp,
  setDefaultMotherLocal,
} from '../../../services/lanNetworks';
import {
  ONBOARDING_KEYS,
  markStepAnswered,
  markOnboardingComplete,
  firstUnansweredPostPinStep,
  type PostPinStep,
} from '../../../services/onboardingStore';

// Steps: name → hotspot → mother → operator-only → appearance. Forward-only into
// here from the PIN gate; Back is allowed among these steps (all idempotent re-writes).
// The studio writes are best-effort (grill Q13): the LOCAL effect applies first,
// the announce is attempted, and a failure enqueues a durable retry - never
// blocking. Finish (appearance) commits onboarding_completed.

interface Props {
  user: AuthUser;
  onComplete: () => void;
}

const THEMES: { id: ThemeName; key: string }[] = [
  { id: 'red', key: 'appearance.red' },
  { id: 'blue', key: 'appearance.blue' },
  { id: 'red-light', key: 'appearance.redLight' },
  { id: 'blue-light', key: 'appearance.blueLight' },
];

export function PostPinOnboarding({ user, onComplete }: Props) {
  const [step, setStep] = useState<PostPinStep | null>(null);
  const [busy, setBusy] = useState(false);

  // Resume at the first unanswered step (crash-safety / migration).
  useEffect(() => {
    void (async () => setStep(await firstUnansweredPostPinStep()))();
  }, []);

  if (!step) return null;

  if (step === 'name') {
    return (
      <NameStep
        user={user}
        busy={busy}
        setBusy={setBusy}
        onDone={() => setStep('hotspot')}
      />
    );
  }
  if (step === 'hotspot') {
    return (
      <HotspotStep
        busy={busy}
        setBusy={setBusy}
        onBack={() => setStep('name')}
        onDone={() => setStep('mother')}
      />
    );
  }
  if (step === 'mother') {
    return (
      <MotherStep
        busy={busy}
        setBusy={setBusy}
        onBack={() => setStep('hotspot')}
        onDone={() => setStep('operatorOnly')}
      />
    );
  }
  if (step === 'operatorOnly') {
    return (
      <OperatorOnlyStep
        busy={busy}
        setBusy={setBusy}
        onBack={() => setStep('mother')}
        onDone={() => setStep('appearance')}
      />
    );
  }
  return (
    <AppearanceStep
      busy={busy}
      setBusy={setBusy}
      onBack={() => setStep('operatorOnly')}
      onDone={async () => {
        await markOnboardingComplete();
        onComplete();
      }}
    />
  );
}

// ── Step 4: name this device ────────────────────────────────────────────────
function NameStep({
  user,
  busy,
  setBusy,
  onDone,
}: {
  user: AuthUser;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation('onboarding');
  const [name, setName] = useState('');

  // Pre-fill with the OS hostname (the current device_label fallback).
  useEffect(() => {
    void (async () => {
      const meta = await getDeviceMetadata();
      setName((prev) => prev || meta.device_label || '');
    })();
  }, []);

  async function handleContinue() {
    setBusy(true);
    const trimmed = name.trim();
    if (trimmed && user.current_device_id) {
      try {
        await renameDevice(user.current_device_id, trimmed);
        await setCachedDeviceDisplayName(trimmed);
      } catch (err) {
        // Best-effort: a rename failure shouldn't trap onboarding. The name can
        // be set later in Settings → My Devices.
        console.error('[onboarding] device rename failed:', err);
      }
    }
    await markStepAnswered(ONBOARDING_KEYS.named);
    setBusy(false);
    onDone();
  }

  return (
    <OnboardingShell
      stepNumber={5}
      title={t('name.title')}
      subtitle={t('name.subtitle')}
      onPrimary={handleContinue}
      busy={busy}
      primaryDisabled={!name.trim()}
    >
      <label className="block">
        <span className="pg-label block mb-2">{t('name.label')}</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('name.placeholder')}
          autoFocus
          className="pg-input"
        />
      </label>
    </OnboardingShell>
  );
}

// ── Step 5: default hotspot ─────────────────────────────────────────────────
function HotspotStep({
  busy,
  setBusy,
  onBack,
  onDone,
}: {
  busy: boolean;
  setBusy: (b: boolean) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation('onboarding');
  const [choice, setChoice] = useState<boolean>(false); // default No

  async function handleContinue() {
    setBusy(true);
    if (choice) {
      // Be a hotspot-mode mother on this device (mother/hotspot role rework):
      // the device hosts games and raises the AP at boot. The live AP starts
      // NEXT launch, not now (so the remaining online steps keep internet). The
      // hotspot creds themselves are authored in studio and arrive on sync -
      // nothing is uploaded from here anymore.
      const cfg = await loadConfig();
      await saveConfig({ ...cfg, beMotherWhenAvailable: true, startHotspotOnLaunch: true });
    }
    await markStepAnswered(ONBOARDING_KEYS.hotspot);
    setBusy(false);
    onDone();
  }

  return (
    <OnboardingShell
      stepNumber={6}
      title={t('hotspot.title')}
      subtitle={t('hotspot.subtitle')}
      onPrimary={handleContinue}
      onBack={onBack}
      busy={busy}
    >
      <ChoiceCard
        icon={<Wifi className="w-5 h-5" />}
        label={t('hotspot.yes')}
        active={choice}
        onClick={() => setChoice(true)}
      />
      <ChoiceCard
        label={t('hotspot.no')}
        active={!choice}
        onClick={() => setChoice(false)}
      />
      {choice && (
        <p className="text-xs text-[var(--pg-text-dim)] pt-1">{t('hotspot.note')}</p>
      )}
    </OnboardingShell>
  );
}

// ── Step 6: default mother ──────────────────────────────────────────────────
function MotherStep({
  busy,
  setBusy,
  onBack,
  onDone,
}: {
  busy: boolean;
  setBusy: (b: boolean) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation('onboarding');
  const [choice, setChoice] = useState<boolean>(false); // default No

  async function handleContinue() {
    setBusy(true);
    if (choice) {
      try {
        await setDefaultMother(true);
      } catch (err) {
        console.error('[onboarding] set_default_mother failed, queued:', err);
        await enqueuePendingOp({ kind: 'mother', on: true, motherUuid: null });
      }
      // Designating this device as the venue's mother also makes it boot as the
      // mother (mother/hotspot role rework). Router-mode mothers raise no AP.
      const cfg = await loadConfig();
      await saveConfig({ ...cfg, beMotherWhenAvailable: true });
    }
    await setDefaultMotherLocal(choice);
    await markStepAnswered(ONBOARDING_KEYS.mother);
    setBusy(false);
    onDone();
  }

  return (
    <OnboardingShell
      stepNumber={7}
      title={t('mother.title')}
      subtitle={t('mother.subtitle')}
      onPrimary={handleContinue}
      onBack={onBack}
      busy={busy}
    >
      <ChoiceCard
        icon={<Server className="w-5 h-5" />}
        label={t('mother.yes')}
        active={choice}
        onClick={() => setChoice(true)}
      />
      <ChoiceCard label={t('mother.no')} active={!choice} onClick={() => setChoice(false)} />
    </OnboardingShell>
  );
}

// ── Step 7: operator-only device ────────────────────────────────────────────
function OperatorOnlyStep({
  busy,
  setBusy,
  onBack,
  onDone,
}: {
  busy: boolean;
  setBusy: (b: boolean) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation('onboarding');
  const [choice, setChoice] = useState<boolean>(false); // default No (plays games)

  async function handleContinue() {
    setBusy(true);
    // Fresh device - nothing downloaded yet, so we just persist the flag (no
    // reset/resync). Set BEFORE the first content sync runs (sync starts only
    // after onboarding completes), so the very first download is already slim.
    try {
      const cfg = await loadConfig();
      await saveConfig({ ...cfg, operatorOnlyDevice: choice });
    } catch (err) {
      console.error('[onboarding] saving operator-only flag failed:', err);
    }
    await markStepAnswered(ONBOARDING_KEYS.operatorOnly);
    setBusy(false);
    onDone();
  }

  return (
    <OnboardingShell
      stepNumber={8}
      title={t('operatorOnly.title')}
      subtitle={t('operatorOnly.subtitle')}
      onPrimary={handleContinue}
      onBack={onBack}
      busy={busy}
    >
      <ChoiceCard
        icon={<ServerCog className="w-5 h-5" />}
        label={t('operatorOnly.yes')}
        active={choice}
        onClick={() => setChoice(true)}
      />
      <ChoiceCard label={t('operatorOnly.no')} active={!choice} onClick={() => setChoice(false)} />
      <p className="text-xs text-[var(--pg-text-dim)] pt-1 leading-relaxed">
        {t('operatorOnly.explainer')}
      </p>
    </OnboardingShell>
  );
}

// ── Step 8: appearance (commits onboarding_completed) ───────────────────────
function AppearanceStep({
  busy,
  setBusy,
  onBack,
  onDone,
}: {
  busy: boolean;
  setBusy: (b: boolean) => void;
  onBack: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation('onboarding');
  const [selected, setSelected] = useState<ThemeName>(getStoredTheme());

  function pick(theme: ThemeName) {
    setSelected(theme);
    setTheme(theme); // apply live
  }

  async function handleFinish() {
    setBusy(true);
    setTheme(selected);
    await onDone();
    setBusy(false);
  }

  return (
    <OnboardingShell
      stepNumber={9}
      title={t('appearance.title')}
      subtitle={t('appearance.subtitle')}
      onPrimary={handleFinish}
      primaryLabel={t('finish')}
      onBack={onBack}
      busy={busy}
    >
      <div className="grid grid-cols-2 gap-2">
        {THEMES.map((th) => (
          <button
            key={th.id}
            type="button"
            onClick={() => pick(th.id)}
            className={`flex items-center justify-between px-4 py-3 rounded-lg border text-left transition ${
              selected === th.id
                ? 'border-[var(--pg-accent-line)] bg-[var(--pg-accent-tint)]'
                : 'border-[var(--pg-line)] hover:bg-[var(--pg-surface-2)]'
            }`}
          >
            <span className="text-[var(--pg-text)] text-sm font-medium">{t(th.key)}</span>
            {selected === th.id && <Check className="w-4 h-4 text-[var(--pg-accent-bright)]" />}
          </button>
        ))}
      </div>
    </OnboardingShell>
  );
}

// Shared yes/no choice row.
function ChoiceCard({
  icon,
  label,
  active,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition ${
        active
          ? 'border-[var(--pg-accent-line)] bg-[var(--pg-accent-tint)]'
          : 'border-[var(--pg-line)] hover:bg-[var(--pg-surface-2)]'
      }`}
    >
      {icon && <span className="text-[var(--pg-accent-bright)]">{icon}</span>}
      <span className="text-[var(--pg-text)] text-sm font-medium">{label}</span>
    </button>
  );
}
