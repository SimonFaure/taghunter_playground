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
  Network,
  CreditCard,
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
  Image as ImageIcon,
  Film,
  ShieldCheck,
  Printer,
  Palette,
  ServerCog,
  Tags,
} from 'lucide-react';
import { enable as enableAutostart, disable as disableAutostart } from '@tauri-apps/plugin-autostart';
import { useTranslation } from 'react-i18next';
import {
  sportidentService,
  type CardData,
  type StationData,
} from '../services/sportidentService';
import { useDetectedReaderPort } from '../services/useDetectedReaderPort';
import { useDriverState } from '../services/useDriverState';
import ClientCardsPage from './ClientCardsPage';
import { VideosTab, ImagesTab } from './MediaTabs';
import { setUiLanguage } from '../i18n';
import { loadConfig, saveConfig, AppConfig } from '../utils/config';
import {
  extForFile,
  isSupportedLogoExt,
  mimeForExt,
  readLaunchLogoUrl,
  removeLaunchLogo,
  writeLaunchLogo,
} from '../utils/launchLogo';
import {
  resolveLogoEffect,
  LOGO_ANIMATION_OPTIONS,
  type LogoAnimation,
} from '../utils/logoEffect';
import * as cardsRepo from '../services/cardsRepo';
import { on } from '../services/syncEvents';
import { runCycleNow } from '../services/syncOrchestrator';
import { applyOperatorModeChange } from '../services/operatorMode';
import { listActiveLaunchedGames } from '../services/launchedGames';
import * as scenarioStore from '../services/scenarioStore';
import { ConfirmDialog } from './ConfirmDialog';
import { useAuth } from './auth/AuthProvider';
import { getStoredTheme, setTheme as applyThemeChoice, type ThemeName } from '../services/theme';
import { AccountScreen } from './settings/AccountScreen';
import { SyncStatusScreen } from './settings/SyncStatusScreen';
import { DevicesScreen } from './settings/DevicesScreen';
import { UpdatesScreen } from './settings/UpdatesScreen';
import { UsbDriverScreen } from './settings/UsbDriverScreen';
import { PrintingScreen } from './settings/PrintingScreen';
import { TeamNamesScreen } from './settings/TeamNamesScreen';
import { ApiDocsPage } from './ApiDocsPage';
import { DevicePinSettings } from './settings/DevicePinSettings';

const DEFAULT_CONFIG: AppConfig = {
  language: 'english',
  fullscreenOnLaunch: false,
  autoLaunch: false,
  startHotspotOnLaunch: false,
  beMotherWhenAvailable: false,
  logoScreenOnLaunch: false,
  logoScreenBgColor: '#000000',
  logoScreenLogoFile: null,
  logoScreenAnimation: 'pulse',
  logoScreenGlowColor: '#FFFFFF',
  requirePinToExitGame: false,
  requirePinToExitLogo: false,
  requirePinToExitFullscreen: false,
};

export type SettingsTab =
  | 'account'
  | 'general'
  | 'cards'
  | 'videos'
  | 'images'
  | 'hardware'
  | 'sync'
  | 'devices'
  | 'updates'
  | 'printing'
  | 'team-names'
  | 'api-docs'
  | 'usb-driver';

interface ConfigurationPageProps {
  // When the user clicks the sync pill or failure banner, App sets this to
  // 'sync' to deep-link into the right tab. The value is consumed once on
  // change (the parent flips it back to undefined afterwards) - we don't
  // want subsequent in-page tab clicks to be overridden by the prop.
  initialTab?: SettingsTab;
  /** API docs are an admin-only surface - gates the nav entry + its content. */
  isAdminMode?: boolean;
}

