import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Settings,
  Usb,
  RefreshCw,
  Check,
  Globe,
  Monitor,
  Sliders,
  Cpu,
  CloudCog,
  Smartphone,
  BookOpen,
  User as UserIcon,
  Play,
  Square,
  Trash2,
  Activity,
  AlertCircle,
  AlertTriangle,
  Download,
  Upload,
  HardDriveDownload,
  Image as ImageIcon,
} from 'lucide-react';
import { enable as enableAutostart, disable as disableAutostart } from '@tauri-apps/plugin-autostart';
import {
  sportidentService,
  type CardData,
  type StationData,
} from '../services/sportidentService';
import { useDetectedReaderPort } from '../services/useDetectedReaderPort';
import { useDriverState } from '../services/useDriverState';
import { loadConfig, saveConfig, AppConfig } from '../utils/config';
import {
  extForFile,
  isSupportedLogoExt,
  mimeForExt,
  readLaunchLogoUrl,
  removeLaunchLogo,
  writeLaunchLogo,
} from '../utils/launchLogo';
import * as cardsRepo from '../services/cardsRepo';
import { on } from '../services/syncEvents';
import { runCycleNow } from '../services/syncOrchestrator';
import { useAuth } from './auth/AuthProvider';
import { AccountScreen } from './settings/AccountScreen';
import { SyncStatusScreen } from './settings/SyncStatusScreen';
import { MyDevicesScreen } from './settings/MyDevicesScreen';
import { UpdatesScreen } from './settings/UpdatesScreen';
import { UsbDriverScreen } from './settings/UsbDriverScreen';
import { ApiDocsPage } from './ApiDocsPage';

const DEFAULT_CONFIG: AppConfig = {
  language: 'english',
  fullscreenOnLaunch: false,
  autoLaunch: false,
  logoScreenOnLaunch: false,
  logoScreenBgColor: '#000000',
  logoScreenLogoFile: null,
};

export type SettingsTab =
  | 'account'
  | 'general'
  | 'hardware'
  | 'sync'
  | 'devices'
  | 'updates'
  | 'api-docs'
  | 'usb-driver';

interface ConfigurationPageProps {
  // When the user clicks the sync pill or failure banner, App sets this to
  // 'sync' to deep-link into the right tab. The value is consumed once on
  // change (the parent flips it back to undefined afterwards) — we don't
  // want subsequent in-page tab clicks to be overridden by the prop.
  initialTab?: SettingsTab;
}

