import { useState } from 'react';
import { Download, Check, X, Loader } from 'lucide-react';
import { ScenarioSummary, getScenarioGameData, downloadMediaFile, extractMediaFiles, getAvailableScenarios, downloadAvailableScenario } from '../services/scenarioDownload';
import { removeCircularReferences } from '../utils/circularReferenceHandler';

interface ScenarioDownloadModalProps {
  isOpen: boolean;
  scenarios: ScenarioSummary[];
  email: string;
  onComplete: () => void;
  onCancel: () => void;
}

interface DownloadStatus {
  uniqid: string;
  status: 'pending' | 'downloading' | 'completed' | 'error';
  progress: string;
  error?: string;
  totalFiles?: number;
  downloadedFiles?: number;
  failedFiles?: number;
  totalSize?: number;
  downloadedSize?: number;
  currentFile?: string;
  failedFilesList?: string[];
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
};

export function ScenarioDownloadModal({ isOpen, scenarios, email, onComplete, onCancel }: ScenarioDownloadModalProps) {
  const [downloadStatuses, setDownloadStatuses] = useState<Map<string, DownloadStatus>>(
    new Map(scenarios.map(s => [s.uniqid, { uniqid: s.uniqid, status: 'pending', progress: '⏳ Waiting to start...' }]))
  );
  const [isDownloading, setIsDownloading] = useState(false);

  const updateStatus = (uniqid: string, updates: Partial<DownloadStatus>) => {
    setDownloadStatuses(prev => {
      const newMap = new Map(prev);
      const current = newMap.get(uniqid);
      if (current) {
        const updated = { ...current, ...updates };
        newMap.set(uniqid, updated);
        console.log(`[UI Update] Status for ${uniqid}:`, updated);
      }
      return newMap;
    });
  };

  const handleDownload = async () => {
    setIsDownloading(true);

    const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

    if (!isElectron) {
      alert('Download feature is only available in the Electron app');
      return;
    }

    for (const scenario of scenarios) {
      try {
        console.log(`[Download] Starting download for scenario: ${scenario.uniqid}`);
        updateStatus(scenario.uniqid, { status: 'downloading', progress: '📥 Fetching game data from server...' });

        console.log(`[Download] Fetching game data from API...`);
        const gameData = await getScenarioGameData(email, scenario.uniqid);
        console.log(`[Download] Game data fetched successfully, size: ${JSON.stringify(gameData).length} characters`);

        await new Promise(resolve => setTimeout(resolve, 200));
        updateStatus(scenario.uniqid, { progress: '🔄 Processing game data...' });
        console.log(`[Download] Cleaning circular references...`);
        const cleanedGameData = removeCircularReferences(gameData);
        console.log(`[Download] Circular references cleaned, saving game data...`);

        await new Promise(resolve => setTimeout(resolve, 200));
        updateStatus(scenario.uniqid, { progress: '💾 Saving game data...' });
        await (window as any).electron.scenarios.saveGameData(scenario.uniqid, cleanedGameData);
        console.log(`[Download] Game data saved successfully`);

        await new Promise(resolve => setTimeout(resolve, 200));
        updateStatus(scenario.uniqid, { progress: '📋 Analyzing media files...' });
        console.log(`[Download] Extracting media files list...`);
        const mediaFiles = extractMediaFiles(gameData);
        const totalFiles = mediaFiles.length;
        let downloadedFiles = 0;
        let failedFiles = 0;
        let downloadedSize = 0;
        const failedFilesList: string[] = [];
        console.log(`[Download] Found ${totalFiles} media files to download`);

        await new Promise(resolve => setTimeout(resolve, 300));

        updateStatus(scenario.uniqid, {
          progress: `⬇️ Starting download of ${totalFiles} media files...`,
          totalFiles,
          downloadedFiles: 0,
          failedFiles: 0,
          downloadedSize: 0,
          failedFilesList: []
        });

        if (mediaFiles.length > 0) {
          console.log(`[Download] ==================== DOWNLOADING ${totalFiles} MEDIA FILES ====================`);

          for (let i = 0; i < mediaFiles.length; i++) {
            const mediaFile = mediaFiles[i];
            const fileProgress = `${i + 1}/${totalFiles}`;
            console.log(`[Download] [${fileProgress}] Downloading: ${mediaFile.folder}/${mediaFile.filename}`);

            updateStatus(scenario.uniqid, {
              progress: `⬇️ Downloading media files (${fileProgress})`,
              currentFile: `${mediaFile.folder}/${mediaFile.filename}`,
              downloadedFiles,
              failedFiles,
              totalFiles,
              downloadedSize,
              failedFilesList
            });

            await new Promise(resolve => setTimeout(resolve, 10));

            try {
              const downloadStartTime = Date.now();
              const blob = await downloadMediaFile(email, scenario.uniqid, mediaFile.filename);
              const fileSize = blob.size;
              const downloadDuration = Date.now() - downloadStartTime;
              downloadedFiles++;
              downloadedSize += fileSize;

              console.log(`[Download] ✅ [${fileProgress}] Downloaded in ${downloadDuration}ms: ${mediaFile.filename} (${fileSize} bytes)`);

              updateStatus(scenario.uniqid, {
                progress: `💾 Saving media files (${fileProgress})`,
                currentFile: `${mediaFile.folder}/${mediaFile.filename}`,
                downloadedFiles,
                failedFiles,
                totalFiles,
                downloadedSize,
                failedFilesList
              });

              await new Promise(resolve => setTimeout(resolve, 10));

              console.log(`[Download] [${fileProgress}] Converting to base64: ${mediaFile.filename}`);
              const arrayBuffer = await blob.arrayBuffer();
              const bytes = new Uint8Array(arrayBuffer);

              let binary = '';
              const chunkSize = 8192;
              for (let j = 0; j < bytes.length; j += chunkSize) {
                const chunk = bytes.slice(j, j + chunkSize);
                binary += String.fromCharCode(...chunk);
              }
              const base64 = btoa(binary);
              console.log(`[Download] [${fileProgress}] Converted to base64: ${base64.length} characters`);

              console.log(`[Download] [${fileProgress}] Saving to disk: ${mediaFile.folder}/${mediaFile.filename}`);
              await (window as any).electron.scenarios.saveMedia(
                scenario.uniqid,
                mediaFile.folder,
                mediaFile.filename,
                base64
              );
              console.log(`[Download] ✅ [${fileProgress}] Saved: ${mediaFile.folder}/${mediaFile.filename}`);

              updateStatus(scenario.uniqid, {
                progress: `⬇️ Downloading media files (${fileProgress})`,
                currentFile: `${mediaFile.folder}/${mediaFile.filename}`,
                downloadedFiles,
                failedFiles,
                totalFiles,
                downloadedSize,
                failedFilesList
              });

              await new Promise(resolve => setTimeout(resolve, 10));
            } catch (mediaError) {
              failedFiles++;
              const failedFilePath = `${mediaFile.folder}/${mediaFile.filename}`;
              failedFilesList.push(failedFilePath);
              console.error(`[Download] ❌ [${fileProgress}] ERROR downloading ${mediaFile.filename}:`, mediaError);
              console.error(`[Download] ❌ [${fileProgress}] Continuing with next file...`);

              updateStatus(scenario.uniqid, {
                progress: `⚠️ Download error - continuing (${fileProgress})`,
                currentFile: failedFilePath,
                downloadedFiles,
                failedFiles,
                totalFiles,
                downloadedSize,
                failedFilesList
              });

              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }

          if (failedFiles > 0) {
            console.log(`[Download] ==================== DOWNLOAD COMPLETED WITH ${failedFiles} FAILURES ====================`);
            console.log(`[Download] Failed files:`, failedFilesList);
          } else {
            console.log(`[Download] ==================== ALL FILES DOWNLOADED SUCCESSFULLY ====================`);
          }
        } else {
          console.log(`[Download] ⚠️ No media files to download`);
        }

        console.log(`[Download] Scenario download completed: ${scenario.uniqid}`);
        updateStatus(scenario.uniqid, {
          status: 'completed',
          progress: failedFiles > 0
            ? `⚠️ Completed with ${failedFiles} error${failedFiles > 1 ? 's' : ''}`
            : '✅ Download completed successfully',
          downloadedFiles,
          failedFiles,
          totalFiles,
          downloadedSize,
          failedFilesList
        });
      } catch (error) {
        console.error(`[Download] ERROR downloading scenario ${scenario.uniqid}:`, error);
        console.error(`[Download] Error stack:`, error instanceof Error ? error.stack : 'No stack trace');
        updateStatus(scenario.uniqid, {
          status: 'error',
          progress: '❌ Download failed',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    const allCompleted = Array.from(downloadStatuses.values()).every(
      status => status.status === 'completed' || status.status === 'error'
    );

    if (allCompleted) {
      console.log('[Download] All purchased scenarios downloaded. Fetching available scenarios...');

      try {
        const availableScenarios = await getAvailableScenarios(email);
        console.log(`[Download] Found ${availableScenarios.length} available scenarios for purchase`);

        if (availableScenarios.length > 0) {
          console.log('[Download] Starting download of available scenarios...');

          for (const availableScenario of availableScenarios) {
            try {
              console.log(`[Download] Downloading available scenario: ${availableScenario.scenario.uniqid}`);
              await downloadAvailableScenario(email, availableScenario);
              console.log(`[Download] ✅ Successfully downloaded available scenario: ${availableScenario.scenario.uniqid}`);
            } catch (error) {
              console.error(`[Download] ❌ Failed to download available scenario ${availableScenario.scenario.uniqid}:`, error);
            }
          }
        }
      } catch (error) {
        console.error('[Download] Error fetching available scenarios:', error);
      }

      await (window as any).electron.scenarios.refresh();
      setTimeout(() => {
        setIsDownloading(false);
        onComplete();
      }, 1000);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-lg shadow-2xl border border-slate-700 max-w-2xl w-full max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-slate-700">
          <div className="flex items-center gap-3">
            <Download className="text-blue-400" size={24} />
            <h2 className="text-xl font-bold text-white">Download Scenarios</h2>
          </div>
          {!isDownloading && (
            <button
              onClick={onCancel}
              className="text-slate-400 hover:text-white transition-colors"
            >
              <X size={24} />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <p className="text-slate-300 mb-6">
            {isDownloading ? 'Downloading scenarios...' : 'The following scenarios will be downloaded:'}
          </p>

          <div className="space-y-2">
            {scenarios.map((scenario) => {
              const status = downloadStatuses.get(scenario.uniqid);
              console.log(`[Render] Scenario ${scenario.uniqid} status:`, status);
              return (
                <div
                  key={`${scenario.uniqid}-${status?.status}-${status?.downloadedFiles}`}
                  className={`flex items-center justify-between gap-4 p-4 rounded-lg border transition-all ${
                    status?.status === 'completed'
                      ? 'bg-green-500/10 border-green-500/30'
                      : status?.status === 'downloading'
                      ? 'bg-blue-500/10 border-blue-500/30'
                      : status?.status === 'error'
                      ? 'bg-red-500/10 border-red-500/30'
                      : 'bg-slate-700/30 border-slate-600'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0">
                        {status?.status === 'pending' && (
                          <div className="w-5 h-5 rounded-full border-2 border-slate-500" />
                        )}
                        {status?.status === 'downloading' && (
                          <Loader className="text-blue-400 animate-spin" size={20} />
                        )}
                        {status?.status === 'completed' && (
                          <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center">
                            <Check size={14} className="text-white font-bold" strokeWidth={3} />
                          </div>
                        )}
                        {status?.status === 'error' && (
                          <div className="w-5 h-5 rounded-full bg-red-500 flex items-center justify-center">
                            <X size={14} className="text-white font-bold" strokeWidth={3} />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-white truncate">{scenario.title}</h3>
                        {status?.status === 'downloading' && typeof status.totalFiles === 'number' && (
                          <div className="mt-1 flex items-center gap-2 text-xs text-slate-300">
                            <span>
                              {status.downloadedFiles}/{status.totalFiles} files
                            </span>
                            <span className="text-slate-500">•</span>
                            <span className="text-blue-400 font-semibold">
                              {Math.round(((status.downloadedFiles || 0) / status.totalFiles) * 100)}%
                            </span>
                            {status.downloadedSize !== undefined && (
                              <>
                                <span className="text-slate-500">•</span>
                                <span className="text-slate-400">
                                  {formatFileSize(status.downloadedSize)}
                                </span>
                              </>
                            )}
                          </div>
                        )}
                        {status?.status === 'completed' && typeof status.downloadedFiles === 'number' && (
                          <div className="mt-1 text-xs text-green-400">
                            {status.downloadedFiles} file{status.downloadedFiles !== 1 ? 's' : ''} downloaded
                            {typeof status.downloadedSize === 'number' && ` • ${formatFileSize(status.downloadedSize)}`}
                          </div>
                        )}
                        {status?.status === 'error' && status.error && (
                          <div className="mt-1 text-xs text-red-400">
                            {status.error}
                          </div>
                        )}
                      </div>
                    </div>
                    {status?.status === 'downloading' && status.totalFiles && status.totalFiles > 0 && (
                      <div className="mt-2 w-full bg-slate-600 rounded-full h-1.5 overflow-hidden">
                        <div
                          className="bg-gradient-to-r from-blue-500 to-blue-400 h-1.5 rounded-full transition-all duration-200 ease-out"
                          style={{ width: `${((status.downloadedFiles || 0) / status.totalFiles) * 100}%` }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="p-6 border-t border-slate-700 flex justify-end gap-3">
          {!isDownloading ? (
            <>
              <button
                onClick={onCancel}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors text-white"
              >
                {scenarios.length > 0 ? 'Skip' : 'Close'}
              </button>
              {scenarios.length > 0 && (
                <button
                  onClick={handleDownload}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors text-white flex items-center gap-2"
                >
                  <Download size={16} />
                  Download All
                </button>
              )}
            </>
          ) : (
            <button
              disabled
              className="px-4 py-2 bg-slate-600 rounded-lg text-white opacity-50 cursor-not-allowed"
            >
              Downloading...
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
