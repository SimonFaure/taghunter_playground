import { useState, useEffect, useRef } from 'react';
import { Settings, ShieldCheck, List, BookOpen, Activity, CreditCard, LayoutGrid as Layout, Map } from 'lucide-react';
import { GameList } from './components/GameList';
import { ConfigurationPage } from './components/ConfigurationPage';
import { AdminPasswordModal } from './components/AdminPasswordModal';
import { AdminConfigPage } from './components/AdminConfigPage';
import { LaunchedGamesList } from './components/LaunchedGamesList';
import { ApiDocsPage } from './components/ApiDocsPage';
import { ApiLogsPage } from './components/ApiLogsPage';
import ClientCardsPage from './components/ClientCardsPage';
import { LayoutManagement } from './components/LayoutManagement';
import { PatternsPage } from './components/PatternsPage';
import { EmailSetupModal } from './components/EmailSetupModal';
import { OnboardingModal } from './components/OnboardingModal';
import { SyncLoadingModal, SyncStep } from './components/SyncLoadingModal';
import { supabase } from './lib/db';
import { loadConfig, saveConfig } from './utils/config';
import { DownloadItem } from './types/downloadQueue';

type Page = 'games' | 'launched-games' | 'config' | 'admin-config' | 'api-docs' | 'api-logs' | 'client-cards' | 'layouts' | 'patterns';

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('games');
  const [isAdminMode, setIsAdminMode] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showEmailSetup, setShowEmailSetup] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncSteps, setSyncSteps] = useState<SyncStep[]>([]);
  const [currentSyncStep, setCurrentSyncStep] = useState<string>('');
  const [downloadsNeeded, setDownloadsNeeded] = useState<DownloadItem[]>([]);
  const [userEmail, setUserEmail] = useState<string>('');
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set());
  const processedRef = useRef<boolean>(false);
  const checkedConfigRef = useRef<boolean>(false);

  useEffect(() => {
    const checkConfigAndDatabase = async () => {
      if (checkedConfigRef.current) return;
      checkedConfigRef.current = true;

      const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

      if (isElectron) {
        if ((window as any).electron?.db?.connect) {
          try {
            await (window as any).electron.db.connect();
          } catch (error) {
            console.error('Failed to connect to database on launch:', error);
          }
        }

        try {
          const config = await loadConfig();
          console.log('[App Launch] Config loaded:', { hasEmail: !!config?.email, email: config?.email });

          if (!config?.email) {
            console.log('[App Launch] Email missing - showing onboarding');
            setShowOnboarding(true);
            return;
          }

          setUserEmail(config.email);

          // Automatically start sync in background without showing modal
          console.log('[App Launch] Auto-starting resource sync in background...');
          const { syncResourcesBeforeScenarios } = await import('./services/syncOrchestrator');

          const initialSteps: SyncStep[] = [
            { id: 'connectivity', label: 'Checking Internet Connection', status: 'pending' },
            { id: 'billing', label: 'Fetching Billing Status', status: 'pending' },
            { id: 'userData', label: 'Fetching User Data', status: 'pending' },
          ];
          setSyncSteps(initialSteps);

          const syncResult = await syncResourcesBeforeScenarios((stepId, status, details) => {
            setCurrentSyncStep(stepId);
            setSyncSteps(prev =>
              prev.map(step =>
                step.id === stepId ? { ...step, status, details } : step
              )
            );
          });

          console.log('[App Launch] Resource sync completed:', syncResult);

          // Only show modal if there are downloads needed
          if (syncResult.downloadsNeeded.length > 0) {
            console.log(`[App Launch] ${syncResult.downloadsNeeded.length} resource updates available - showing modal`);
            setDownloadsNeeded(syncResult.downloadsNeeded);
            setShowSyncModal(true);
          } else {
            console.log('[App Launch] No downloads needed - sync complete');
          }

          if (syncResult.success) {
            const syncedConfig = await loadConfig();
            await saveConfig({
              ...syncedConfig,
              lastSuccessfulSync: new Date().toISOString(),
            });
          }
        } catch (error) {
          console.error('[App Launch] Failed to sync resources:', error);
          if (error instanceof Error) {
            console.error('[App Launch] Error details:', error.message, error.stack);
          }
        }
      } else if (!isElectron && supabase) {
        console.log('=== SUPABASE DATABASE TABLES ===');
        try {
          const tableNames = ['configuration', 'game_types', 'launched_games'];
          console.log('Number of tables:', tableNames.length);
          console.log('Tables:');
          tableNames.forEach((table, index) => {
            console.log(`  ${index + 1}. ${table}`);
          });

          for (const tableName of tableNames) {
            const { count, error } = await supabase
              .from(tableName)
              .select('*', { count: 'exact', head: true });

            if (!error) {
              console.log(`  - ${tableName}: ${count} rows`);
            }
          }
        } catch (error) {
          console.error('Failed to query Supabase:', error);
        }
        console.log('=================================');
      }
    };

    checkConfigAndDatabase();

    const handleKeyDown = (e: KeyboardEvent) => {
      setPressedKeys(prev => new Set(prev).add(e.key.toLowerCase()));
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      setPressedKeys(prev => {
        const newSet = new Set(prev);
        newSet.delete(e.key.toLowerCase());
        return newSet;
      });
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  useEffect(() => {
    const hasAMO = pressedKeys.has('a') && pressedKeys.has('m') && pressedKeys.has('o');
    const hasAME = pressedKeys.has('a') && pressedKeys.has('m') && pressedKeys.has('e');

    if (hasAMO && !isAdminMode && !processedRef.current) {
      processedRef.current = true;
      setPressedKeys(new Set());
      setShowPasswordModal(true);
    } else if (hasAME && isAdminMode && !processedRef.current) {
      processedRef.current = true;
      setPressedKeys(new Set());
      setIsAdminMode(false);
      if (currentPage === 'admin-config') {
        setCurrentPage('games');
      }
    } else if (!hasAMO && !hasAME) {
      processedRef.current = false;
    }
  }, [pressedKeys, isAdminMode, currentPage]);

  const handleAdminSuccess = () => {
    setIsAdminMode(true);
  };

  const handleEmailSave = async (email: string) => {
    try {
      const config = await loadConfig();
      await saveConfig({ ...config, email });
      setUserEmail(email);
      setShowEmailSetup(false);
    } catch (error) {
      console.error('[Email Setup] Failed to save email:', error);
    }
  };

  const handleStartSync = async () => {
    try {
      console.log('[App] Starting resource sync...');
      const { syncResourcesBeforeScenarios } = await import('./services/syncOrchestrator');

      const syncResult = await syncResourcesBeforeScenarios((stepId, status, details) => {
        setCurrentSyncStep(stepId);
        setSyncSteps(prev =>
          prev.map(step =>
            step.id === stepId ? { ...step, status, details } : step
          )
        );
      });

      console.log('[App] Resource sync completed:', syncResult);

      if (syncResult.downloadsNeeded.length > 0) {
        console.log(`[App] ${syncResult.downloadsNeeded.length} resource updates available`);
        setDownloadsNeeded(syncResult.downloadsNeeded);
      }

      if (syncResult.success) {
        const config = await loadConfig();
        await saveConfig({
          ...config,
          lastSuccessfulSync: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error('[App] Sync failed:', error);
      if (error instanceof Error) {
        console.error('[App] Error details:', error.message, error.stack);
      }
    }
  };

  const handleDownloadAll = async () => {
    try {
      console.log('[App] Starting download of all resources...');
      const { downloadResourceItem } = await import('./services/syncOrchestrator');

      for (const item of downloadsNeeded) {
        console.log(`[App] Downloading: ${item.name}`);
        await downloadResourceItem(item);
      }

      console.log('[App] All downloads completed');
      setDownloadsNeeded([]);
      setShowSyncModal(false);
    } catch (error) {
      console.error('[App] Download failed:', error);
    }
  };

  const handleOnboardingComplete = async (settings: {
    fullscreenOnLaunch: boolean;
    autoLaunch: boolean;
    email: string;
  }) => {
    try {
      console.log('[Onboarding] Settings received:', settings);
      const config = await loadConfig();
      console.log('[Onboarding] Current config loaded:', config);

      const updatedConfig = {
        ...config,
        fullscreenOnLaunch: settings.fullscreenOnLaunch,
        autoLaunch: settings.autoLaunch,
        email: settings.email,
        onboardingCompleted: true,
      };

      console.log('[Onboarding] Saving updated config:', updatedConfig);
      await saveConfig(updatedConfig);
      console.log('[Onboarding] Config saved successfully');

      if ((window as any).electron?.setAutoLaunch) {
        await (window as any).electron.setAutoLaunch(settings.autoLaunch);
      }

      setUserEmail(settings.email);
      setShowOnboarding(false);
    } catch (error) {
      console.error('[Onboarding] Failed to save settings:', error);
    }
  };

  return (
    <div className={`min-h-screen ${isAdminMode ? 'bg-gradient-to-br from-red-900 via-red-800 to-slate-900' : 'bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900'}`}>
      <nav className={`backdrop-blur-sm border-b sticky top-0 z-50 ${isAdminMode ? 'bg-red-800/80 border-red-700' : 'bg-slate-800/80 border-slate-700'}`}>
        <div className="container mx-auto px-6 py-3">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold text-white">Taghunter Playground</h1>
            <div className="flex gap-2">
              <button
                onClick={() => setCurrentPage('games')}
                className={`px-4 py-2 rounded-lg transition ${
                  currentPage === 'games'
                    ? isAdminMode ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'
                    : 'text-slate-300 hover:bg-slate-700'
                }`}
              >
                Games
              </button>
              <button
                onClick={() => setCurrentPage('launched-games')}
                className={`px-4 py-2 rounded-lg transition flex items-center gap-2 ${
                  currentPage === 'launched-games'
                    ? isAdminMode ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'
                    : 'text-slate-300 hover:bg-slate-700'
                }`}
              >
                <List size={16} />
                Launched
              </button>
              <button
                onClick={() => setCurrentPage('config')}
                className={`px-4 py-2 rounded-lg transition flex items-center gap-2 ${
                  currentPage === 'config'
                    ? isAdminMode ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'
                    : 'text-slate-300 hover:bg-slate-700'
                }`}
              >
                <Settings size={16} />

              </button>
              <button
                onClick={() => setCurrentPage('api-docs')}
                className={`px-4 py-2 rounded-lg transition flex items-center gap-2 ${
                  currentPage === 'api-docs'
                    ? isAdminMode ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'
                    : 'text-slate-300 hover:bg-slate-700'
                }`}
              >
                <BookOpen size={16} />
                API Docs
              </button>
              <button
                onClick={() => setCurrentPage('api-logs')}
                className={`px-4 py-2 rounded-lg transition flex items-center gap-2 ${
                  currentPage === 'api-logs'
                    ? isAdminMode ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'
                    : 'text-slate-300 hover:bg-slate-700'
                }`}
              >
                <Activity size={16} />
                API Logs
              </button>
              <button
                onClick={() => setCurrentPage('client-cards')}
                className={`px-4 py-2 rounded-lg transition flex items-center gap-2 ${
                  currentPage === 'client-cards'
                    ? isAdminMode ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'
                    : 'text-slate-300 hover:bg-slate-700'
                }`}
              >
                <CreditCard size={16} />
                Cards
              </button>
              <button
                onClick={() => setCurrentPage('patterns')}
                className={`px-4 py-2 rounded-lg transition flex items-center gap-2 ${
                  currentPage === 'patterns'
                    ? isAdminMode ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'
                    : 'text-slate-300 hover:bg-slate-700'
                }`}
              >
                <Map size={16} />
                Patterns
              </button>
              {isAdminMode && (
                <>
                  <button
                    onClick={() => setCurrentPage('layouts')}
                    className={`px-4 py-2 rounded-lg transition flex items-center gap-2 ${
                      currentPage === 'layouts'
                        ? 'bg-red-600 text-white'
                        : 'text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <Layout size={16} />
                    Layouts
                  </button>
                  <button
                    onClick={() => setCurrentPage('admin-config')}
                    className={`px-4 py-2 rounded-lg transition flex items-center gap-2 ${
                      currentPage === 'admin-config'
                        ? 'bg-red-600 text-white'
                        : 'text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <ShieldCheck size={16} />
                    Admin Config
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </nav>

      {currentPage === 'games' && <GameList />}
      {currentPage === 'launched-games' && <LaunchedGamesList />}
      {currentPage === 'config' && <ConfigurationPage />}
      {currentPage === 'api-docs' && <ApiDocsPage />}
      {currentPage === 'client-cards' && <ClientCardsPage />}
      {currentPage === 'api-logs' && <ApiLogsPage />}
      {currentPage === 'patterns' && <PatternsPage />}
      {currentPage === 'layouts' && isAdminMode && <LayoutManagement />}
      {currentPage === 'admin-config' && isAdminMode && <AdminConfigPage />}

      {showOnboarding && (
        <OnboardingModal onComplete={handleOnboardingComplete} />
      )}

      <EmailSetupModal
        isOpen={showEmailSetup}
        onSave={handleEmailSave}
      />

      <AdminPasswordModal
        isOpen={showPasswordModal}
        onClose={() => setShowPasswordModal(false)}
        onSuccess={handleAdminSuccess}
      />

      <SyncLoadingModal
        isOpen={showSyncModal}
        steps={syncSteps}
        currentStep={currentSyncStep}
        downloadsNeeded={downloadsNeeded}
        onClose={() => setShowSyncModal(false)}
        onDownloadAll={handleDownloadAll}
      />
    </div>
  );
}

export default App;
