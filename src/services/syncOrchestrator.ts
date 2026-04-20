import { checkInternetConnection } from '../utils/connectivity';
import { getUserDataUpdate, downloadCardsFile, downloadPattern, downloadLayout, downloadOnDemandCards } from './resourceSync';
import { getGameTypesFromScenarios } from '../utils/gameTypes';
import { DownloadQueueManager, getPriorityForType } from './downloadQueue';
import { DownloadItem } from '../types/downloadQueue';
import { loadConfig, saveConfig } from '../utils/config';
import { logApiCall } from './apiLogger';
import { compareVersions } from '../utils/versionCheck';

export interface SyncResult {
  success: boolean;
  billingUpdated: boolean;
  downloadsNeeded: DownloadItem[];
  error?: string;
}

export type SyncProgressCallback = (stepId: string, status: 'loading' | 'success' | 'error' | 'skipped', details?: string) => void;

export async function syncResourcesBeforeScenarios(onProgress?: SyncProgressCallback): Promise<SyncResult> {
  const startTime = Date.now();
  const downloadQueue = new DownloadQueueManager();

  try {
    const config = await loadConfig();

    if (!config.email) {
      console.log('[Sync] No email configured, skipping resource sync');
      onProgress?.('connectivity', 'skipped', 'No email configured');
      onProgress?.('billing', 'skipped');
      onProgress?.('userData', 'skipped');
      return { success: true, billingUpdated: false, downloadsNeeded: [] };
    }

    onProgress?.('connectivity', 'loading');
    console.log('[Sync] Step 1: Checking internet connectivity...');
    const hasInternet = await checkInternetConnection();

    if (!hasInternet) {
      console.log('[Sync] No internet connection, skipping resource sync');
      onProgress?.('connectivity', 'error', 'No internet connection detected');
      onProgress?.('billing', 'skipped');
      onProgress?.('userData', 'skipped');
      await logApiCall({
        endpoint: 'resource-sync',
        method: 'GET',
        statusCode: 0,
        duration: Date.now() - startTime,
        success: false,
        errorMessage: 'No internet connection',
      });
      return { success: true, billingUpdated: false, downloadsNeeded: [] };
    }
    onProgress?.('connectivity', 'success', 'Connected to internet');

    const apiUrl = 'https://admin.taghunter.fr/backend/api/playground.php';

    onProgress?.('billing', 'loading');
    onProgress?.('userData', 'loading');
    console.log('[Sync] Step 2: Fetching unified user data update (includes billing status)...');
    console.log('[Sync] Using unified endpoint: /backend/api/playground.php?action=get_user_data_update');
    console.log('[Sync] This replaces ALL individual API calls: billing, scenarios, cards, patterns, layouts');
    try {
      const userData = await getUserDataUpdate(apiUrl, config.email);

      // Update billing status from unified response
      const updatedConfig = {
        ...config,
        billingUpToDate: userData.billing_up_to_date,
        licenseType: userData.license_type,
        lastBillingSyncDate: new Date().toISOString(),
      };
      await saveConfig(updatedConfig);
      console.log('[Sync] ✓ Billing status updated from unified response');
      console.log(`[Sync]   - License: ${userData.license_type}`);
      console.log(`[Sync]   - Billing up to date: ${userData.billing_up_to_date}`);
      onProgress?.('billing', 'success', `License: ${userData.license_type}`);

      const totalScenarios = userData.custom_scenarios.length + userData.product_scenarios.length;
      const totalPatterns = userData.default_patterns.length + userData.custom_patterns.length;
      console.log('[Sync] ✓ Unified user data received successfully!');
      console.log(`[Sync]   - Scenarios: ${totalScenarios} (${userData.custom_scenarios.length} custom, ${userData.product_scenarios.length} product)`);
      console.log(`[Sync]   - Patterns: ${totalPatterns} (${userData.default_patterns.length} default, ${userData.custom_patterns.length} custom)`);
      console.log(`[Sync]   - Layouts: ${userData.layouts.length}`);
      console.log(`[Sync]   - Cards version: ${userData.cards_version}`);
      console.log(`[Sync]   - Has on-demand cards: ${userData.has_on_demand_cards}`);

      const localCardsVersionResult = await (window as any).electron.cards.getLocalVersion();
      const localCardsVersion = localCardsVersionResult.version || 0;

      console.log(`[Sync] Cards - Local: v${localCardsVersion}, Remote: v${userData.cards_version}`);

      if (compareVersions(localCardsVersion, userData.cards_version)) {
        console.log('[Sync] Cards update available, adding to queue');
        downloadQueue.addItem({
          type: 'cards',
          name: 'Client Cards',
          version: userData.cards_version,
          priority: getPriorityForType('cards'),
          downloadUrl: `${apiUrl}?action=download_cards&email=${encodeURIComponent(config.email)}&version=${userData.cards_version}`,
          targetPath: `cards_v${userData.cards_version}.csv`,
        });
      }

      if (userData.has_on_demand_cards) {
        console.log('[Sync] On-demand cards available, adding to queue');
        downloadQueue.addItem({
          type: 'on_demand_cards',
          name: 'On-Demand Cards',
          version: 1,
          priority: getPriorityForType('cards'),
          downloadUrl: `${apiUrl}?action=get_on_demand_cards&email=${encodeURIComponent(config.email)}`,
          targetPath: 'on_demand_cards.csv',
        });
      }

      let patternUpdates = 0;
      const allPatterns = [
        ...userData.default_patterns.map(p => ({ ...p, type: 'default' as const })),
        ...userData.custom_patterns.map(p => ({ ...p, type: 'custom' as const }))
      ];

      for (const pattern of allPatterns) {
        const localVersionResult = await (window as any).electron.patterns.getLocalVersions(pattern.game_type, pattern.name);
        const localVersion = localVersionResult.version || 0;

        console.log(`[Sync] Pattern ${pattern.name} (${pattern.game_type}) - Local: v${localVersion}, Remote: v${pattern.version}, uniqid: ${pattern.uniqid}`);

        if (compareVersions(localVersion, parseFloat(pattern.version))) {
          console.log(`[Sync] Pattern ${pattern.name} update available, adding to queue`);

          if (!pattern.uniqid) {
            console.error(`[Sync] Pattern ${pattern.name} is missing uniqid field. Pattern data:`, pattern);
            console.warn(`[Sync] Skipping pattern ${pattern.name} - cannot download without uniqid`);
            continue;
          }

          patternUpdates++;
          const patternType = pattern.type === 'default' ? 'default_patterns' : 'user_patterns';
          downloadQueue.addItem({
            type: 'pattern',
            name: pattern.name,
            version: parseFloat(pattern.version),
            gameType: pattern.game_type,
            patternUniqid: pattern.uniqid,
            priority: getPriorityForType('pattern'),
            downloadUrl: `${apiUrl}?action=download_pattern&email=${encodeURIComponent(config.email)}&pattern_uniqid=${pattern.uniqid}`,
            targetPath: `${pattern.game_type}/${patternType}/${pattern.name}_${pattern.version}`,
          });
        }
      }

      let layoutUpdates = 0;
      for (const layout of userData.layouts) {
        const localVersionResult = await (window as any).electron.layouts.getLocalVersions(layout.game_type);
        const localVersion = localVersionResult.version || 0;
        const remoteVersion = typeof layout.version === 'string' ? parseFloat(layout.version) : layout.version;

        console.log(`[Sync] Layout ${layout.game_type} - Local: v${localVersion}, Remote: v${remoteVersion}`);

        if (compareVersions(localVersion, remoteVersion)) {
          console.log(`[Sync] Layout ${layout.game_type} update available, adding to queue`);
          layoutUpdates++;
          downloadQueue.addItem({
            type: 'layout',
            name: `${layout.game_type} Layout`,
            version: remoteVersion,
            gameType: layout.game_type,
            layoutId: layout.id,
            priority: getPriorityForType('layout'),
            downloadUrl: `${apiUrl}?action=download_layout&email=${encodeURIComponent(config.email)}&layout_id=${layout.id}`,
            targetPath: `${layout.game_type}_${remoteVersion}`,
          });
        }
      }

      let scenarioUpdates = 0;
      const allScenarios = [
        ...userData.custom_scenarios,
        ...userData.product_scenarios
      ];

      const localScenarioVersions = await (window as any).electron.scenarios.getLocalVersions();
      console.log('[Sync] Local scenario versions:', localScenarioVersions);

      for (const scenario of allScenarios) {
        const localVersion = localScenarioVersions[scenario.uniqid] || '0';
        const remoteVersion = scenario.version || '1.0';

        console.log(`[Sync] Scenario ${scenario.name} (${scenario.uniqid}) - Local: v${localVersion}, Remote: v${remoteVersion}`);

        if (compareVersions(parseFloat(localVersion), parseFloat(remoteVersion))) {
          console.log(`[Sync] Scenario ${scenario.name} update available, adding to queue`);
          scenarioUpdates++;
          downloadQueue.addItem({
            type: 'scenario',
            name: scenario.name,
            version: parseFloat(remoteVersion),
            uniqid: scenario.uniqid,
            gameType: scenario.game_type,
            priority: getPriorityForType('scenario'),
            downloadUrl: `${apiUrl}?action=get_scenario_game_data&email=${encodeURIComponent(config.email)}&uniqid=${scenario.uniqid}`,
            targetPath: scenario.uniqid,
          });
        }
      }

      const updatesSummary = [
        totalScenarios > 0 ? `${totalScenarios} scenarios available` : null,
        scenarioUpdates > 0 ? `${scenarioUpdates} scenario updates` : null,
        patternUpdates > 0 ? `${patternUpdates} pattern updates` : null,
        layoutUpdates > 0 ? `${layoutUpdates} layout updates` : null,
      ].filter(Boolean).join(', ') || 'All up to date';

      console.log('[Sync] ✓ User data processing complete!');
      console.log(`[Sync] Summary: ${updatesSummary}`);
      onProgress?.('userData', 'success', updatesSummary);
    } catch (error) {
      console.error('[Sync] ✗ Failed to fetch user data update:', error);
      if (error instanceof Error) {
        console.error('[Sync] Error message:', error.message);
      }
      onProgress?.('userData', 'error', 'Failed to fetch user data');
    }

    const downloadsNeeded = downloadQueue.getQueue();
    console.log(`[Sync] Resource sync completed. ${downloadsNeeded.length} downloads needed`);

    await logApiCall({
      endpoint: 'resource-sync',
      method: 'GET',
      statusCode: 200,
      duration: Date.now() - startTime,
      success: true,
    });

    return {
      success: true,
      billingUpdated: true,
      downloadsNeeded,
    };
  } catch (error) {
    console.error('[Sync] Error during resource sync:', error);
    await logApiCall({
      endpoint: 'resource-sync',
      method: 'GET',
      statusCode: 0,
      duration: Date.now() - startTime,
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });

    return {
      success: false,
      billingUpdated: false,
      downloadsNeeded: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function downloadResourceItem(item: DownloadItem): Promise<void> {
  console.log(`[Download] Starting download for ${item.type}: ${item.name}`);

  const config = await loadConfig();
  if (!config?.email) {
    throw new Error('No email configured');
  }

  const apiUrl = 'https://admin.taghunter.fr/backend/api/playground.php';

  switch (item.type) {
    case 'cards':
      const cardsContent = await downloadCardsFile(apiUrl, config.email, item.version);
      await (window as any).electron.cards.saveFile(item.version, cardsContent);
      console.log(`[Download] Cards saved: v${item.version}`);
      break;

    case 'on_demand_cards':
      const onDemandCardsContent = await downloadOnDemandCards(apiUrl, config.email);
      await (window as any).electron.cards.saveOnDemandFile(onDemandCardsContent);
      console.log(`[Download] On-demand cards saved`);
      break;

    case 'pattern':
      if (!item.patternUniqid) {
        console.error('[Download] Cannot download pattern without patternUniqid');
        throw new Error('Pattern download requires patternUniqid');
      }
      const patternContent = await downloadPattern(apiUrl, config.email, item.patternUniqid);
      const isUserPattern = item.targetPath.includes('user_patterns');
      const patternSlug = item.name.toLowerCase().replace(/\s+/g, '_');
      await (window as any).electron.patterns.saveFile(
        item.gameType!,
        patternSlug,
        item.version,
        patternContent,
        isUserPattern
      );
      console.log(`[Download] Pattern saved: ${item.name} v${item.version}`);
      break;

    case 'layout':
      if (!item.layoutId) {
        console.error('[Download] Cannot download layout without layoutId');
        throw new Error('Layout download requires layoutId');
      }
      const layoutContent = await downloadLayout(apiUrl, config.email, item.layoutId);
      await (window as any).electron.layouts.saveFile(item.gameType!, item.version, layoutContent);
      console.log(`[Download] Layout saved: ${item.gameType} v${item.version}`);
      break;

    case 'scenario':
      if (!item.uniqid) {
        console.error('[Download] Cannot download scenario without uniqid');
        throw new Error('Scenario download requires uniqid');
      }
      await downloadScenario(item.uniqid, item.downloadUrl);
      console.log(`[Download] Scenario saved: ${item.name} v${item.version}`);
      await (window as any).electron.scenarios.refresh();
      break;

    default:
      console.warn(`[Download] Unknown item type: ${item.type}`);
  }
}

async function downloadScenario(uniqid: string, downloadUrl: string): Promise<void> {
  console.log(`[downloadScenario] Downloading scenario: ${uniqid}`);
  console.log(`[downloadScenario] URL: ${downloadUrl}`);

  try {
    const response = await fetch(downloadUrl, { credentials: 'include' });

    if (!response.ok) {
      throw new Error(`Failed to download scenario: ${response.statusText}`);
    }

    const gameData = await response.json();
    console.log(`[downloadScenario] Game data received for: ${uniqid}`);

    await (window as any).electron.scenarios.saveGameData(uniqid, gameData);
    console.log(`[downloadScenario] Game data saved`);

    const mediaFiles = extractMediaFiles(gameData);
    console.log(`[downloadScenario] Found ${mediaFiles.length} media files to download`);

    const config = await loadConfig();
    if (!config?.email) {
      throw new Error('No email configured');
    }

    for (const mediaFile of mediaFiles) {
      try {
        console.log(`[downloadScenario] Downloading media: ${mediaFile.folder}/${mediaFile.filename}`);
        const mediaUrl = `https://admin.taghunter.fr/backend/api/playground.php?action=get_media&email=${encodeURIComponent(config.email)}&uniqid=${uniqid}&filename=${encodeURIComponent(mediaFile.filename)}`;

        const mediaResponse = await fetch(mediaUrl, { credentials: 'include' });

        if (!mediaResponse.ok) {
          console.error(`[downloadScenario] Failed to download media: ${mediaFile.filename}`);
          continue;
        }

        const blob = await mediaResponse.blob();
        const arrayBuffer = await blob.arrayBuffer();
        const base64Data = Buffer.from(arrayBuffer).toString('base64');

        await (window as any).electron.scenarios.saveMedia(uniqid, mediaFile.folder, mediaFile.filename, base64Data);
        console.log(`[downloadScenario] Media saved: ${mediaFile.filename}`);
      } catch (error) {
        console.error(`[downloadScenario] Error downloading media file ${mediaFile.filename}:`, error);
      }
    }

    console.log(`[downloadScenario] Scenario download complete: ${uniqid}`);
  } catch (error) {
    console.error(`[downloadScenario] Error downloading scenario:`, error);
    throw error;
  }
}

function extractMediaFiles(gameData: any): Array<{ filename: string; folder: string }> {
  const mediaFiles: Array<{ filename: string; folder: string }> = [];

  if (!gameData.medias) {
    return mediaFiles;
  }

  const processObject = (obj: any, folder: string) => {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      obj.forEach(item => {
        if (typeof item === 'string' && item.trim()) {
          mediaFiles.push({ filename: item, folder });
        } else if (typeof item === 'object') {
          processObject(item, folder);
        }
      });
    } else {
      Object.values(obj).forEach(value => {
        if (typeof value === 'string' && value.trim()) {
          mediaFiles.push({ filename: value, folder });
        } else if (typeof value === 'object' && value !== null) {
          processObject(value, folder);
        }
      });
    }
  };

  if (gameData.medias.images) {
    processObject(gameData.medias.images, 'images');
  }
  if (gameData.medias.sounds) {
    processObject(gameData.medias.sounds, 'sounds');
  }
  if (gameData.medias.videos) {
    processObject(gameData.medias.videos, 'videos');
  }
  if (gameData.medias.levels) {
    processObject(gameData.medias.levels, 'levels');
  }

  // For tagquest game type, also process quests media
  const gameType = gameData?.game?.type || gameData?.scenario?.game_type;
  if (gameType === 'tagquest' && gameData.medias.quests) {
    console.log('[extractMediaFiles] Processing tagquest quests media');

    const questsArray = Array.isArray(gameData.medias.quests)
      ? gameData.medias.quests
      : Object.values(gameData.medias.quests);

    questsArray.forEach((quest: any, index: number) => {
      if (quest && typeof quest === 'object') {
        // Extract image_1, image_2, image_4, and main_image
        ['image_1', 'image_2', 'image_4', 'main_image'].forEach(imageField => {
          if (quest[imageField] && typeof quest[imageField] === 'string' && quest[imageField].trim()) {
            console.log(`[extractMediaFiles] Found quest ${index} ${imageField}: ${quest[imageField]}`);
            mediaFiles.push({ filename: quest[imageField], folder: 'images' });
          }
        });

        // Extract quest sounds
        if (quest.sounds) {
          processObject(quest.sounds, 'sounds');
        }
      }
    });
  }

  return mediaFiles;
}