export function ConfigurationPage({ initialTab }: ConfigurationPageProps = {}) {
  const auth = useAuth();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'account');

  // Honor a fresh deep-link request: if the parent passes a new initialTab
  // (e.g., user clicks the pill while already on the settings page but a
  // different tab), switch to it. Compared with the previous prop value to
  // avoid clobbering a manual tab change after the deep-link landed.
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [savedConfig, setSavedConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // A logo picked but not yet saved. Held in memory (bytes + a preview
  // object URL) so cancelling without Save leaves no orphan file in AppData.
  const [pickedLogo, setPickedLogo] = useState<{
    bytes: Uint8Array;
    ext: string;
    url: string;
  } | null>(null);
  // Object URL for the already-saved custom logo file, used in the preview.
  const [savedLogoUrl, setSavedLogoUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadConfiguration();
  }, []);

  const loadConfiguration = async () => {
    try {
      const loaded = await loadConfig();
      setConfig(loaded);
      setSavedConfig(loaded);
      if (loaded.logoScreenLogoFile) {
        setSavedLogoUrl(await readLaunchLogoUrl(loaded.logoScreenLogoFile));
      }
    } catch (err) {
      console.error('Error loading configuration:', err);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      let finalConfig = config;
      if (pickedLogo) {
        // Persist a freshly picked logo to AppData.
        const filename = await writeLaunchLogo(
          pickedLogo.bytes,
          pickedLogo.ext,
          savedConfig.logoScreenLogoFile,
        );
        finalConfig = { ...config, logoScreenLogoFile: filename };
      } else if (!config.logoScreenLogoFile && savedConfig.logoScreenLogoFile) {
        // Logo was removed — delete the previously saved file.
        await removeLaunchLogo(savedConfig.logoScreenLogoFile);
      }

      await saveConfig(finalConfig);

      // Sync the OS autostart registration if the toggle changed. There is
      // no "next launch" for an OS registration, so this applies on Save.
      if (Boolean(finalConfig.autoLaunch) !== Boolean(savedConfig.autoLaunch)) {
        try {
          if (finalConfig.autoLaunch) await enableAutostart();
          else await disableAutostart();
        } catch (e) {
          console.error('Error updating autostart registration:', e);
        }
      }

      setConfig(finalConfig);
      setSavedConfig(finalConfig);
      // The picked logo is now the saved logo — adopt its preview URL.
      if (pickedLogo) {
        setSavedLogoUrl(pickedLogo.url);
        setPickedLogo(null);
      } else if (!finalConfig.logoScreenLogoFile) {
        setSavedLogoUrl(null);
      }
      setMessage({ type: 'success', text: 'Configuration saved' });
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      console.error('Error saving configuration:', err);
      setMessage({ type: 'error', text: 'Failed to save configuration' });
    } finally {
      setIsSaving(false);
    }
  };

  const handlePickLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    const ext = extForFile(file);
    if (!isSupportedLogoExt(ext)) {
      setMessage({
        type: 'error',
        text: 'Unsupported image format. Use PNG, JPG, SVG, WebP or GIF.',
      });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMessage({ type: 'error', text: 'Logo image is too large (max 5 MB).' });
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeForExt(ext) }));
      setPickedLogo({ bytes, ext, url });
      setConfig((c) => ({ ...c, logoScreenLogoFile: `launch-logo.${ext}` }));
    } catch (err) {
      console.error('Error reading logo file:', err);
      setMessage({ type: 'error', text: 'Could not read that image.' });
    }
  };

  const handleRemoveLogo = () => {
    setPickedLogo(null);
    setConfig((c) => ({ ...c, logoScreenLogoFile: null }));
  };

  const dirty =
    JSON.stringify(config) !== JSON.stringify(savedConfig) || pickedLogo !== null;
  const showAppConfigUi = activeTab === 'general' || activeTab === 'hardware';
  // Preview source: a fresh pick > the saved custom file > bundled fallback.
  const previewLogoUrl =
    pickedLogo?.url ??
    (config.logoScreenLogoFile ? savedLogoUrl : null) ??
    '/taghunter-logo.png';
  const hasCustomLogo = pickedLogo !== null || Boolean(config.logoScreenLogoFile);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white py-8">
      <div className="container mx-auto px-6">
        <div className="flex items-center gap-3 mb-8">
          <Settings className="text-blue-400" size={32} />
          <h1 className="text-3xl font-bold">Configuration</h1>
        </div>

        <div className="flex gap-6">
          <aside className="w-56 shrink-0">
            <SettingsNav active={activeTab} onChange={setActiveTab} />
          </aside>

          <main className="flex-1 min-w-0 max-w-4xl">
            {showAppConfigUi && message && (
              <div
                className={`mb-6 p-4 rounded-lg ${
                  message.type === 'success'
                    ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                    : 'bg-red-500/20 text-red-400 border border-red-500/30'
                }`}
              >
                {message.text}
              </div>
            )}

            {activeTab === 'general' && (
              <>
                <Section icon={<Globe className="text-blue-400" size={24} />} title="Language">
                  <div className="grid grid-cols-2 gap-4">
                    <ChoiceCard
                      active={config.language === 'english'}
                      onClick={() => setConfig({ ...config, language: 'english' })}
                      title="English"
                      subtitle="English language"
                    />
                    <ChoiceCard
                      active={config.language === 'french'}
                      onClick={() => setConfig({ ...config, language: 'french' })}
                      title="Français"
                      subtitle="French language"
                    />
                  </div>
                </Section>

                <Section icon={<Monitor className="text-blue-400" size={24} />} title="Display Settings">
                  <Toggle
                    label="Fullscreen on launch"
                    description="Open the app in fullscreen when it starts. Press F11 any time to exit or re-enter fullscreen. Takes effect next launch."
                    value={Boolean(config.fullscreenOnLaunch)}
                    onChange={(v) => setConfig({ ...config, fullscreenOnLaunch: v })}
                  />
                  <Toggle
                    label="Launch on startup"
                    description="Start automatically when your computer boots."
                    value={Boolean(config.autoLaunch)}
                    onChange={(v) => setConfig({ ...config, autoLaunch: v })}
                  />
                </Section>

                <Section
                  icon={<ImageIcon className="text-blue-400" size={24} />}
                  title="Launch logo screen"
                >
                  <Toggle
                    label="Logo screen on launch"
                    description="Show a branded logo screen instead of the home page when the app starts. Tap anywhere to continue. Takes effect next launch."
                    value={Boolean(config.logoScreenOnLaunch)}
                    onChange={(v) => setConfig({ ...config, logoScreenOnLaunch: v })}
                  />

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                    <div className="space-y-4 p-4 rounded-lg border-2 border-slate-700 bg-slate-700/30">
                      <div>
                        <div className="font-semibold mb-1">Logo</div>
                        <div className="text-sm text-slate-400 mb-2">
                          PNG, JPG, SVG or WebP. A transparent background works best.
                          Without a custom logo the TagHunter logo is shown.
                        </div>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/*"
                          onChange={handlePickLogo}
                          className="hidden"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => fileInputRef.current?.click()}
                            className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors text-sm"
                          >
                            <Upload size={14} />
                            {hasCustomLogo ? 'Replace logo' : 'Upload logo'}
                          </button>
                          {hasCustomLogo && (
                            <button
                              onClick={handleRemoveLogo}
                              className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors text-sm"
                            >
                              <Trash2 size={14} />
                              Remove
                            </button>
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="font-semibold mb-1">Background color</div>
                        <div className="flex items-center gap-3">
                          <input
                            type="color"
                            value={config.logoScreenBgColor ?? '#000000'}
                            onChange={(e) =>
                              setConfig({ ...config, logoScreenBgColor: e.target.value })
                            }
                            className="h-10 w-16 rounded bg-transparent cursor-pointer border border-slate-600"
                          />
                          <span className="font-mono text-sm text-slate-400">
                            {(config.logoScreenBgColor ?? '#000000').toUpperCase()}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div>
                      <div className="font-semibold mb-1">Preview</div>
                      <div
                        className="rounded-lg border border-slate-700 overflow-hidden w-full"
                        style={{
                          aspectRatio: '16 / 9',
                          backgroundColor: config.logoScreenBgColor ?? '#000000',
                        }}
                      >
                        <div className="w-full h-full flex items-center justify-center p-6">
                          <img
                            src={previewLogoUrl}
                            alt=""
                            className="max-w-[60%] max-h-[60%] object-contain"
                          />
                        </div>
                      </div>
                      {!hasCustomLogo && (
                        <div className="text-xs text-slate-500 mt-1">
                          No custom logo — showing the TagHunter logo.
                        </div>
                      )}
                    </div>
                  </div>
                </Section>

                <SaveBar dirty={dirty} isSaving={isSaving} onSave={handleSave} />
              </>
            )}

            {activeTab === 'hardware' && (
              <>
                <ReaderStatusSection
                  onOpenUsbDriver={() => setActiveTab('usb-driver')}
                />
                <CardReaderTestSection />
              </>
            )}

            {activeTab === 'account' && <AccountScreen />}
            {activeTab === 'sync' && <SyncStatusScreen />}
            {activeTab === 'devices' && <MyDevicesScreen onLoggedOut={auth.refresh} />}
            {activeTab === 'updates' && <UpdatesScreen />}
            {activeTab === 'api-docs' && <ApiDocsPage />}
            {activeTab === 'usb-driver' && <UsbDriverScreen />}
          </main>
        </div>
      </div>
    </div>
  );
}

interface SectionProps {
  icon: React.ReactNode;
  title: string;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}

function Section({ icon, title, headerExtra, children }: SectionProps) {
  return (
    <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-xl font-semibold">{title}</h2>
        </div>
        {headerExtra}
      </div>
      {children}
    </div>
  );
}

function ChoiceCard({
  active,
  onClick,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`p-4 rounded-lg border-2 transition-all ${
        active ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 bg-slate-700/30 hover:border-slate-600'
      }`}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold text-lg">{title}</div>
          <div className="text-sm text-slate-400">{subtitle}</div>
        </div>
        {active && <Check className="text-blue-400" size={24} />}
      </div>
    </button>
  );
}

function Toggle({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between p-4 rounded-lg border-2 border-slate-700 bg-slate-700/30 hover:border-slate-600 transition-all mb-3">
      <div>
        <div className="font-semibold text-lg">{label}</div>
        <div className="text-sm text-slate-400">{description}</div>
      </div>
      <button
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-7 w-14 items-center rounded-full transition-colors ${
          value ? 'bg-blue-600' : 'bg-slate-600'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
            value ? 'translate-x-8' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

function SaveBar({
  dirty,
  isSaving,
  onSave,
}: {
  dirty: boolean;
  isSaving: boolean;
  onSave: () => void;
}) {
  return (
    <div className="flex justify-end mb-6">
      <button
        onClick={onSave}
        disabled={isSaving || !dirty}
        className="flex items-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-semibold"
      >
        {isSaving ? (
          <>
            <RefreshCw size={16} className="animate-spin" />
            Saving…
          </>
        ) : (
          <>
            <Check size={16} />
            Save configuration
          </>
        )}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Card-reader test panel
// ─────────────────────────────────────────────────────────────────────────────
//
// Operator-facing diagnostic: pick a USB port above, hit Start, then punch
// cards into the SI master station. Each card's full readout streams into
// the list below — start/finish/check punches and every code on the card.
// Useful for verifying:
//   - the dongle is detected on the right port
//   - the master station is awake and forwarding 0xE8 notifications
//   - the cards we expect to use at an event actually parse correctly
//
// Lifecycle: starts a global reader via `sportidentService`. On tab switch
// or unmount, the useEffect cleanup stops it. Note this is the same singleton
// the game pages use — running this test while a game is mid-flight would
// fight for the port; the use case for that doesn't exist (settings panel
// is reached from the home screen, not mid-game).

interface CardWithReceivedAt {
  card: CardData;
  receivedAt: Date;
}

// Read-only status block showing the auto-detected reader port. Replaces the
// old port-picker section: there's no choice to be made — the app filters
// available ports by VID 10c4 / PID 800a and takes the first match.
function ReaderStatusSection({ onOpenUsbDriver }: { onOpenUsbDriver: () => void }) {
  const { port, detail, isPresent, refresh } = useDetectedReaderPort();
  const { state: driverState, recheck: recheckDriver } = useDriverState();
  const available = sportidentService.isAvailable();

  // The Refresh button refreshes both the port enumeration AND the driver-
  // state probe so a fresh plug or driver swap reflects immediately, not on
  // the next Footer poll tick.
  const refreshAll = () => {
    refresh();
    recheckDriver();
  };

  return (
    <Section
      icon={<Usb className="text-blue-400" size={24} />}
      title="Reader"
      headerExtra={
        <button
          onClick={refreshAll}
          disabled={!available}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      }
    >
      {!available ? (
        <div className="text-sm text-slate-400">
          Reader detection is only available inside the Tauri desktop app.
        </div>
      ) : isPresent && port ? (
        <div className="rounded-lg border-2 border-green-500/40 bg-green-500/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <Check className="text-green-400 flex-shrink-0" size={18} />
            <span className="font-mono font-semibold text-green-300">{port}</span>
            <span className="text-sm text-slate-400">
              ({detail?.manufacturer ?? 'Silicon Labs CP210x'})
            </span>
          </div>
          <div className="text-xs text-slate-500 mt-1 ml-7">
            Detected by USB VID/PID. The app auto-binds at game start.
          </div>
        </div>
      ) : driverState.kind === 'blocked_by_policy' ? (
        // SetupDi saw a CP210x device with CM problem code 39/40 — the
        // Vulnerable Driver Blocklist or HVCI refused silabser.sys. The
        // hardware is plugged in; the driver just isn't loading.
        <div className="rounded-lg border-2 border-red-500/50 bg-red-500/10 px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="text-red-400 flex-shrink-0 mt-0.5" size={18} />
            <div className="flex-1 min-w-0">
              <div className="text-red-300 font-medium">
                We see a SportIdent reader, but Windows blocked its driver
              </div>
              <div className="text-xs text-slate-400 mt-1">
                The Vulnerable Driver Blocklist is refusing the legacy
                silabser.sys. Install the signed Universal driver to fix
                it — no Memory Integrity change needed.
              </div>
              <div className="mt-2 flex items-center gap-3 flex-wrap">
                <button
                  disabled
                  title="Coming in the next build"
                  className="inline-flex items-center gap-2 px-3 py-1.5 bg-red-600/60 rounded font-medium text-white text-sm opacity-60 cursor-not-allowed"
                >
                  <HardDriveDownload size={14} />
                  Install signed driver
                  <span className="text-xs uppercase tracking-wider opacity-80">
                    (coming soon)
                  </span>
                </button>
                <button
                  onClick={onOpenUsbDriver}
                  className="inline-flex items-center gap-1.5 text-xs text-blue-300 hover:text-blue-200 underline underline-offset-2"
                >
                  Learn more
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border-2 border-orange-500/40 bg-orange-500/10 px-4 py-3 flex items-start gap-2">
          <AlertCircle className="text-orange-400 flex-shrink-0 mt-0.5" size={18} />
          <div>
            <div className="text-orange-300 font-medium">No SportIdent reader detected</div>
            <div className="text-xs text-slate-400 mt-1">
              Plug in your reader. The footer's reader indicator will turn green when it's online.
            </div>
            <button
              onClick={onOpenUsbDriver}
              className="mt-2 inline-flex items-center gap-1.5 text-xs text-blue-300 hover:text-blue-200 underline underline-offset-2"
            >
              <Usb size={13} />
              Driver blocked or missing? Install the SportIdent USB driver
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

function CardReaderTestSection() {
  const { port: detectedPort, isPresent } = useDetectedReaderPort();
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cards, setCards] = useState<CardWithReceivedAt[]>([]);
  const [station, setStation] = useState<StationData | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const available = sportidentService.isAvailable();
  const canStart = available && isPresent && !running && !busy;

  const handleStart = async () => {
    if (!canStart || !detectedPort) return;
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage('Opening port…');
    try {
      // Wire callbacks BEFORE starting the reader so we don't miss the
      // first events the master fires after wakeup. Both callbacks
      // overwrite any previous registration on this singleton service.
      sportidentService.setCardDetectedCallback((card) => {
        setCards((prev) => [{ card, receivedAt: new Date() }, ...prev]);
      });
      sportidentService.setStationsDetectedCallback((detected) => {
        setStation(detected[0] ?? null);
      });

      const initialized = await sportidentService.initializePort(detectedPort);
      if (!initialized) {
        setErrorMessage(
          "Failed to open the port. Check the cable, that no other app holds it, and try Refresh above.",
        );
        setStatusMessage(null);
        return;
      }
      await sportidentService.start();
      setRunning(true);
      setStatusMessage('Listening — punch a card into the station to see its data appear.');
    } catch (err) {
      setErrorMessage(`Couldn't start: ${err}`);
      setStatusMessage(null);
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    try {
      await sportidentService.stop();
      setStatusMessage('Stopped.');
    } catch (err) {
      setErrorMessage(`Error stopping: ${err}`);
    } finally {
      setRunning(false);
      setBusy(false);
    }
  };

  const handleClear = () => {
    setCards([]);
    setStation(null);
    if (!running) setStatusMessage(null);
  };

  // Clean shutdown on tab-switch or unmount. The hardware tab is
  // conditionally rendered in the parent, so unmount fires whenever the
  // user picks a different settings tab — exactly when we want to stop.
  useEffect(() => {
    return () => {
      if (running) {
        void sportidentService.stop();
      }
    };
  }, [running]);

  return (
    <Section
      icon={<Activity className="text-blue-400" size={24} />}
      title="Card reader test"
      headerExtra={
        <div className="flex items-center gap-2">
          {cards.length > 0 && (
            <button
              onClick={handleClear}
              className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors text-sm"
            >
              <Trash2 size={14} />
              Clear ({cards.length})
            </button>
          )}
          {running ? (
            <button
              onClick={handleStop}
              disabled={busy}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors"
            >
              <Square size={16} />
              Stop test
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={!canStart}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors"
            >
              <Play size={16} />
              Start test
            </button>
          )}
        </div>
      }
    >
      {!available && (
        <div className="text-sm text-slate-400 mb-3">
          Reader test is only available inside the Tauri desktop app.
        </div>
      )}
      {available && !isPresent && (
        <div className="text-sm text-slate-400 mb-3">
          Plug in your SportIdent reader to enable the test.
        </div>
      )}

      {statusMessage && (
        <div className="mb-3 rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-2 text-sm text-slate-300">
          <span className={running ? 'text-green-400' : 'text-slate-400'}>●</span>{' '}
          {statusMessage}
        </div>
      )}
      {errorMessage && (
        <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300 flex items-start gap-2">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      )}
      {station && (
        <div className="mb-4 rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-3 text-sm">
          <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Master station</div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-slate-300">
            <span>
              <span className="text-slate-500">#</span>
              {station.stationNumber}
            </span>
            <span>
              <span className="text-slate-500">mode </span>
              {station.stationMode}
            </span>
            {station.extended && <span className="text-blue-400">extended</span>}
            {station.autoSend && <span className="text-blue-400">auto-send</span>}
            {station.handShake && <span className="text-blue-400">handshake</span>}
          </div>
        </div>
      )}

      {cards.length === 0 ? (
        <div className="text-center py-10 text-slate-500 text-sm">
          {running
            ? 'Waiting for a card…'
            : 'No cards yet. Start the test, then punch a card to see its data here.'}
        </div>
      ) : (
        <div className="space-y-3">
          {cards.map((c, i) => (
            <CardRow key={`${c.card.id}-${c.receivedAt.getTime()}-${i}`} entry={c} />
          ))}
        </div>
      )}
    </Section>
  );
}

function CardRow({ entry }: { entry: CardWithReceivedAt }) {
  const { card, receivedAt } = entry;
  const [registered, setRegistered] = useState<cardsRepo.CardRow | null>(null);
  const [showRegister, setShowRegister] = useState(false);
  const [keyNumberStr, setKeyNumberStr] = useState('');
  const [keyName, setKeyName] = useState('');
  const [color, setColor] = useState('');
  const [keyNumberError, setKeyNumberError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lookup = useCallback(async () => {
    try {
      const row = await cardsRepo.getById(card.id);
      setRegistered(row);
    } catch {
      setRegistered(null);
    }
  }, [card.id]);

  useEffect(() => {
    void lookup();
    const off = on('content:updated', (e) => {
      if (e.kind === 'cards') void lookup();
    });
    return () => off();
  }, [lookup]);

  const openRegister = async () => {
    setKeyNumberError(null);
    const all = await cardsRepo.list();
    const next = all.length === 0 ? 1 : Math.max(...all.map((c) => c.key_number)) + 1;
    setKeyNumberStr(String(next));
    setKeyName('');
    setColor('');
    setShowRegister(true);
  };

  const cancelRegister = () => {
    setShowRegister(false);
    setKeyNumberError(null);
  };

  const submitRegister = async () => {
    setKeyNumberError(null);
    const keyNumber = parseInt(keyNumberStr, 10);
    if (!Number.isFinite(keyNumber) || keyNumber <= 0) return;
    if (keyName.trim() === '') return;
    const all = await cardsRepo.list();
    if (all.some((c) => c.key_number === keyNumber)) {
      setKeyNumberError('Key number already taken');
      return;
    }
    setBusy(true);
    try {
      await cardsRepo.create({
        id: card.id,
        key_number: keyNumber,
        key_name: keyName.trim(),
        color: color.trim() === '' ? null : color.trim(),
      });
      setShowRegister(false);
      await lookup();
      void runCycleNow('manual').catch(() => undefined);
    } catch {
      // surfaced as no UI change — user can retry
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-y-2">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="font-mono text-2xl text-blue-300">#{card.id}</span>
          <span className="text-sm text-slate-400">
            {card.cardType} · {card.nbPunch} punch{card.nbPunch === 1 ? '' : 'es'}
          </span>
          {registered ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-500/20 text-green-300 text-xs font-medium border border-green-500/30">
              <Check size={12} />
              Registered · {registered.key_name} (#{registered.key_number})
            </span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-orange-500/20 text-orange-300 text-xs font-medium border border-orange-500/30">
                Not registered
              </span>
              <button
                onClick={openRegister}
                disabled={showRegister || busy}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium disabled:opacity-50"
              >
                Register
              </button>
            </>
          )}
        </div>
        <span className="font-mono text-xs text-slate-500">
          {receivedAt.toLocaleTimeString()}
        </span>
      </div>

      {showRegister && !registered && (
        <div className="mb-3 p-3 rounded-md border border-slate-700 bg-slate-800/60">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
            <label className="block">
              <span className="block text-xs text-slate-400 mb-1">
                Key # {keyNumberError && <span className="text-red-400">— {keyNumberError}</span>}
              </span>
              <input
                type="number"
                min={1}
                value={keyNumberStr}
                onChange={(e) => setKeyNumberStr(e.target.value)}
                className={`w-full px-2 py-1 bg-slate-900 border rounded text-sm text-white ${
                  keyNumberError ? 'border-red-500' : 'border-slate-600'
                }`}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-slate-400 mb-1">Name (required)</span>
              <input
                type="text"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                className="w-full px-2 py-1 bg-slate-900 border border-slate-600 rounded text-sm text-white"
                placeholder="e.g. Alpha"
                autoFocus
              />
            </label>
            <label className="block">
              <span className="block text-xs text-slate-400 mb-1">Color (optional)</span>
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-full px-2 py-1 bg-slate-900 border border-slate-600 rounded text-sm text-white"
                placeholder="e.g. red"
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={submitRegister}
              disabled={busy || keyName.trim() === ''}
              className="inline-flex items-center gap-1 px-3 py-1 bg-green-600 hover:bg-green-500 disabled:bg-slate-700 disabled:text-slate-400 text-white rounded text-sm"
            >
              Save
            </button>
            <button
              onClick={cancelRegister}
              disabled={busy}
              className="inline-flex items-center gap-1 px-3 py-1 border border-slate-600 text-slate-300 hover:bg-slate-700 rounded text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 mb-3">
        <TimeSlot label="Start" punch={card.start} />
        <TimeSlot label="Check" punch={card.check} />
        <TimeSlot label="Finish" punch={card.end} />
      </div>

      {card.punches.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">
            Punches
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1">
            {card.punches.map((p, i) => (
              <div
                key={i}
                className="flex justify-between items-center font-mono text-xs bg-slate-800/60 rounded px-2 py-1"
              >
                <span className="text-blue-300">#{p.code}</span>
                <span className="text-slate-400">{p.time}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TimeSlot({
  label,
  punch,
}: {
  label: string;
  punch?: { code: number; time: string };
}) {
  return (
    <div className="rounded bg-slate-800/40 px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      {punch ? (
        <div className="font-mono text-sm text-white">{punch.time}</div>
      ) : (
        <div className="font-mono text-sm text-slate-600">—</div>
      )}
    </div>
  );
}

interface SettingsNavProps {
  active: SettingsTab;
  onChange: (tab: SettingsTab) => void;
}

interface NavGroup {
  label: string;
  items: { tab: SettingsTab; label: string; icon: React.ReactNode }[];
}

function SettingsNav({ active, onChange }: SettingsNavProps) {
  const groups: NavGroup[] = [
    {
      label: 'Account',
      items: [
        { tab: 'account', label: 'Account', icon: <UserIcon size={16} /> },
        { tab: 'sync', label: 'Sync', icon: <CloudCog size={16} /> },
        { tab: 'devices', label: 'My devices', icon: <Smartphone size={16} /> },
      ],
    },
    {
      label: 'App',
      items: [
        { tab: 'general', label: 'Preferences', icon: <Sliders size={16} /> },
        { tab: 'hardware', label: 'Hardware', icon: <Cpu size={16} /> },
        { tab: 'updates', label: 'Updates', icon: <Download size={16} /> },
      ],
    },
    {
      label: 'Developer',
      items: [
        { tab: 'api-docs', label: 'API docs', icon: <BookOpen size={16} /> },
        { tab: 'usb-driver', label: 'USB driver', icon: <Usb size={16} /> },
      ],
    },
  ];

  return (
    <nav className="space-y-6 sticky top-24">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="text-xs uppercase tracking-wider text-slate-500 px-3 mb-2">
            {group.label}
          </div>
          <div className="space-y-1">
            {group.items.map((item) => {
              const isActive = active === item.tab;
              return (
                <button
                  key={item.tab}
                  onClick={() => onChange(item.tab)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg transition text-left text-sm ${
                    isActive
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-300 hover:bg-slate-700/60'
                  }`}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
