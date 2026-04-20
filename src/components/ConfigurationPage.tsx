import { useEffect, useState, useRef } from 'react';
import { Settings, Usb, RefreshCw, Check, Globe, FolderOpen, Monitor, CreditCard, Upload, BookOpen, Map, Layers, LayoutGrid as Layout } from 'lucide-react';
import { usbReaderService } from '../services/usbReader';
import { loadConfig, saveConfig, AppConfig } from '../utils/config';
import { syncResourcesBeforeScenarios } from '../services/syncOrchestrator';
import { detectFileType, saveUploadedFile, UploadResult } from '../utils/fileUpload';
import { FolderBrowser } from './FolderBrowser';
import { LayoutManagement } from './LayoutManagement';
import { ScenariosManagement } from './ScenariosManagement';
import { PatternsManagement } from './PatternsManagement';
import { CardsManagement } from './CardsManagement';

interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
}

export function ConfigurationPage() {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [config, setConfig] = useState<AppConfig>({ usbPort: '', language: 'english', fullscreenOnLaunch: false, autoLaunch: false });
  const [savedConfig, setSavedConfig] = useState<AppConfig>({ usbPort: '', language: 'english', fullscreenOnLaunch: false, autoLaunch: false });
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isElectron, setIsElectron] = useState(false);
  const [dbTables, setDbTables] = useState<string[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    setIsElectron(usbReaderService.isElectron());
    loadConfiguration();
    checkDatabaseConnection();
    if (usbReaderService.isElectron()) {
      loadPorts();
    }
  }, []);

  const loadConfiguration = async () => {
    try {
      const loadedConfig = await loadConfig();
      setConfig(loadedConfig);
      setSavedConfig(loadedConfig);
    } catch (error) {
      console.error('Error loading configuration:', error);
    }
  };

  const checkDatabaseConnection = async () => {
    setDbLoading(true);
    setDbError(null);
    try {
      const { supabase } = await import('../lib/db');

      if (!supabase) {
        setDbError('Database not configured. Environment variables missing.');
        setDbLoading(false);
        return;
      }

      const { error } = await supabase
        .from('configuration')
        .select('id', { count: 'exact', head: true });

      if (error) {
        console.error('Database connection error:', error);
        setDbError(`Failed to connect: ${error.message}`);
      } else {
        const tables = ['launched_games', 'launched_game_meta', 'teams', 'si_puces', 'game_types', 'configuration', 'launched_game_devices'];
        setDbTables(tables);
      }
    } catch (error: any) {
      console.error('Error checking database connection:', error);
      setDbError(`Connection failed: ${error?.message || 'Unknown error'}`);
    } finally {
      setDbLoading(false);
    }
  };

  const loadPorts = async () => {
    setIsLoading(true);
    try {
      const availablePorts = await usbReaderService.getAvailablePorts();
      setPorts(availablePorts);
    } catch (error) {
      console.error('Error loading ports:', error);
      setMessage({ type: 'error', text: 'Failed to load USB ports' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await saveConfig(config);

      if (isElectron && config.autoLaunch !== undefined && (window as any).electron?.setAutoLaunch) {
        await (window as any).electron.setAutoLaunch(config.autoLaunch);
      }

      setSavedConfig(config);
      setMessage({ type: 'success', text: 'Configuration saved successfully' });
      setTimeout(() => setMessage(null), 3000);
    } catch (error) {
      console.error('Error saving configuration:', error);
      setMessage({ type: 'error', text: 'Failed to save configuration' });
    } finally {
      setIsSaving(false);
    }
  };


  const handleOpenDataFolder = async () => {
    try {
      await (window as any).electron.system.openDataFolder();
      setMessage({ type: 'success', text: 'Data folder opened in File Explorer' });
      setTimeout(() => setMessage(null), 3000);
    } catch (error) {
      console.error('Error opening data folder:', error);
      setMessage({ type: 'error', text: 'Failed to open data folder' });
    }
  };

  const handleRefreshBilling = async () => {
    if (!config.email) {
      setMessage({ type: 'error', text: 'Please enter an email address first' });
      return;
    }

    setMessage({ type: 'success', text: 'Refreshing billing status...' });
    try {
      const { getBillingStatus } = await import('../services/resourceSync');
      const apiUrl = 'https://admin.taghunter.fr/backend/api/playground.php';
      const billingStatus = await getBillingStatus(apiUrl, config.email);

      const updatedConfig = {
        ...config,
        billingUpToDate: billingStatus.billing_up_to_date,
        licenseType: billingStatus.license_type,
        lastBillingSyncDate: new Date().toISOString(),
      };

      await saveConfig(updatedConfig);
      setConfig(updatedConfig);
      setSavedConfig(updatedConfig);

      setMessage({ type: 'success', text: 'Billing status refreshed successfully!' });
      setTimeout(() => setMessage(null), 3000);
    } catch (error) {
      console.error('Error refreshing billing status:', error);
      setMessage({ type: 'error', text: 'Failed to refresh billing status' });
      setTimeout(() => setMessage(null), 3000);
    }
  };

  const handleRestartSync = async () => {
    if (!config.email) {
      setMessage({ type: 'error', text: 'Please enter an email address first' });
      return;
    }

    setIsSyncing(true);
    setMessage({ type: 'success', text: 'Starting resource sync...' });

    try {
      const result = await syncResourcesBeforeScenarios((stepId, status, details) => {
        console.log(`[Sync] ${stepId}: ${status}`, details);
      });

      if (result.success) {
        if (result.downloadsNeeded.length > 0) {
          setMessage({ type: 'success', text: `Sync completed! ${result.downloadsNeeded.length} updates available.` });
        } else {
          setMessage({ type: 'success', text: 'Sync completed! All resources are up to date.' });
        }
        await loadConfiguration();
      } else {
        setMessage({ type: 'error', text: `Sync failed: ${result.error || 'Unknown error'}` });
      }

      setTimeout(() => setMessage(null), 5000);
    } catch (error) {
      console.error('Error during sync:', error);
      setMessage({ type: 'error', text: 'Failed to sync resources' });
      setTimeout(() => setMessage(null), 3000);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadResult(null);
    setMessage({ type: 'success', text: 'Processing file...' });

    try {
      const result = await detectFileType(file);
      setUploadResult(result);

      if (result.isValid) {
        setMessage({ type: 'success', text: `Detected ${result.type} file: ${result.name}. Saving...` });
        await saveUploadedFile(result);
        setMessage({ type: 'success', text: `Successfully uploaded ${result.type}: ${result.name}` });
        setTimeout(() => setMessage(null), 5000);
      } else {
        setMessage({ type: 'error', text: result.error || 'Invalid file' });
        setTimeout(() => setMessage(null), 5000);
      }
    } catch (error) {
      console.error('Error uploading file:', error);
      setMessage({ type: 'error', text: `Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}` });
      setTimeout(() => setMessage(null), 5000);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadResult(null);
    setMessage({ type: 'success', text: 'Processing file...' });

    try {
      const result = await detectFileType(file);
      setUploadResult(result);

      if (result.isValid) {
        setMessage({ type: 'success', text: `Detected ${result.type} file: ${result.name}. Saving...` });
        await saveUploadedFile(result);
        setMessage({ type: 'success', text: `Successfully uploaded ${result.type}: ${result.name}` });
        setTimeout(() => setMessage(null), 5000);
      } else {
        setMessage({ type: 'error', text: result.error || 'Invalid file' });
        setTimeout(() => setMessage(null), 5000);
      }
    } catch (error) {
      console.error('Error uploading file:', error);
      setMessage({ type: 'error', text: `Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}` });
      setTimeout(() => setMessage(null), 5000);
    } finally {
      setIsUploading(false);
    }
  };


  if (!isElectron) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white py-8">
        <div className="container mx-auto px-6 max-w-4xl">
          <div className="flex items-center gap-3 mb-8">
            <Settings className="text-blue-400" size={32} />
            <h1 className="text-3xl font-bold">Configuration</h1>
          </div>

          {message && (
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

          <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Upload className="text-blue-400" size={24} />
                <h2 className="text-xl font-semibold">Upload Files</h2>
              </div>
            </div>

            <div className="mb-6">
              <button
                onClick={handleUploadClick}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                disabled={isUploading}
                className={`w-full flex flex-col items-center justify-center gap-4 p-8 rounded-lg border-2 border-dashed transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                  isDragging
                    ? 'bg-blue-900/30 border-blue-400'
                    : 'bg-slate-700/30 hover:bg-slate-700/50 border-slate-600 hover:border-blue-500'
                }`}
              >
                <div className={`w-16 h-16 rounded-full flex items-center justify-center ${
                  isUploading ? 'bg-blue-600/40 animate-pulse' : isDragging ? 'bg-blue-600/30' : 'bg-blue-600/20'
                }`}>
                  <Upload className={`${isDragging ? 'text-blue-300' : 'text-blue-400'}`} size={32} />
                </div>
                <div className="text-center">
                  <div className="text-lg font-semibold text-white mb-2">
                    {isUploading ? 'Uploading...' : isDragging ? 'Drop file here' : 'Upload Files'}
                  </div>
                  <div className="text-sm text-slate-400">
                    {isDragging ? 'Release to upload' : 'Click to select files or drag and drop'}
                  </div>
                </div>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,.json,.csv"
                onChange={handleFileUpload}
                className="hidden"
              />
            </div>

            <div className="text-sm text-slate-400 space-y-2">
              <p className="font-semibold text-slate-300">Supported file types:</p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li><span className="font-mono text-blue-400">.zip</span> - Game scenarios with CSV and media files</li>
                <li><span className="font-mono text-blue-400">.json</span> - Layout files (format: {'{game_type}_layout_{version}.json'})</li>
                <li><span className="font-mono text-blue-400">.json</span> - Pattern files (format: {'pattern_{pattern_slug}.json'})</li>
                <li><span className="font-mono text-blue-400">.csv</span> - Pattern CSV files (filename contains "pattern")</li>
                <li><span className="font-mono text-blue-400">.csv</span> - Cards files (filename contains "card", "client", or starts with "on_demand_")</li>
              </ul>
            </div>
          </div>

          <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
            <div className="flex items-center gap-2 mb-5">
              <BookOpen className="text-blue-400" size={20} />
              <h3 className="text-lg font-semibold">Scenarios Management</h3>
            </div>
            <ScenariosManagement />
          </div>

          <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
            <div className="flex items-center gap-2 mb-5">
              <Map className="text-blue-400" size={20} />
              <h3 className="text-lg font-semibold">Patterns Management</h3>
            </div>
            <PatternsManagement />
          </div>

          <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
            <div className="flex items-center gap-2 mb-5">
              <Layers className="text-blue-400" size={20} />
              <h3 className="text-lg font-semibold">Cards Management</h3>
            </div>
            <CardsManagement />
          </div>

          <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
            <div className="flex items-center gap-2 mb-5">
              <Layout className="text-blue-400" size={20} />
              <h3 className="text-lg font-semibold">Layout Management</h3>
            </div>
            <LayoutManagement />
          </div>

          <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
            <h3 className="text-lg font-semibold mb-3">Note</h3>
            <div className="text-sm text-slate-400 space-y-2">
              <p>
                Advanced configuration options (USB port selection, display settings) are only available in the Electron desktop app.
              </p>
              <p>
                Upload your game scenario ZIP files here to make them available in your scenario library.
              </p>
            </div>
          </div>

          <FolderBrowser isElectron={isElectron} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white py-8">
      <div className="container mx-auto px-6 max-w-4xl">
        <div className="flex items-center gap-3 mb-8">
          <Settings className="text-blue-400" size={32} />
          <h1 className="text-3xl font-bold">Configuration</h1>
        </div>

        <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <Globe className="text-blue-400" size={24} />
              <h2 className="text-xl font-semibold">User Email & Scenarios</h2>
            </div>
            {isElectron && config.email && (
              <button
                onClick={handleRestartSync}
                disabled={isSyncing}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw size={16} className={isSyncing ? 'animate-spin' : ''} />
                {isSyncing ? 'Syncing...' : 'Sync Resources'}
              </button>
            )}
          </div>

          {message && (
            <div
              className={`mb-4 p-4 rounded-lg ${
                message.type === 'success'
                  ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                  : 'bg-red-500/20 text-red-400 border border-red-500/30'
              }`}
            >
              {message.text}
            </div>
          )}

          <div className="mb-6">
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Email Address
            </label>
            <input
              type="email"
              value={config.email || ''}
              onChange={(e) => setConfig({ ...config, email: e.target.value })}
              placeholder="your.email@example.com"
              className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:border-blue-500"
            />
            <p className="text-xs text-slate-400 mt-2">
              Used to sync scenarios from the Taghunter Admin system
            </p>
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={isSaving || JSON.stringify(config) === JSON.stringify(savedConfig)}
              className="flex items-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-semibold"
            >
              {isSaving ? (
                <>
                  <RefreshCw size={16} className="animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Check size={16} />
                  Save Configuration
                </>
              )}
            </button>
          </div>
        </div>

        {isElectron && config.email && (
          <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <CreditCard className="text-blue-400" size={24} />
                <h2 className="text-xl font-semibold">Billing Information</h2>
              </div>
              <button
                onClick={handleRefreshBilling}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
              >
                <RefreshCw size={16} />
                Refresh Status
              </button>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 rounded-lg border-2 border-slate-700 bg-slate-700/30">
                <div>
                  <div className="text-sm font-medium text-slate-400 mb-1">Billing Status</div>
                  <div className="flex items-center gap-2">
                    {config.billingUpToDate === true ? (
                      <>
                        <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                        <span className="text-lg font-semibold text-green-400">Up to Date</span>
                      </>
                    ) : config.billingUpToDate === false ? (
                      <>
                        <div className="w-3 h-3 bg-red-500 rounded-full"></div>
                        <span className="text-lg font-semibold text-red-400">Payment Required</span>
                      </>
                    ) : (
                      <>
                        <div className="w-3 h-3 bg-slate-500 rounded-full"></div>
                        <span className="text-lg font-semibold text-slate-400">Unknown</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between p-4 rounded-lg border-2 border-slate-700 bg-slate-700/30">
                <div>
                  <div className="text-sm font-medium text-slate-400 mb-1">License Type</div>
                  <div className="text-lg font-semibold text-white capitalize">
                    {config.licenseType || 'Not Synced'}
                  </div>
                </div>
              </div>

              {config.lastBillingSyncDate && (
                <div className="flex items-center justify-between p-4 rounded-lg border-2 border-slate-700 bg-slate-700/30">
                  <div>
                    <div className="text-sm font-medium text-slate-400 mb-1">Last Sync</div>
                    <div className="text-lg font-semibold text-white">
                      {new Date(config.lastBillingSyncDate).toLocaleString()}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
          <div className="flex items-center gap-2 mb-6">
            <Globe className="text-blue-400" size={24} />
            <h2 className="text-xl font-semibold">Language</h2>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-6">
            <button
              onClick={() => setConfig({ ...config, language: 'english' })}
              className={`p-4 rounded-lg border-2 transition-all ${
                config.language === 'english'
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-slate-700 bg-slate-700/30 hover:border-slate-600'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold text-lg">English</div>
                  <div className="text-sm text-slate-400">English language</div>
                </div>
                {config.language === 'english' && (
                  <Check className="text-blue-400" size={24} />
                )}
              </div>
            </button>

            <button
              onClick={() => setConfig({ ...config, language: 'french' })}
              className={`p-4 rounded-lg border-2 transition-all ${
                config.language === 'french'
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-slate-700 bg-slate-700/30 hover:border-slate-600'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold text-lg">Français</div>
                  <div className="text-sm text-slate-400">French language</div>
                </div>
                {config.language === 'french' && (
                  <Check className="text-blue-400" size={24} />
                )}
              </div>
            </button>
          </div>
        </div>

        {isElectron && (
          <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
            <div className="flex items-center gap-2 mb-6">
              <Monitor className="text-blue-400" size={24} />
              <h2 className="text-xl font-semibold">Display Settings</h2>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 rounded-lg border-2 border-slate-700 bg-slate-700/30 hover:border-slate-600 transition-all">
                <div>
                  <div className="font-semibold text-lg">Fullscreen on Launch</div>
                  <div className="text-sm text-slate-400">Automatically open the app in fullscreen mode</div>
                </div>
                <button
                  onClick={() => setConfig({ ...config, fullscreenOnLaunch: !config.fullscreenOnLaunch })}
                  className={`relative inline-flex h-7 w-14 items-center rounded-full transition-colors ${
                    config.fullscreenOnLaunch ? 'bg-blue-600' : 'bg-slate-600'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                      config.fullscreenOnLaunch ? 'translate-x-8' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between p-4 rounded-lg border-2 border-slate-700 bg-slate-700/30 hover:border-slate-600 transition-all">
                <div>
                  <div className="font-semibold text-lg">Launch on Startup</div>
                  <div className="text-sm text-slate-400">Start automatically when your computer boots</div>
                </div>
                <button
                  onClick={() => setConfig({ ...config, autoLaunch: !config.autoLaunch })}
                  className={`relative inline-flex h-7 w-14 items-center rounded-full transition-colors ${
                    config.autoLaunch ? 'bg-blue-600' : 'bg-slate-600'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                      config.autoLaunch ? 'translate-x-8' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>
        )}

        {isElectron && (
          <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <Usb className="text-blue-400" size={24} />
              <h2 className="text-xl font-semibold">USB Port Selection</h2>
            </div>
            <button
              onClick={loadPorts}
              disabled={isLoading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>

          {isLoading ? (
            <div className="text-center py-8 text-slate-400">Loading USB ports...</div>
          ) : ports.length === 0 ? (
            <div className="text-center py-8 text-slate-400">
              No USB ports detected. Please connect a USB device and refresh.
            </div>
          ) : (
            <div className="space-y-3">
              {ports.map((port) => (
                <div
                  key={port.path}
                  onClick={() => setConfig({ ...config, usbPort: port.path })}
                  className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${
                    config.usbPort === port.path
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-slate-700 bg-slate-700/30 hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="font-mono font-semibold text-lg">{port.path}</span>
                        {savedConfig.usbPort === port.path && (
                          <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs rounded-full border border-green-500/30">
                            Current
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-slate-400 space-y-1">
                        {port.manufacturer && (
                          <div>
                            <span className="text-slate-500">Manufacturer:</span> {port.manufacturer}
                          </div>
                        )}
                        {port.serialNumber && (
                          <div>
                            <span className="text-slate-500">Serial:</span> {port.serialNumber}
                          </div>
                        )}
                        {port.vendorId && port.productId && (
                          <div>
                            <span className="text-slate-500">VID/PID:</span> {port.vendorId}/{port.productId}
                          </div>
                        )}
                      </div>
                    </div>
                    {config.usbPort === port.path && (
                      <Check className="text-blue-400 flex-shrink-0" size={24} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

        </div>
        )}

        {/* <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <Database className="text-blue-400" size={24} />
              <h2 className="text-xl font-semibold">Database Connection</h2>
            </div>
            <button
              onClick={checkDatabaseConnection}
              disabled={dbLoading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Refresh database connection"
            >
              <RefreshCw size={16} className={dbLoading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>

          {dbLoading ? (
            <div className="text-center py-8 text-slate-400">Checking database connection...</div>
          ) : dbError ? (
            <div className="bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg p-4">
              {dbError}
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-4 text-green-400">
                <Check size={20} />
                <span className="font-semibold">Connected to Supabase</span>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-300 mb-3">Available Tables ({dbTables.length})</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {dbTables.map((table) => (
                    <div
                      key={table}
                      className="px-3 py-2 bg-slate-700/50 rounded border border-slate-600 text-sm font-mono text-slate-300"
                    >
                      {table}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div> */}

        <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Data Folder</h3>
              <p className="text-sm text-slate-400">
                Open the application data folder to view scenarios, games, and configuration files.
              </p>
            </div>
            <button
              onClick={handleOpenDataFolder}
              className="flex items-center gap-2 px-4 py-2 bg-slate-600 hover:bg-slate-500 rounded-lg transition-colors"
            >
              <FolderOpen size={16} />
              Open Folder
            </button>
          </div>
          <div className="text-xs font-mono text-slate-500 bg-slate-900/50 p-3 rounded border border-slate-700">
            %APPDATA%\TagHunterPlayground\
          </div>
        </div>

        <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Upload Files</h3>
              <p className="text-sm text-slate-400">
                Upload game scenarios, patterns, cards, or layouts. Supports ZIP, JSON, and CSV files.
              </p>
            </div>
            <button
              onClick={handleUploadClick}
              disabled={isUploading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Upload size={16} className={isUploading ? 'animate-pulse' : ''} />
              {isUploading ? 'Uploading...' : 'Upload File'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,.json,.csv"
              onChange={handleFileUpload}
              className="hidden"
            />
          </div>

          <div className="text-sm text-slate-400 space-y-2">
            <p className="font-semibold text-slate-300">Supported file types:</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><span className="font-mono text-blue-400">.zip</span> - Game scenarios with game-data.json and media files</li>
              <li><span className="font-mono text-blue-400">.json</span> - Layout files (format: {'{game_type}_layout_{version}.json'})</li>
              <li><span className="font-mono text-blue-400">.json</span> - Pattern files (format: {'pattern_{pattern_slug}.json'})</li>
              <li><span className="font-mono text-blue-400">.csv</span> - Pattern CSV files (filename contains "pattern")</li>
              <li><span className="font-mono text-blue-400">.csv</span> - Cards files (filename contains "card", "client", or starts with "on_demand_")</li>
            </ul>
          </div>
        </div>

        <FolderBrowser isElectron={isElectron} />

        <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
          <div className="flex items-center gap-2 mb-5">
            <BookOpen className="text-blue-400" size={20} />
            <h3 className="text-lg font-semibold">Scenarios Management</h3>
          </div>
          <ScenariosManagement />
        </div>

        <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
          <div className="flex items-center gap-2 mb-5">
            <Map className="text-blue-400" size={20} />
            <h3 className="text-lg font-semibold">Patterns Management</h3>
          </div>
          <PatternsManagement />
        </div>

        <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
          <div className="flex items-center gap-2 mb-5">
            <Layers className="text-blue-400" size={20} />
            <h3 className="text-lg font-semibold">Cards Management</h3>
          </div>
          <CardsManagement />
        </div>

        <div className="bg-slate-800/50 rounded-lg p-6 mb-6">
          <div className="flex items-center gap-2 mb-5">
            <Layout className="text-blue-400" size={20} />
            <h3 className="text-lg font-semibold">Layout Management</h3>
          </div>
          <LayoutManagement />
        </div>

        <div className="bg-slate-800/50 rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-3">Information</h3>
          <div className="text-sm text-slate-400 space-y-2">
            <p>
              Select the USB port that connects to your Tag Hunter device. This port will be used when launching games.
            </p>
            <p>
              If you don't see your device, make sure it's connected and click the Refresh button.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