export function ConfigurationPage({ initialTab, isAdminMode = false }: ConfigurationPageProps = {}) {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'account');

  // Honor a fresh deep-link request: if the parent passes a new initialTab
  // (e.g., user clicks the pill while already on the settings page but a
  // different tab), switch to it. Compared with the previous prop value to
  // avoid clobbering a manual tab change after the deep-link landed.
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  // API docs are admin-only: if admin mode is dropped while the tab is open,
  // bounce back to a safe tab so the content doesn't vanish into a blank pane.
  useEffect(() => {
    if (!isAdminMode && activeTab === 'api-docs') setActiveTab('account');
  }, [isAdminMode, activeTab]);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [savedConfig, setSavedConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  // Colour theme (red/blue). A pure UI preference applied + persisted instantly
  // via the theme service (not part of the Save bar / config.json flow).
  const [theme, setThemeState] = useState<ThemeName>(getStoredTheme());
  const pickTheme = (next: ThemeName) => {
    setThemeState(next);
    applyThemeChoice(next);
  };
  // Pick the operator chrome (UI) language. Applies immediately + persists via
  // i18next/localStorage, and mirrors it into AppConfig.language for any
  // language-aware app preference. This is the single language control (the
  // old nav switcher was removed).
  const pickUiLanguage = (code: 'en' | 'fr' | 'es', cfgValue: AppConfig['language']) => {
    setUiLanguage(code);
    setConfig((c) => ({ ...c, language: cfgValue }));
  };
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

  // Operator-only device toggle. Unlike the other AppConfig prefs it does NOT
  // flow through the Save bar - flipping it resets + re-syncs all content
  // (services/operatorMode.ts), so it applies immediately behind a confirm and
  // is blocked while a game is running on this device. `operatorPending` holds
  // the requested next value while the confirm dialog is open.
  const [operatorPending, setOperatorPending] = useState<{ next: boolean } | null>(null);
  const [operatorBusy, setOperatorBusy] = useState(false);

  // Request a change. Guard: refuse while a game is active here (the reset would
  // yank media out from under it). Confirm first when there's downloaded content
  // to reset; apply straight away on a still-empty device.
  const requestOperatorChange = async (next: boolean) => {
    if (operatorBusy) return;
    try {
      const active = await listActiveLaunchedGames();
      if (active.length > 0) {
        setMessage({ type: 'error', text: t('settings:operatorOnlyActiveGameBlock') });
        setTimeout(() => setMessage(null), 4000);
        return;
      }
      const downloaded = await scenarioStore.count({ downloaded: true });
      if (downloaded > 0) {
        setOperatorPending({ next });
      } else {
        await applyOperatorChange(next);
      }
    } catch (err) {
      console.error('[ConfigurationPage] requestOperatorChange failed:', err);
    }
  };

  const applyOperatorChange = async (next: boolean) => {
    setOperatorBusy(true);
    setOperatorPending(null);
    try {
      await applyOperatorModeChange(next);
      setConfig((c) => ({ ...c, operatorOnlyDevice: next }));
      setSavedConfig((c) => ({ ...c, operatorOnlyDevice: next }));
      setMessage({ type: 'success', text: t('settings:operatorOnlyApplied') });
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      console.error('[ConfigurationPage] applyOperatorChange failed:', err);
      setMessage({ type: 'error', text: t('settings:operatorOnlyFailed') });
    } finally {
      setOperatorBusy(false);
    }
  };

  useEffect(() => {
    void loadConfiguration();
  }, []);

  // Operator-only hides the hardware tabs - if one is open when the mode flips
  // on, bounce back to a safe tab so the pane doesn't go blank.
  useEffect(() => {
    if (config.operatorOnlyDevice && (activeTab === 'hardware' || activeTab === 'usb-driver')) {
      setActiveTab('general');
    }
  }, [config.operatorOnlyDevice, activeTab]);

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
        // Logo was removed - delete the previously saved file.
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
      // The picked logo is now the saved logo - adopt its preview URL.
      if (pickedLogo) {
        setSavedLogoUrl(pickedLogo.url);
        setPickedLogo(null);
      } else if (!finalConfig.logoScreenLogoFile) {
        setSavedLogoUrl(null);
      }
      setMessage({ type: 'success', text: t('settings:toastConfigSaved') });
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      console.error('Error saving configuration:', err);
      setMessage({ type: 'error', text: t('settings:toastConfigSaveFailed') });
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
        text: t('settings:toastUnsupportedImage'),
      });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMessage({ type: 'error', text: t('settings:toastLogoTooLarge') });
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeForExt(ext) }));
      setPickedLogo({ bytes, ext, url });
      setConfig((c) => ({ ...c, logoScreenLogoFile: `launch-logo.${ext}` }));
    } catch (err) {
      console.error('Error reading logo file:', err);
      setMessage({ type: 'error', text: t('settings:toastCouldNotReadImage') });
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
    <div className="min-h-screen pg-app-bg text-[var(--pg-text)] py-8">
      <div className="container mx-auto px-6">
        <div className="flex items-center gap-3 mb-8">
          <Settings className="text-[var(--pg-accent-bright)]" size={32} />
          <h1 className="text-3xl font-bold">{t('settings:pageTitle')}</h1>
        </div>

        <div className="flex gap-6">
          <aside className="w-56 shrink-0">
            <SettingsNav active={activeTab} onChange={setActiveTab} isAdminMode={isAdminMode} operatorOnly={Boolean(config.operatorOnlyDevice)} />
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
                <Section icon={<Globe className="text-[var(--pg-accent-bright)]" size={24} />} title={t('settings:sectionLanguage')}>
                  <div className="grid grid-cols-3 gap-4">
                    <ChoiceCard
                      active={i18n.language === 'en'}
                      onClick={() => pickUiLanguage('en', 'english')}
                      title={t('settings:languageEnglishTitle')}
                      subtitle={t('settings:languageEnglishSubtitle')}
                    />
                    <ChoiceCard
                      active={i18n.language === 'fr'}
                      onClick={() => pickUiLanguage('fr', 'french')}
                      title={t('settings:languageFrenchTitle')}
                      subtitle={t('settings:languageFrenchSubtitle')}
                    />
                    <ChoiceCard
                      active={i18n.language === 'es'}
                      onClick={() => pickUiLanguage('es', 'spanish')}
                      title={t('settings:languageSpanishTitle')}
                      subtitle={t('settings:languageSpanishSubtitle')}
                    />
                  </div>
                </Section>

                <Section icon={<Palette className="text-[var(--pg-accent-bright)]" size={24} />} title={t('settings:sectionAppearance')}>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <ThemeCard
                      active={theme === 'red'}
                      onClick={() => pickTheme('red')}
                      title={t('settings:themeRedTitle')}
                      subtitle={t('settings:themeRedSubtitle')}
                      accent="#E11D2A"
                      surface="#161618"
                    />
                    <ThemeCard
                      active={theme === 'blue'}
                      onClick={() => pickTheme('blue')}
                      title={t('settings:themeBlueTitle')}
                      subtitle={t('settings:themeBlueSubtitle')}
                      accent="#2D6BFF"
                      surface="#16213A"
                    />
                    <ThemeCard
                      active={theme === 'red-light'}
                      onClick={() => pickTheme('red-light')}
                      title={t('settings:themeRedLightTitle')}
                      subtitle={t('settings:themeRedLightSubtitle')}
                      accent="#E11D2A"
                      surface="#F4F4F6"
                    />
                    <ThemeCard
                      active={theme === 'blue-light'}
                      onClick={() => pickTheme('blue-light')}
                      title={t('settings:themeBlueLightTitle')}
                      subtitle={t('settings:themeBlueLightSubtitle')}
                      accent="#2D6BFF"
                      surface="#F4F4F6"
                    />
                  </div>
                </Section>

                <Section icon={<Monitor className="text-[var(--pg-accent-bright)]" size={24} />} title={t('settings:sectionDisplay')}>
                  <Toggle
                    label={t('settings:fullscreenOnLaunchLabel')}
                    description={t('settings:fullscreenOnLaunchDesc')}
                    value={Boolean(config.fullscreenOnLaunch)}
                    onChange={(v) => setConfig({ ...config, fullscreenOnLaunch: v })}
                  />
                  <Toggle
                    label={t('settings:launchOnStartupLabel')}
                    description={t('settings:launchOnStartupDesc')}
                    value={Boolean(config.autoLaunch)}
                    onChange={(v) => setConfig({ ...config, autoLaunch: v })}
                  />
                </Section>

                <Section
                  icon={<ServerCog className="text-[var(--pg-accent-bright)]" size={24} />}
                  title={t('settings:sectionDeviceRole')}
                >
                  <Toggle
                    label={t('settings:operatorOnlyLabel')}
                    description={t('settings:operatorOnlyDesc')}
                    value={Boolean(config.operatorOnlyDevice)}
                    onChange={(v) => void requestOperatorChange(v)}
                    disabled={operatorBusy}
                  />
                  <p className="text-sm text-[var(--pg-text-dim)] mt-2 leading-relaxed">
                    {t('settings:operatorOnlyExplainer')}
                  </p>
                </Section>

                <Section
                  icon={<ShieldCheck className="text-[var(--pg-accent-bright)]" size={24} />}
                  title={t('settings:sectionSecurity')}
                >
                  <Toggle
                    label={t('settings:pinExitGameLabel')}
                    description={t('settings:pinExitGameDesc')}
                    value={Boolean(config.requirePinToExitGame)}
                    onChange={(v) => setConfig({ ...config, requirePinToExitGame: v })}
                  />
                  <Toggle
                    label={t('settings:pinExitLogoLabel')}
                    description={t('settings:pinExitLogoDesc')}
                    value={Boolean(config.requirePinToExitLogo)}
                    onChange={(v) => setConfig({ ...config, requirePinToExitLogo: v })}
                  />
                  <Toggle
                    label={t('settings:pinExitFullscreenLabel')}
                    description={t('settings:pinExitFullscreenDesc')}
                    value={Boolean(config.requirePinToExitFullscreen)}
                    onChange={(v) => setConfig({ ...config, requirePinToExitFullscreen: v })}
                  />
                  <DevicePinSettings />
                </Section>

                <Section
                  icon={<ImageIcon className="text-[var(--pg-accent-bright)]" size={24} />}
                  title={t('settings:sectionLaunchLogo')}
                >
                  <Toggle
                    label={t('settings:logoScreenOnLaunchLabel')}
                    description={t('settings:logoScreenOnLaunchDesc')}
                    value={Boolean(config.logoScreenOnLaunch)}
                    onChange={(v) => setConfig({ ...config, logoScreenOnLaunch: v })}
                  />

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                    <div className="space-y-4 p-4 rounded-lg border border-[var(--pg-line)] bg-[var(--pg-surface-2)]">
                      <div>
                        <div className="font-semibold mb-1">{t('settings:logoLabel')}</div>
                        <div className="text-sm text-[var(--pg-text-dim)] mb-2">
                          {t('settings:logoHint')}
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
                            className="pg-btn pg-btn--primary pg-btn--sm"
                          >
                            <Upload size={14} />
                            {hasCustomLogo ? t('settings:replaceLogo') : t('settings:uploadLogo')}
                          </button>
                          {hasCustomLogo && (
                            <button
                              onClick={handleRemoveLogo}
                              className="pg-btn pg-btn--ghost pg-btn--sm"
                            >
                              <Trash2 size={14} />
                              {t('settings:removeLogo')}
                            </button>
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="font-semibold mb-1">{t('settings:backgroundColor')}</div>
                        <div className="flex items-center gap-3">
                          <input
                            type="color"
                            value={config.logoScreenBgColor ?? '#000000'}
                            onChange={(e) =>
                              setConfig({ ...config, logoScreenBgColor: e.target.value })
                            }
                            className="h-10 w-16 rounded bg-transparent cursor-pointer border border-[var(--pg-line-strong)]"
                          />
                          <span className="font-mono text-sm text-[var(--pg-text-dim)]">
                            {(config.logoScreenBgColor ?? '#000000').toUpperCase()}
                          </span>
                        </div>
                      </div>

                      <div>
                        <div className="font-semibold mb-1">{t('settings:animation')}</div>
                        <div className="text-sm text-[var(--pg-text-dim)] mb-2">
                          {t('settings:animationHint')}
                        </div>
                        <select
                          value={config.logoScreenAnimation ?? 'pulse'}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              logoScreenAnimation: e.target.value as LogoAnimation,
                            })
                          }
                          className="pg-select w-full"
                        >
                          {LOGO_ANIMATION_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      {(config.logoScreenAnimation ?? 'pulse') !== 'none' && (
                        <div>
                          <div className="font-semibold mb-1">{t('settings:glowColor')}</div>
                          <div className="flex items-center gap-3">
                            <input
                              type="color"
                              value={config.logoScreenGlowColor ?? '#FFFFFF'}
                              onChange={(e) =>
                                setConfig({ ...config, logoScreenGlowColor: e.target.value })
                              }
                              className="h-10 w-16 rounded bg-transparent cursor-pointer border border-[var(--pg-line-strong)]"
                            />
                            <span className="font-mono text-sm text-[var(--pg-text-dim)]">
                              {(config.logoScreenGlowColor ?? '#FFFFFF').toUpperCase()}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="font-semibold mb-1">{t('settings:preview')}</div>
                      <div
                        className="rounded-lg border border-[var(--pg-line)] overflow-hidden w-full"
                        style={{
                          aspectRatio: '16 / 9',
                          backgroundColor: config.logoScreenBgColor ?? '#000000',
                        }}
                      >
                        <div className="w-full h-full flex items-center justify-center p-6">
                          {(() => {
                            const effect = resolveLogoEffect(
                              config.logoScreenAnimation,
                              config.logoScreenGlowColor,
                            );
                            return (
                              <div
                                className="relative inline-flex items-center justify-center max-w-[60%] max-h-[60%]"
                                style={effect.wrapperStyle}
                              >
                                <img
                                  src={previewLogoUrl}
                                  alt=""
                                  className={`max-w-full max-h-full object-contain ${effect.imgClassName}`}
                                />
                                {effect.showShimmer && (
                                  <span
                                    aria-hidden
                                    className="logo-shimmer pointer-events-none absolute inset-0"
                                    style={{
                                      WebkitMaskImage: `url("${previewLogoUrl}")`,
                                      maskImage: `url("${previewLogoUrl}")`,
                                    }}
                                  />
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                      {!hasCustomLogo && (
                        <div className="text-xs text-[var(--pg-text-dim)] mt-1">
                          {t('settings:noCustomLogo')}
                        </div>
                      )}
                    </div>
                  </div>
                </Section>

                <SaveBar dirty={dirty} isSaving={isSaving} onSave={handleSave} />
              </>
            )}

            {activeTab === 'hardware' && (
              <HardwareTab onOpenUsbDriver={() => setActiveTab('usb-driver')} />
            )}

            {activeTab === 'cards' && <ClientCardsPage embedded />}
            {activeTab === 'videos' && <VideosTab />}
            {activeTab === 'images' && <ImagesTab />}
            {activeTab === 'account' && <AccountScreen />}
            {activeTab === 'sync' && <SyncStatusScreen />}
            {activeTab === 'devices' && <DevicesScreen onLoggedOut={auth.refresh} />}
            {activeTab === 'updates' && <UpdatesScreen />}
            {activeTab === 'printing' && <PrintingScreen />}
            {activeTab === 'team-names' && <TeamNamesScreen />}
            {activeTab === 'api-docs' && isAdminMode && <ApiDocsPage />}
            {activeTab === 'usb-driver' && <UsbDriverScreen />}
          </main>
        </div>
      </div>

      {operatorPending && (
        <ConfirmDialog
          isOpen={true}
          title={t('settings:operatorOnlyConfirmTitle')}
          message={
            operatorPending.next
              ? t('settings:operatorOnlyConfirmEnable')
              : t('settings:operatorOnlyConfirmDisable')
          }
          confirmText={t('settings:operatorOnlyConfirmAction')}
          cancelText={t('settings:cancel')}
          variant="danger"
          onConfirm={() => void applyOperatorChange(operatorPending.next)}
          onCancel={() => setOperatorPending(null)}
        />
      )}
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
    <div className="pg-panel p-6 mb-6">
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
      className={`p-4 rounded-lg border transition-all ${
        active ? 'border-[var(--pg-accent-line)] bg-[var(--pg-accent-tint)]' : 'border-[var(--pg-line)] bg-[var(--pg-surface-2)] hover:border-[var(--pg-line-strong)]'
      }`}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold text-lg">{title}</div>
          <div className="text-sm text-[var(--pg-text-dim)]">{subtitle}</div>
        </div>
        {active && <Check className="text-[var(--pg-accent-bright)]" size={24} />}
      </div>
    </button>
  );
}

function ThemeCard({
  active,
  onClick,
  title,
  subtitle,
  accent,
  surface,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  accent: string;
  surface: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`p-4 rounded-lg border transition-all text-left ${
        active ? 'border-[var(--pg-accent-line)] bg-[var(--pg-accent-tint)]' : 'border-[var(--pg-line)] bg-[var(--pg-surface-2)] hover:border-[var(--pg-line-strong)]'
      }`}
    >
      <div className="flex items-center gap-3">
        {/* Mini palette preview: surface chip with an accent bar. */}
        <span
          className="flex h-10 w-14 shrink-0 items-center justify-end overflow-hidden rounded-md border border-black/40"
          style={{ backgroundColor: surface }}
        >
          <span className="h-full w-3" style={{ backgroundColor: accent }} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-lg">{title}</div>
          <div className="text-sm text-[var(--pg-text-dim)]">{subtitle}</div>
        </div>
        {active && <Check className="text-[var(--pg-accent-bright)] shrink-0" size={22} />}
      </div>
    </button>
  );
}

function Toggle({
  label,
  description,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-4 rounded-lg border border-[var(--pg-line)] bg-[var(--pg-surface-2)] hover:border-[var(--pg-line-strong)] transition-all mb-3">
      <div className="min-w-0">
        <div className="font-semibold text-lg">{label}</div>
        <div className="text-sm text-[var(--pg-text-dim)]">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-7 w-14 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
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

function SaveBar({
  dirty,
  isSaving,
  onSave,
}: {
  dirty: boolean;
  isSaving: boolean;
  onSave: () => void;
}) {
  const { t } = useTranslation();
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
            {t('settings:saving')}
          </>
        ) : (
          <>
            <Check size={16} />
            {t('settings:saveConfiguration')}
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
// the list below - start/finish/check punches and every code on the card.
// Useful for verifying:
//   - the dongle is detected on the right port
//   - the master station is awake and forwarding 0xE8 notifications
//   - the cards we expect to use at an event actually parse correctly
//
// Lifecycle: starts a global reader via `sportidentService`. On tab switch
// or unmount, the useEffect cleanup stops it. Note this is the same singleton
// the game pages use - running this test while a game is mid-flight would
// fight for the port; the use case for that doesn't exist (settings panel
// is reached from the home screen, not mid-game).

interface CardWithReceivedAt {
  card: CardData;
  receivedAt: Date;
}

// HardwareTab - the Reader status card plus the card-reader test panel. When
// the reader has a driver problem, the status card links over to the dedicated
// USB driver settings tab (Developer → USB driver), which owns the full fix.
function HardwareTab({ onOpenUsbDriver }: { onOpenUsbDriver: () => void }) {
  return (
    <>
      <ReaderStatusSection onOpenUsbDriver={onOpenUsbDriver} />
      <CardReaderTestSection />
    </>
  );
}

// Read-only status block showing the auto-detected reader port. Replaces the
// old port-picker section: there's no choice to be made - the app filters
// available ports by VID 10c4 / PID 800a and takes the first match.
function ReaderStatusSection({ onOpenUsbDriver }: { onOpenUsbDriver: () => void }) {
  const { t } = useTranslation();
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
      icon={<Usb className="text-[var(--pg-accent-bright)]" size={24} />}
      title={t('settings:readerSection')}
      headerExtra={
        <button
          onClick={refreshAll}
          disabled={!available}
          className="pg-btn pg-btn--primary"
        >
          <RefreshCw size={16} />
          {t('settings:refresh')}
        </button>
      }
    >
      {!available ? (
        <div className="text-sm text-[var(--pg-text-dim)]">
          {t('settings:readerDetectionDesktopOnly')}
        </div>
      ) : isPresent && port ? (
        <div className="rounded-lg border-2 border-green-500/40 bg-green-500/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <Check className="text-green-400 flex-shrink-0" size={18} />
            <span className="font-mono font-semibold text-green-300">{port}</span>
            <span className="text-sm text-[var(--pg-text-dim)]">
              ({detail?.manufacturer ?? 'Silicon Labs CP210x'})
            </span>
          </div>
          <div className="text-xs text-[var(--pg-text-dim)] mt-1 ml-7">
            {t('settings:readerDetectedHint')}
          </div>
        </div>
      ) : driverState.kind === 'blocked_by_policy' ? (
        // SetupDi saw a CP210x device with CM problem code 39/40 - the
        // Vulnerable Driver Blocklist or HVCI refused silabser.sys. The
        // hardware is plugged in; the driver just isn't loading.
        <div className="rounded-lg border-2 border-red-500/50 bg-red-500/10 px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="text-red-400 flex-shrink-0 mt-0.5" size={18} />
            <div className="flex-1 min-w-0">
              <div className="text-red-300 font-medium">
                {t('settings:driverBlockedTitle')}
              </div>
              <div className="text-xs text-[var(--pg-text-dim)] mt-1">
                {t('settings:driverBlockedDesc')}
              </div>
              <button
                onClick={onOpenUsbDriver}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded font-medium text-white text-sm transition-colors"
              >
                <Usb size={14} />
                {t('settings:driverBlockedCta')}
              </button>
            </div>
          </div>
        </div>
      ) : driverState.kind === 'driver_not_installed' ? (
        // SetupDi saw a CP210x device with CM problem code 28/18 - plugged in
        // but no driver bound (sits under "Other devices"). Installing one fixes it.
        <div className="rounded-lg border-2 border-amber-500/50 bg-amber-500/10 px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="text-amber-400 flex-shrink-0 mt-0.5" size={18} />
            <div className="flex-1 min-w-0">
              <div className="text-amber-300 font-medium">
                {t('settings:driverNotInstalledTitle')}
              </div>
              <div className="text-xs text-[var(--pg-text-dim)] mt-1">
                {t('settings:driverNotInstalledDesc')}
              </div>
              <button
                onClick={onOpenUsbDriver}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded font-medium text-white text-sm transition-colors"
              >
                <Usb size={14} />
                {t('settings:driverNotInstalledCta')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border-2 border-orange-500/40 bg-orange-500/10 px-4 py-3 flex items-start gap-2">
          <AlertCircle className="text-orange-400 flex-shrink-0 mt-0.5" size={18} />
          <div>
            <div className="text-orange-300 font-medium">{t('settings:noReaderTitle')}</div>
            <div className="text-xs text-[var(--pg-text-dim)] mt-1">
              {t('settings:noReaderDesc')}
            </div>
            <button
              onClick={onOpenUsbDriver}
              className="mt-2 inline-flex items-center gap-1.5 text-xs text-[var(--pg-accent-bright)] hover:text-[var(--pg-accent-hover)] underline underline-offset-2"
            >
              <Usb size={13} />
              {t('settings:noReaderCta')}
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

function CardReaderTestSection() {
  const { t } = useTranslation();
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
    setStatusMessage(t('settings:statusOpeningPort'));
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
          t('settings:errorFailedToOpenPort'),
        );
        setStatusMessage(null);
        return;
      }
      await sportidentService.start();
      setRunning(true);
      setStatusMessage(t('settings:statusListening'));
    } catch (err) {
      setErrorMessage(t('settings:errorCouldNotStart', { error: String(err) }));
      setStatusMessage(null);
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    try {
      await sportidentService.stop();
      setStatusMessage(t('settings:statusStopped'));
    } catch (err) {
      setErrorMessage(t('settings:errorStopping', { error: String(err) }));
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
  // user picks a different settings tab - exactly when we want to stop.
  useEffect(() => {
    return () => {
      if (running) {
        void sportidentService.stop();
      }
    };
  }, [running]);

  return (
    <Section
      icon={<Activity className="text-[var(--pg-accent-bright)]" size={24} />}
      title={t('settings:cardReaderTestSection')}
      headerExtra={
        <div className="flex items-center gap-2">
          {cards.length > 0 && (
            <button
              onClick={handleClear}
              className="pg-btn pg-btn--ghost pg-btn--sm"
            >
              <Trash2 size={14} />
              {t('settings:clearCount', { count: cards.length })}
            </button>
          )}
          {running ? (
            <button
              onClick={handleStop}
              disabled={busy}
              className="pg-btn pg-btn--danger"
            >
              <Square size={16} />
              {t('settings:stopTest')}
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={!canStart}
              className="pg-btn pg-btn--primary"
            >
              <Play size={16} />
              {t('settings:startTest')}
            </button>
          )}
        </div>
      }
    >
      {!available && (
        <div className="text-sm text-[var(--pg-text-dim)] mb-3">
          {t('settings:cardReaderTestDesktopOnly')}
        </div>
      )}
      {available && !isPresent && (
        <div className="text-sm text-[var(--pg-text-dim)] mb-3">
          {t('settings:plugInReaderToTest')}
        </div>
      )}

      {statusMessage && (
        <div className="mb-3 rounded-lg border border-[var(--pg-line)] bg-[var(--pg-surface-2)] px-4 py-2 text-sm text-[var(--pg-text-muted)]">
          <span className={running ? 'text-green-400' : 'text-[var(--pg-text-dim)]'}>●</span>{' '}
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
        <div className="mb-4 rounded-lg border border-[var(--pg-line)] bg-[var(--pg-surface-2)] px-4 py-3 text-sm">
          <div className="text-xs uppercase tracking-wider text-[var(--pg-text-dim)] mb-1">{t('settings:masterStation')}</div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-[var(--pg-text-muted)]">
            <span>
              <span className="text-[var(--pg-text-dim)]">#</span>
              {station.stationNumber}
            </span>
            <span>
              <span className="text-[var(--pg-text-dim)]">{t('settings:stationModePrefix')} </span>
              {station.stationMode}
            </span>
            {station.extended && <span className="text-[var(--pg-accent-bright)]">{t('settings:stationExtended')}</span>}
            {station.autoSend && <span className="text-[var(--pg-accent-bright)]">{t('settings:stationAutoSend')}</span>}
            {station.handShake && <span className="text-[var(--pg-accent-bright)]">{t('settings:stationHandshake')}</span>}
          </div>
        </div>
      )}

      {cards.length === 0 ? (
        <div className="text-center py-10 text-[var(--pg-text-dim)] text-sm">
          {running
            ? t('settings:waitingForCard')
            : t('settings:noCardsYet')}
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
  const { t } = useTranslation();
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
      setKeyNumberError(t('settings:errorKeyNumberTaken'));
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
      // surfaced as no UI change - user can retry
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-[var(--pg-line)] bg-[var(--pg-surface-2)] p-4">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-y-2">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="font-mono text-2xl text-[var(--pg-accent-bright)]">#{card.id}</span>
          <span className="text-sm text-[var(--pg-text-dim)]">
            {card.cardType} · {t('settings:punchCount', { count: card.nbPunch })}
          </span>
          {registered ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-500/20 text-green-300 text-xs font-medium border border-green-500/30">
              <Check size={12} />
              {t('settings:registeredChip', { name: registered.key_name, number: registered.key_number })}
            </span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-orange-500/20 text-orange-300 text-xs font-medium border border-orange-500/30">
                {t('settings:notRegistered')}
              </span>
              <button
                onClick={openRegister}
                disabled={showRegister || busy}
                className="pg-btn pg-btn--primary pg-btn--sm"
              >
                {t('settings:register')}
              </button>
            </>
          )}
        </div>
        <span className="font-mono text-xs text-[var(--pg-text-dim)]">
          {receivedAt.toLocaleTimeString()}
        </span>
      </div>

      {showRegister && !registered && (
        <div className="mb-3 p-3 rounded-md border border-[var(--pg-line)] bg-[var(--pg-surface-3)]">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
            <label className="block">
              <span className="block text-xs text-[var(--pg-text-dim)] mb-1">
                {t('settings:keyNumberLabel')} {keyNumberError && <span className="text-red-400">- {keyNumberError}</span>}
              </span>
              <input
                type="number"
                min={1}
                value={keyNumberStr}
                onChange={(e) => setKeyNumberStr(e.target.value)}
                className={`pg-input w-full !py-1 text-sm ${
                  keyNumberError ? '!border-red-500' : ''
                }`}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-[var(--pg-text-dim)] mb-1">{t('settings:nameLabel')}</span>
              <input
                type="text"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                className="pg-input w-full !py-1 text-sm"
                placeholder={t('settings:namePlaceholder')}
                autoFocus
              />
            </label>
            <label className="block">
              <span className="block text-xs text-[var(--pg-text-dim)] mb-1">{t('settings:colorLabel')}</span>
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="pg-input w-full !py-1 text-sm"
                placeholder={t('settings:colorPlaceholder')}
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={submitRegister}
              disabled={busy || keyName.trim() === ''}
              className="inline-flex items-center gap-1 px-3 py-1 bg-green-600 hover:bg-green-500 disabled:bg-[var(--pg-surface-3)] disabled:text-[var(--pg-text-dim)] text-white rounded text-sm"
            >
              {t('settings:save')}
            </button>
            <button
              onClick={cancelRegister}
              disabled={busy}
              className="pg-btn pg-btn--ghost pg-btn--sm"
            >
              {t('settings:cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 mb-3">
        <TimeSlot label={t('settings:timeSlotStart')} punch={card.start} />
        <TimeSlot label={t('settings:timeSlotCheck')} punch={card.check} />
        <TimeSlot label={t('settings:timeSlotFinish')} punch={card.end} />
      </div>

      {card.punches.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wider text-[var(--pg-text-dim)] mb-2">
            {t('settings:punchesHeading')}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1">
            {card.punches.map((p, i) => (
              <div
                key={i}
                className="flex justify-between items-center font-mono text-xs bg-[var(--pg-surface-3)] rounded px-2 py-1"
              >
                <span className="text-[var(--pg-accent-bright)]">#{p.code}</span>
                <span className="text-[var(--pg-text-dim)]">{p.time}</span>
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
    <div className="rounded bg-[var(--pg-surface-2)] px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-[var(--pg-text-dim)]">{label}</div>
      {punch ? (
        <div className="font-mono text-sm text-[var(--pg-text)]">{punch.time}</div>
      ) : (
        <div className="font-mono text-sm text-[var(--pg-text-dim)]">-</div>
      )}
    </div>
  );
}

interface SettingsNavProps {
  active: SettingsTab;
  onChange: (tab: SettingsTab) => void;
  isAdminMode?: boolean;
  /** Operator-only devices hide the reader/driver hardware tabs entirely. */
  operatorOnly?: boolean;
}

interface NavGroup {
  label: string;
  items: { tab: SettingsTab; label: string; icon: React.ReactNode }[];
}

function SettingsNav({ active, onChange, isAdminMode = false, operatorOnly = false }: SettingsNavProps) {
  const { t } = useTranslation();
  const groups: NavGroup[] = [
    {
      label: t('settings:navGroupAccount'),
      items: [
        { tab: 'account', label: t('settings:navAccount'), icon: <UserIcon size={16} /> },
        { tab: 'sync', label: t('settings:navSync'), icon: <CloudCog size={16} /> },
        { tab: 'cards', label: t('settings:navCardsPatterns'), icon: <CreditCard size={16} /> },
        { tab: 'videos', label: t('settings:navVideos'), icon: <Film size={16} /> },
        { tab: 'images', label: t('settings:navImages'), icon: <ImageIcon size={16} /> },
        { tab: 'team-names', label: t('settings:navTeamNames'), icon: <Tags size={16} /> },
      ],
    },
    {
      label: t('settings:navGroupApp'),
      items: [
        { tab: 'general', label: t('settings:navPreferences'), icon: <Sliders size={16} /> },
        { tab: 'devices', label: t('settings:navNetwork'), icon: <Network size={16} /> },
        { tab: 'hardware', label: t('settings:navHardware'), icon: <Cpu size={16} /> },
        { tab: 'printing', label: t('settings:navPrinting'), icon: <Printer size={16} /> },
        { tab: 'updates', label: t('settings:navUpdates'), icon: <Download size={16} /> },
      ],
    },
    {
      label: t('settings:navGroupDeveloper'),
      items: [
        { tab: 'api-docs', label: t('settings:navApiDocs'), icon: <BookOpen size={16} /> },
        { tab: 'usb-driver', label: t('settings:navUsbDriver'), icon: <Usb size={16} /> },
      ],
    },
  ];

  // API docs are admin-only; drop the entry (and any group it empties) when
  // not in admin mode. Operator-only devices have no reader/driver role, so the
  // Hardware + USB Driver tabs are hidden entirely.
  const hiddenTabs = new Set<SettingsTab>(operatorOnly ? ['hardware', 'usb-driver'] : []);
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => (item.tab !== 'api-docs' || isAdminMode) && !hiddenTabs.has(item.tab)
      ),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <nav className="space-y-6 sticky top-24">
      {visibleGroups.map((group) => (
        <div key={group.label}>
          <div className="text-xs uppercase tracking-wider text-[var(--pg-text-dim)] px-3 mb-2">
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
                      ? 'bg-[var(--pg-accent)] text-white'
                      : 'text-[var(--pg-text-muted)] hover:bg-[var(--pg-surface-3)]'
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
