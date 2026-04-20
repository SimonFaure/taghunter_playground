const { app, BrowserWindow, ipcMain, protocol, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let connectToDatabase;
let mysqlConnectionModule;

console.log('=== LOADING MYSQL MODULE ===');
console.log('__dirname:', __dirname);
console.log('Module path:', path.join(__dirname, 'src', 'lib', 'mysql-connection.cjs'));

try {
  const modulePath = path.join(__dirname, 'src', 'lib', 'mysql-connection.cjs');
  console.log('Checking if module exists:', fs.existsSync(modulePath));

  mysqlConnectionModule = require(modulePath);
  console.log('Module loaded, exports:', Object.keys(mysqlConnectionModule));

  connectToDatabase = mysqlConnectionModule.connectToDatabase;
  console.log('connectToDatabase type:', typeof connectToDatabase);
  console.log('MySQL connection module loaded successfully');
} catch (error) {
  console.error('Failed to load mysql-connection module:');
  console.error('Error name:', error.name);
  console.error('Error message:', error.message);
  console.error('Error stack:', error.stack);

  connectToDatabase = async () => {
    return { success: false, message: `MySQL connection module failed to load: ${error.message}` };
  };
}

async function createWindow() {
  const fs = require('fs');
  const configDir = path.join(app.getPath('appData'), 'TagHunterPlayground');
  const configFilePath = path.join(configDir, 'config.json');

  let config = { fullscreenOnLaunch: false };

  try {
    if (fs.existsSync(configFilePath)) {
      const data = fs.readFileSync(configFilePath, 'utf-8');
      config = JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading config for window creation:', error);
  }

  const preloadPath = app.isPackaged
    ? path.join(__dirname, '..', 'app.asar.unpacked', 'preload.cjs')
    : path.join(__dirname, 'preload.cjs');

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    fullscreen: config.fullscreenOnLaunch === true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath
    },
    icon: path.join(__dirname, 'build', 'icon.png')
  });

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  protocol.registerFileProtocol('app-file', (request, callback) => {
    const url = request.url.replace('app-file://', '');
    const [gameId, ...pathParts] = url.split('/');
    let filePath = path.join(app.getPath('appData'), 'TagHunterPlayground', 'games', gameId, ...pathParts);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      const files = fs.readdirSync(filePath).filter(f => !f.startsWith('.'));
      if (files.length > 0) {
        filePath = path.join(filePath, files[0]);
      }
    }

    callback({ path: filePath });
  });

  protocol.interceptFileProtocol('file', (request, callback) => {
    const url = request.url.replace('file:///', '');
    const urlPath = decodeURIComponent(url);

    if (urlPath.startsWith('data/games/')) {
      const relativePath = urlPath.replace('data/games/', '');
      const [gameId, ...pathParts] = relativePath.split('/');
      const filePath = path.join(app.getPath('appData'), 'TagHunterPlayground', 'games', gameId, ...pathParts);
      callback({ path: filePath });
    } else if (urlPath.match(/^[A-Z]:/)) {
      callback({ path: urlPath });
    } else {
      callback({ path: path.join(__dirname, 'dist', urlPath) });
    }
  });

  // Set up IPC handlers
  const os = require('os');

  ipcMain.handle('get-computer-name', async () => {
    return os.hostname();
  });

  ipcMain.handle('check-wifi', async () => {
    try {
      const { execSync } = require('child_process');
      let isConnected = false;
      let networkName = null;

      if (process.platform === 'win32') {
        const output = execSync('netsh wlan show interfaces', { encoding: 'utf8' });
        const ssidMatch = output.match(/SSID\s*:\s*(.+)/i);
        if (ssidMatch && ssidMatch[1]) {
          networkName = ssidMatch[1].trim();
          isConnected = networkName.toLowerCase().includes('hunter');
        }
      } else if (process.platform === 'darwin') {
        const output = execSync('/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I', { encoding: 'utf8' });
        const ssidMatch = output.match(/\sSSID:\s*(.+)/);
        if (ssidMatch && ssidMatch[1]) {
          networkName = ssidMatch[1].trim();
          isConnected = networkName.toLowerCase().includes('hunter');
        }
      } else {
        const output = execSync('iwgetid -r', { encoding: 'utf8' });
        networkName = output.trim();
        isConnected = networkName.toLowerCase().includes('hunter');
      }

      return { isConnected, networkName };
    } catch (error) {
      console.error('Error checking WiFi:', error);
      return { isConnected: false, networkName: null };
    }
  });

  let activePort = null;
  let rxBuffer = Buffer.alloc(0);

  ipcMain.handle('serialport:list', async () => {
    try {
      const { SerialPort } = require('serialport');
      const ports = await SerialPort.list();
      return ports;
    } catch (error) {
      console.error('Error listing serial ports:', error);
      return [];
    }
  });

  ipcMain.handle('serialport:open', async (event, portPath, baudRate = 38400) => {
    try {
      if (activePort && activePort.isOpen) {
        activePort.close();
      }

      const { SerialPort } = require('serialport');
      activePort = new SerialPort({
        path: portPath,
        baudRate: baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: true,
      });

      rxBuffer = Buffer.alloc(0);

      return new Promise((resolve, reject) => {
        activePort.on('open', () => {
          console.log('Serial port opened successfully');
          resolve({ success: true });
        });

        activePort.on('error', (err) => {
          console.error('Serial port error:', err.message);
          reject({ success: false, error: err.message });
        });

        activePort.on('data', (chunk) => {
          rxBuffer = Buffer.concat([rxBuffer, chunk]);
        });

        activePort.on('close', () => {
          console.log('Serial port closed');
        });
      });
    } catch (error) {
      console.error('Error opening serial port:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('serialport:write', async (event, data) => {
    try {
      if (!activePort || !activePort.isOpen) {
        return { success: false, error: 'Port not open' };
      }

      const buffer = Buffer.from(data);
      return new Promise((resolve) => {
        activePort.write(buffer, (err) => {
          if (err) {
            resolve({ success: false, error: err.message });
          } else {
            resolve({ success: true });
          }
        });
      });
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('serialport:read', async (event, length) => {
    try {
      if (length <= rxBuffer.length) {
        const data = rxBuffer.slice(0, length);
        rxBuffer = rxBuffer.slice(length);
        return { success: true, data: Array.from(data) };
      }
      return { success: false, data: [] };
    } catch (error) {
      return { success: false, error: error.message, data: [] };
    }
  });

  ipcMain.handle('serialport:peek', async (event, length) => {
    try {
      const data = rxBuffer.slice(0, Math.min(length, rxBuffer.length));
      return { success: true, data: Array.from(data), length: data.length };
    } catch (error) {
      return { success: false, error: error.message, data: [], length: 0 };
    }
  });

  ipcMain.handle('serialport:is-open', async () => {
    return { isOpen: activePort && activePort.isOpen };
  });

  ipcMain.handle('serialport:close', async () => {
    try {
      if (activePort && activePort.isOpen) {
        return new Promise((resolve) => {
          activePort.close(() => {
            activePort = null;
            rxBuffer = Buffer.alloc(0);
            resolve({ success: true });
          });
        });
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('clients:load', async () => {
    const fs = require('fs');
    const configDir = path.join(app.getPath('appData'), 'TagHunterPlayground');
    const clientsPath = path.join(configDir, 'clients.json');

    try {
      if (fs.existsSync(clientsPath)) {
        const data = fs.readFileSync(clientsPath, 'utf8');
        return { success: true, clients: JSON.parse(data) };
      }
      return { success: false, clients: [] };
    } catch (error) {
      console.error('Error loading clients:', error);
      return { success: false, clients: [] };
    }
  });

  ipcMain.handle('clients:save-selected', async (event, clientData) => {
    const fs = require('fs');
    const configDir = path.join(app.getPath('appData'), 'TagHunterPlayground');
    const selectedClientPath = path.join(configDir, 'selected-client.json');

    try {
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      fs.writeFileSync(selectedClientPath, JSON.stringify(clientData, null, 2));
      return { success: true };
    } catch (error) {
      console.error('Error saving selected client:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('clients:load-selected', async () => {
    const fs = require('fs');
    const configDir = path.join(app.getPath('appData'), 'TagHunterPlayground');
    const selectedClientPath = path.join(configDir, 'selected-client.json');

    try {
      if (fs.existsSync(selectedClientPath)) {
        const data = fs.readFileSync(selectedClientPath, 'utf8');
        return { success: true, client: JSON.parse(data) };
      }
      return { success: false, client: null };
    } catch (error) {
      console.error('Error loading selected client:', error);
      return { success: false, client: null };
    }
  });

  ipcMain.handle('config:get-path', async () => {
    const fs = require('fs');
    const configDir = path.join(app.getPath('appData'), 'TagHunterPlayground');
    const configPath = path.join(configDir, 'config.json');

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify({ usbPort: '', language: 'english', fullscreenOnLaunch: false, autoLaunch: false, onboardingCompleted: false }, null, 2));
    }

    return configPath;
  });

  ipcMain.handle('config:load', async () => {
    const fs = require('fs');
    try {
      const configDir = path.join(app.getPath('appData'), 'TagHunterPlayground');
      const configFilePath = path.join(configDir, 'config.json');

      console.log('[Electron] Loading config from:', configFilePath);

      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      if (!fs.existsSync(configFilePath)) {
        console.log('[Electron] Config file does not exist');
        return null;
      }

      const data = fs.readFileSync(configFilePath, 'utf-8');
      const config = JSON.parse(data);
      console.log('[Electron] Config loaded:', config);
      return config;
    } catch (error) {
      console.error('[Electron] Error loading config:', error);
      return null;
    }
  });

  ipcMain.handle('config:save', async (event, config) => {
    const fs = require('fs');
    try {
      const configDir = path.join(app.getPath('appData'), 'TagHunterPlayground');
      const configPath = path.join(configDir, 'config.json');

      console.log('[Electron] Saving config to:', configPath);
      console.log('[Electron] Config data:', config);

      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('[Electron] Config saved successfully');

      const savedData = fs.readFileSync(configPath, 'utf-8');
      console.log('[Electron] Verification - file contents:', savedData);

      return { success: true };
    } catch (error) {
      console.error('[Electron] Error saving config:', error);
      throw error;
    }
  });

  ipcMain.handle('games:get-folder-path', async () => {
    const fs = require('fs');
    const gamesDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'games');

    if (!fs.existsSync(gamesDir)) {
      fs.mkdirSync(gamesDir, { recursive: true });
    }

    return gamesDir;
  });

  ipcMain.handle('games:list', async () => {
    const fs = require('fs');
    try {
      const allGameIds = new Set();

      const gamesDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'games');
      if (fs.existsSync(gamesDir)) {
        const gameFolders = fs.readdirSync(gamesDir, { withFileTypes: true })
          .filter(dirent => dirent.isDirectory())
          .map(dirent => dirent.name);
        gameFolders.forEach(id => allGameIds.add(id));
      }

      const scenariosDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'scenarios');
      if (fs.existsSync(scenariosDir)) {
        const scenarioFolders = fs.readdirSync(scenariosDir, { withFileTypes: true })
          .filter(dirent => dirent.isDirectory())
          .map(dirent => dirent.name);
        scenarioFolders.forEach(id => allGameIds.add(id));
      }

      return Array.from(allGameIds);
    } catch (error) {
      console.error('Error listing games:', error);
      return [];
    }
  });

  ipcMain.handle('games:read-file', async (event, gameId, filename) => {
    const fs = require('fs');
    try {
      const scenariosDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'scenarios');
      const scenarioPath = path.join(scenariosDir, gameId, filename);

      if (fs.existsSync(scenarioPath)) {
        const data = fs.readFileSync(scenarioPath, 'utf-8');
        return data;
      }

      const gamesDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'games');
      const gamePath = path.join(gamesDir, gameId, filename);

      if (fs.existsSync(gamePath)) {
        const data = fs.readFileSync(gamePath, 'utf-8');
        return data;
      }

      throw new Error(`File not found: ${filename} in game/scenario: ${gameId}`);
    } catch (error) {
      console.error('Error reading game file:', error);
      throw error;
    }
  });

  ipcMain.handle('games:write-file', async (event, gameId, filename, content, isBinary = false) => {
    try {
      const gamesDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'games');
      const gameDir = path.join(gamesDir, gameId);

      if (!fs.existsSync(gameDir)) {
        fs.mkdirSync(gameDir, { recursive: true });
      }

      const filePath = path.join(gameDir, filename);
      const fileDir = path.dirname(filePath);

      if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true });
      }

      if (isBinary) {
        const buffer = Buffer.from(content, 'base64');
        fs.writeFileSync(filePath, buffer);
      } else {
        fs.writeFileSync(filePath, content);
      }

      return { success: true };
    } catch (error) {
      console.error('Error writing game file:', error);
      throw error;
    }
  });

  ipcMain.handle('games:get-media-path', async (event, gameId, filename) => {
    const fs = require('fs');
    const scenariosDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'scenarios');
    const scenarioPath = path.join(scenariosDir, gameId, 'media', filename);

    if (fs.existsSync(scenarioPath)) {
      return scenarioPath;
    }

    const gamesDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'games');
    const gamePath = path.join(gamesDir, gameId, 'media', filename);
    return gamePath;
  });

  ipcMain.handle('games:list-media-folder', async (event, gameId, folderId) => {
    const fs = require('fs');
    try {
      const scenariosDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'scenarios');
      const scenarioFolderPath = path.join(scenariosDir, gameId, 'media', folderId);

      if (fs.existsSync(scenarioFolderPath)) {
        const files = fs.readdirSync(scenarioFolderPath);
        return files.filter(file => !file.startsWith('.'));
      }

      const gamesDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'games');
      const gameFolderPath = path.join(gamesDir, gameId, 'media', folderId);

      if (fs.existsSync(gameFolderPath)) {
        const files = fs.readdirSync(gameFolderPath);
        return files.filter(file => !file.startsWith('.'));
      }

      return [];
    } catch (error) {
      console.error(`Error listing media folder ${folderId}:`, error);
      return [];
    }
  });

  ipcMain.handle('patterns:list-folders', async (event, gameTypeName) => {
    const fs = require('fs');
    try {
      const patternsDir = path.join(__dirname, 'data', 'patterns', gameTypeName.toLowerCase());

      if (!fs.existsSync(patternsDir)) {
        console.log('Patterns directory does not exist:', patternsDir);
        return ['ado_adultes', 'kids', 'mini_kids'];
      }

      const folders = fs.readdirSync(patternsDir, { withFileTypes: true });
      const patternFolders = folders
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      console.log('Pattern folders found:', patternFolders);
      return patternFolders;
    } catch (error) {
      console.error('Error reading pattern folders:', error);
      return ['ado_adultes', 'kids', 'mini_kids'];
    }
  });

  ipcMain.handle('patterns:read-file', async (event, gameTypeName, patternName, fileName) => {
    const fs = require('fs');
    try {
      const filePath = path.join(__dirname, 'data', 'patterns', gameTypeName.toLowerCase(), patternName, fileName);
      console.log('Reading pattern file:', filePath);

      if (!fs.existsSync(filePath)) {
        throw new Error(`Pattern file not found: ${filePath}`);
      }

      const content = fs.readFileSync(filePath, 'utf8');
      return content;
    } catch (error) {
      console.error('Error reading pattern file:', error);
      throw error;
    }
  });

  ipcMain.handle('scenarios:get-folder-path', async () => {
    const fs = require('fs');
    const scenariosDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'scenarios');

    if (!fs.existsSync(scenariosDir)) {
      fs.mkdirSync(scenariosDir, { recursive: true });
    }

    return scenariosDir;
  });

  ipcMain.handle('scenarios:load', async () => {
    const fs = require('fs');
    try {
      const scenariosDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'scenarios');
      const scenariosPath = path.join(scenariosDir, 'scenarios.json');

      if (!fs.existsSync(scenariosDir)) {
        fs.mkdirSync(scenariosDir, { recursive: true });
      }

      if (!fs.existsSync(scenariosPath)) {
        const defaultScenarios = { game_types: [], scenarios: [] };
        fs.writeFileSync(scenariosPath, JSON.stringify(defaultScenarios, null, 2));
        return defaultScenarios;
      }

      const data = fs.readFileSync(scenariosPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Error loading scenarios:', error);
      return { game_types: [], scenarios: [] };
    }
  });

  ipcMain.handle('scenarios:save-game-data', async (event, uniqid, gameData) => {
    const fs = require('fs');
    try {
      console.log(`[Electron] Saving game data for scenario: ${uniqid}`);
      const scenariosDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'scenarios', uniqid);
      console.log(`[Electron] Target directory: ${scenariosDir}`);

      if (!fs.existsSync(scenariosDir)) {
        console.log(`[Electron] Creating directory: ${scenariosDir}`);
        fs.mkdirSync(scenariosDir, { recursive: true });
      }

      const gameDataPath = path.join(scenariosDir, 'game-data.json');
      console.log(`[Electron] Game data path: ${gameDataPath}`);

      console.log(`[Electron] Stringifying game data with circular reference protection...`);
      const seen = new WeakSet();
      const safeGameData = JSON.stringify(gameData, (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) {
            console.log(`[Electron] Found circular reference at key: ${key}`);
            return '[Circular Reference]';
          }
          seen.add(value);
        }
        return value;
      }, 2);

      console.log(`[Electron] Game data stringified, length: ${safeGameData.length} characters`);
      console.log(`[Electron] Writing to file...`);
      fs.writeFileSync(gameDataPath, safeGameData);
      console.log(`[Electron] Game data saved successfully`);

      return { success: true };
    } catch (error) {
      console.error('[Electron] Error saving game data:', error);
      console.error('[Electron] Error stack:', error.stack);
      throw error;
    }
  });

  ipcMain.handle('scenarios:save-csv', async (event, uniqid, filename, content) => {
    const fs = require('fs');
    try {
      console.log(`[Electron] Saving CSV file: ${filename} for scenario: ${uniqid}`);
      const scenariosDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'scenarios', uniqid);
      const csvDir = path.join(scenariosDir, 'csv');
      console.log(`[Electron] CSV directory: ${csvDir}`);

      if (!fs.existsSync(csvDir)) {
        console.log(`[Electron] Creating CSV directory: ${csvDir}`);
        fs.mkdirSync(csvDir, { recursive: true });
      }

      const filePath = path.join(csvDir, filename);
      console.log(`[Electron] Writing CSV file: ${filePath}`);
      fs.writeFileSync(filePath, content);
      console.log(`[Electron] CSV file saved successfully: ${filename}`);

      return { success: true };
    } catch (error) {
      console.error(`[Electron] Error saving CSV file ${filename}:`, error);
      console.error('[Electron] Error stack:', error.stack);
      throw error;
    }
  });

  ipcMain.handle('scenarios:save-media', async (event, uniqid, folder, filename, base64Data) => {
    const fs = require('fs');
    try {
      console.log(`[Electron] Saving media file: ${folder}/${filename} for scenario: ${uniqid}`);
      const scenariosDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'scenarios', uniqid);
      const mediaDir = path.join(scenariosDir, 'media', folder);
      console.log(`[Electron] Media directory: ${mediaDir}`);

      if (!fs.existsSync(mediaDir)) {
        console.log(`[Electron] Creating media directory: ${mediaDir}`);
        fs.mkdirSync(mediaDir, { recursive: true });
      }

      const filePath = path.join(mediaDir, filename);
      console.log(`[Electron] Converting base64 to buffer (${base64Data.length} characters)...`);
      const buffer = Buffer.from(base64Data, 'base64');
      console.log(`[Electron] Buffer size: ${buffer.length} bytes`);
      console.log(`[Electron] Writing file: ${filePath}`);
      fs.writeFileSync(filePath, buffer);
      console.log(`[Electron] Media file saved successfully: ${filename}`);

      return { success: true };
    } catch (error) {
      console.error(`[Electron] Error saving media file ${filename}:`, error);
      console.error('[Electron] Error stack:', error.stack);
      throw error;
    }
  });

  ipcMain.handle('scenarios:refresh', async () => {
    const fs = require('fs');
    try {
      const scenariosDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'scenarios');
      const scenariosPath = path.join(scenariosDir, 'scenarios.json');

      if (!fs.existsSync(scenariosDir)) {
        fs.mkdirSync(scenariosDir, { recursive: true });
      }

      if (!fs.existsSync(scenariosPath)) {
        const defaultScenarios = { game_types: [], scenarios: [] };
        fs.writeFileSync(scenariosPath, JSON.stringify(defaultScenarios, null, 2));
        return defaultScenarios;
      }

      const folders = fs.readdirSync(scenariosDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      const scenarios = [];
      const gameTypesSet = new Set();

      for (const folder of folders) {
        const gameDataPath = path.join(scenariosDir, folder, 'game-data.json');
        if (fs.existsSync(gameDataPath)) {
          const gameDataContent = fs.readFileSync(gameDataPath, 'utf8');
          const gameData = JSON.parse(gameDataContent);

          const scenario = gameData.scenario || {};
          const gameMeta = gameData.game_data?.game_meta || {};

          let imageUrl = '';
          if (gameData.medias?.images?.game_visual) {
            imageUrl = `app-file://${folder}/media/images/${gameData.medias.images.game_visual}`;
          }

          scenarios.push({
            id: scenario.id || folder,
            title: gameMeta.title || scenario.name || 'Untitled',
            description: gameMeta.scenario || '',
            game_type_id: scenario.scenario_type || 'unknown',
            difficulty: gameMeta.game_public === 'kids' ? 'Easy' : gameMeta.game_public === 'ado_adultes' ? 'Hard' : 'Medium',
            duration_minutes: parseInt(gameMeta.default_time || '60', 10),
            image_url: imageUrl,
            uniqid: folder,
            version: scenario.version || '1.0'
          });

          gameTypesSet.add(scenario.scenario_type || 'unknown');
        }
      }

      const gameTypes = Array.from(gameTypesSet).map(type => ({
        id: type,
        name: type
      }));

      const updatedData = { game_types: gameTypes, scenarios };
      fs.writeFileSync(scenariosPath, JSON.stringify(updatedData, null, 2));

      return updatedData;
    } catch (error) {
      console.error('Error refreshing scenarios:', error);
      return { game_types: [], scenarios: [] };
    }
  });

  ipcMain.handle('scenarios:get-local-versions', async () => {
    const fs = require('fs');
    try {
      const scenariosDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'scenarios');

      if (!fs.existsSync(scenariosDir)) {
        return {};
      }

      const folders = fs.readdirSync(scenariosDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      const versions = {};

      for (const folder of folders) {
        const gameDataPath = path.join(scenariosDir, folder, 'game-data.json');
        if (fs.existsSync(gameDataPath)) {
          const gameDataContent = fs.readFileSync(gameDataPath, 'utf8');
          const gameData = JSON.parse(gameDataContent);
          const scenario = gameData.scenario || {};

          versions[folder] = scenario.version || '1.0';
        }
      }

      console.log('[Electron] Local scenario versions:', versions);
      return versions;
    } catch (error) {
      console.error('[Electron] Error getting local scenario versions:', error);
      return {};
    }
  });

  ipcMain.handle('scenarios:get-image', async (event, uniqid) => {
    const fs = require('fs');
    try {
      const scenariosDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'scenarios');
      const gameDataPath = path.join(scenariosDir, uniqid, 'game-data.json');

      if (!fs.existsSync(gameDataPath)) {
        return { success: false, error: 'Game data not found' };
      }

      const gameDataContent = fs.readFileSync(gameDataPath, 'utf8');
      const gameData = JSON.parse(gameDataContent);

      if (!gameData.medias?.images?.game_visual) {
        return { success: false, error: 'No visual image found' };
      }

      const imagePath = path.join(scenariosDir, uniqid, 'media', 'images', gameData.medias.images.game_visual);

      if (!fs.existsSync(imagePath)) {
        return { success: false, error: 'Image file not found' };
      }

      const imageBuffer = fs.readFileSync(imagePath);
      const base64Image = imageBuffer.toString('base64');
      const ext = path.extname(gameData.medias.images.game_visual).toLowerCase();
      let mimeType = 'image/jpeg';

      if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.gif') mimeType = 'image/gif';
      else if (ext === '.webp') mimeType = 'image/webp';

      return {
        success: true,
        data: `data:${mimeType};base64,${base64Image}`
      };
    } catch (error) {
      console.error('Error getting scenario image:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('scenarios:delete', async (event, uniqid) => {
    const fs = require('fs');
    try {
      const scenariosDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'scenarios');
      const scenarioPath = path.join(scenariosDir, uniqid);

      if (fs.existsSync(scenarioPath)) {
        fs.rmSync(scenarioPath, { recursive: true, force: true });
        console.log(`Deleted scenario: ${uniqid}`);
      }

      const scenariosPath = path.join(scenariosDir, 'scenarios.json');
      if (fs.existsSync(scenariosPath)) {
        const data = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
        data.scenarios = data.scenarios.filter(s => s.uniqid !== uniqid);
        fs.writeFileSync(scenariosPath, JSON.stringify(data, null, 2));
      }

      return { success: true };
    } catch (error) {
      console.error('Error deleting scenario:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('db:connect', async () => {
    try {
      if (!connectToDatabase) {
        return { success: false, message: 'Database module not loaded' };
      }
      const result = await connectToDatabase();
      console.log('Database connection result:', result);
      return result;
    } catch (error) {
      console.error('Database connection error:', error);
      return { success: false, message: error.message };
    }
  });

  ipcMain.handle('db:testConnection', async (event, url) => {
    console.log('=== DB TEST CONNECTION ===');
    console.log('Received URL:', url);
    console.log('URL type:', typeof url);

    try {
      const mysql = require('mysql2/promise');
      const testConfig = {
        host: url,
        port: 3306,
        user: 'bob',
        password: 'WebMaster62',
        database: 'taghunter_playground',
        connectTimeout: 5000
      };

      console.log('Testing database connection with config:', JSON.stringify(testConfig, null, 2));

      const connection = await mysql.createConnection(testConfig);
      console.log('Connection created successfully');

      await connection.ping();
      console.log('Ping successful');

      const [tables] = await connection.query('SHOW TABLES');
      console.log('=== DATABASE TABLES ===');
      console.log('Number of tables:', tables.length);
      console.log('Tables:');
      tables.forEach((table, index) => {
        const tableName = Object.values(table)[0];
        console.log(`  ${index + 1}. ${tableName}`);
      });
      console.log('======================');

      await connection.end();

      const successMessage = `Successfully connected to database at ${url}`;
      console.log('Success:', successMessage);
      return { success: true, message: successMessage };
    } catch (error) {
      console.error('Database test connection error:', error);
      console.error('Error details:', {
        message: error.message,
        code: error.code,
        errno: error.errno,
        sqlState: error.sqlState
      });
      return { success: false, message: `Failed to connect: ${error.message}` };
    }
  });

  ipcMain.handle('db:query', async (event, sql, params = []) => {
    console.log('=== DB QUERY ===');
    console.log('SQL:', sql);
    console.log('Params:', params);

    try {
      const conn = await mysqlConnectionModule.getConnection();
      const [result] = await conn.query(sql, params);
      console.log('Query result:', result);

      return { rows: result, error: null };
    } catch (error) {
      console.error('Database query error:', error);
      return { rows: null, error: error.message };
    }
  });

  ipcMain.handle('api-logs:write', async (event, logData) => {
    const fs = require('fs');
    try {
      const logsDir = path.join(app.getPath('appData'), 'TagHunterPlayground');
      const logsPath = path.join(logsDir, 'api-logs.json');

      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      let logs = [];
      if (fs.existsSync(logsPath)) {
        const content = fs.readFileSync(logsPath, 'utf8');
        try {
          logs = JSON.parse(content);
        } catch {
          logs = [];
        }
      }

      logs.push({
        ...logData,
        timestamp: new Date().toISOString()
      });

      const maxLogs = 1000;
      if (logs.length > maxLogs) {
        logs = logs.slice(-maxLogs);
      }

      const seen = new WeakSet();
      const safeLogs = JSON.stringify(logs, (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) {
            return '[Circular Reference]';
          }
          seen.add(value);
        }
        return value;
      }, 2);

      fs.writeFileSync(logsPath, safeLogs);
      return { success: true };
    } catch (error) {
      console.error('Error writing API log:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('api-logs:read', async () => {
    const fs = require('fs');
    try {
      const logsDir = path.join(app.getPath('appData'), 'TagHunterPlayground');
      const logsPath = path.join(logsDir, 'api-logs.json');

      if (!fs.existsSync(logsPath)) {
        return { success: true, logs: [] };
      }

      const content = fs.readFileSync(logsPath, 'utf8');
      const logs = JSON.parse(content);
      return { success: true, logs };
    } catch (error) {
      console.error('Error reading API logs:', error);
      return { success: false, logs: [], error: error.message };
    }
  });

  ipcMain.handle('api-logs:clear', async () => {
    const fs = require('fs');
    try {
      const logsDir = path.join(app.getPath('appData'), 'TagHunterPlayground');
      const logsPath = path.join(logsDir, 'api-logs.json');

      if (fs.existsSync(logsPath)) {
        fs.unlinkSync(logsPath);
      }
      return { success: true };
    } catch (error) {
      console.error('Error clearing API logs:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('system:open-data-folder', async () => {
    try {
      const dataDir = path.join(app.getPath('appData'), 'TagHunterPlayground');

      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      await shell.openPath(dataDir);
      return { success: true };
    } catch (error) {
      console.error('Error opening data folder:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('system:set-auto-launch', async (event, enable) => {
    try {
      app.setLoginItemSettings({
        openAtLogin: enable,
        openAsHidden: false,
      });
      return { success: true };
    } catch (error) {
      console.error('Error setting auto-launch:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('system:get-auto-launch', async () => {
    try {
      const settings = app.getLoginItemSettings();
      return { success: true, enabled: settings.openAtLogin };
    } catch (error) {
      console.error('Error getting auto-launch status:', error);
      return { success: false, enabled: false, error: error.message };
    }
  });

  ipcMain.handle('scenarios:get-folder-structure', async () => {
    const fs = require('fs');
    try {
      const dataDir = path.join(app.getPath('appData'), 'TagHunterPlayground');

      const buildTree = (dirPath, name) => {
        const stats = fs.statSync(dirPath);

        if (stats.isFile()) {
          return {
            name,
            path: dirPath,
            type: 'file',
            size: stats.size
          };
        }

        if (stats.isDirectory()) {
          const children = [];
          try {
            const files = fs.readdirSync(dirPath);
            for (const file of files) {
              const filePath = path.join(dirPath, file);
              try {
                children.push(buildTree(filePath, file));
              } catch (err) {
                console.error(`Error reading ${filePath}:`, err);
              }
            }
          } catch (err) {
            console.error(`Error reading directory ${dirPath}:`, err);
          }

          return {
            name,
            path: dirPath,
            type: 'folder',
            children,
            expanded: name === 'TagHunterPlayground'
          };
        }
      };

      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const tree = buildTree(dataDir, 'TagHunterPlayground');
      return tree;
    } catch (error) {
      console.error('Error getting folder structure:', error);
      return null;
    }
  });

  ipcMain.handle('scenarios:get-storage-info', async () => {
    const fs = require('fs');
    try {
      const dataDir = path.join(app.getPath('appData'), 'TagHunterPlayground');

      const getDirectorySize = (dirPath) => {
        let totalSize = 0;

        try {
          const files = fs.readdirSync(dirPath);
          for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = fs.statSync(filePath);

            if (stats.isFile()) {
              totalSize += stats.size;
            } else if (stats.isDirectory()) {
              totalSize += getDirectorySize(filePath);
            }
          }
        } catch (err) {
          console.error(`Error calculating size for ${dirPath}:`, err);
        }

        return totalSize;
      };

      if (!fs.existsSync(dataDir)) {
        return { used: 0, total: 1024 * 1024 * 1024 };
      }

      const used = getDirectorySize(dataDir);
      const total = 1024 * 1024 * 1024;

      return { used, total };
    } catch (error) {
      console.error('Error getting storage info:', error);
      return { used: 0, total: 1024 * 1024 * 1024 };
    }
  });

  ipcMain.handle('scenarios:delete-path', async (event, itemPath) => {
    const fs = require('fs');
    try {
      const dataDir = path.join(app.getPath('appData'), 'TagHunterPlayground');

      const fullPath = itemPath.startsWith(dataDir) ? itemPath : path.join(dataDir, itemPath);

      if (!fullPath.startsWith(dataDir)) {
        throw new Error('Invalid path: must be within data directory');
      }

      if (!fs.existsSync(fullPath)) {
        return { success: false, error: 'Path does not exist' };
      }

      const stats = fs.statSync(fullPath);

      if (stats.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(fullPath);
      }

      return { success: true };
    } catch (error) {
      console.error('Error deleting path:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('cards:get-local-version', async () => {
    const fs = require('fs');
    try {
      const cardsDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'cards', 'clients_cards');

      if (!fs.existsSync(cardsDir)) {
        fs.mkdirSync(cardsDir, { recursive: true });
        return { success: true, version: 0 };
      }

      const files = fs.readdirSync(cardsDir).filter(f => f.endsWith('.csv'));
      let highestVersion = 0;

      for (const file of files) {
        const match = file.match(/_v?(\d+)\.csv$/);
        if (match) {
          const version = parseInt(match[1], 10);
          if (version > highestVersion) {
            highestVersion = version;
          }
        }
      }

      return { success: true, version: highestVersion };
    } catch (error) {
      console.error('Error getting local cards version:', error);
      return { success: false, version: 0, error: error.message };
    }
  });

  ipcMain.handle('cards:save-file', async (event, version, content) => {
    const fs = require('fs');
    try {
      const cardsDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'cards', 'clients_cards');

      if (!fs.existsSync(cardsDir)) {
        fs.mkdirSync(cardsDir, { recursive: true });
      }

      const filename = `cards_v${version}.csv`;
      const filePath = path.join(cardsDir, filename);
      fs.writeFileSync(filePath, content);

      const files = fs.readdirSync(cardsDir).filter(f => f.endsWith('.csv'));
      const filesWithVersions = files.map(f => {
        const match = f.match(/_v?(\d+)\.csv$/);
        return { filename: f, version: match ? parseInt(match[1], 10) : 0 };
      }).sort((a, b) => b.version - a.version);

      if (filesWithVersions.length > 2) {
        for (let i = 2; i < filesWithVersions.length; i++) {
          const oldFile = path.join(cardsDir, filesWithVersions[i].filename);
          fs.unlinkSync(oldFile);
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Error saving cards file:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('cards:save-on-demand-file', async (event, content) => {
    const fs = require('fs');
    try {
      const cardsDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'cards', 'clients_cards');

      if (!fs.existsSync(cardsDir)) {
        fs.mkdirSync(cardsDir, { recursive: true });
      }

      const filePath = path.join(cardsDir, 'on_demand_cards.csv');
      fs.writeFileSync(filePath, content);

      return { success: true };
    } catch (error) {
      console.error('Error saving on-demand cards file:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('patterns:get-local-versions', async (event, gameType, patternSlug) => {
    const fs = require('fs');
    try {
      const defaultPatternsDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'patterns', gameType, 'default_patterns');
      const userPatternsDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'patterns', gameType, 'user_patterns');

      let highestVersion = 0;

      for (const dir of [defaultPatternsDir, userPatternsDir]) {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            if (file.startsWith(patternSlug + '_')) {
              const match = file.match(/_v?(\d+)$/);
              if (match) {
                const version = parseInt(match[1], 10);
                if (version > highestVersion) {
                  highestVersion = version;
                }
              }
            }
          }
        }
      }

      return { success: true, version: highestVersion };
    } catch (error) {
      console.error('Error getting local pattern versions:', error);
      return { success: false, version: 0, error: error.message };
    }
  });

  ipcMain.handle('patterns:save-file', async (event, gameType, patternSlug, version, content, isUserPattern) => {
    const fs = require('fs');
    try {
      const baseDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'patterns', gameType);
      const patternsDir = isUserPattern
        ? path.join(baseDir, 'user_patterns')
        : path.join(baseDir, 'default_patterns');

      if (!fs.existsSync(patternsDir)) {
        fs.mkdirSync(patternsDir, { recursive: true });
      }

      const patternDir = path.join(patternsDir, `${patternSlug}_${version}`);
      if (!fs.existsSync(patternDir)) {
        fs.mkdirSync(patternDir, { recursive: true });
      }

      const filePath = path.join(patternDir, 'pattern.csv');
      fs.writeFileSync(filePath, content);

      const allPatternDirs = fs.readdirSync(patternsDir).filter(d => {
        return d.startsWith(patternSlug + '_') && fs.statSync(path.join(patternsDir, d)).isDirectory();
      });

      const dirsWithVersions = allPatternDirs.map(d => {
        const match = d.match(/_v?(\d+)$/);
        return { dirname: d, version: match ? parseInt(match[1], 10) : 0 };
      }).sort((a, b) => b.version - a.version);

      if (dirsWithVersions.length > 2) {
        for (let i = 2; i < dirsWithVersions.length; i++) {
          const oldDir = path.join(patternsDir, dirsWithVersions[i].dirname);
          fs.rmSync(oldDir, { recursive: true, force: true });
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Error saving pattern file:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('layouts:get-local-versions', async (event, gameType) => {
    const fs = require('fs');
    try {
      const layoutsDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'layouts', 'default_layouts');

      if (!fs.existsSync(layoutsDir)) {
        return { success: true, version: 0 };
      }

      const files = fs.readdirSync(layoutsDir);
      let highestVersion = 0;

      for (const file of files) {
        if (file.startsWith(gameType + '_')) {
          const match = file.match(/_v?(\d+)$/);
          if (match) {
            const version = parseInt(match[1], 10);
            if (version > highestVersion) {
              highestVersion = version;
            }
          }
        }
      }

      return { success: true, version: highestVersion };
    } catch (error) {
      console.error('Error getting local layout versions:', error);
      return { success: false, version: 0, error: error.message };
    }
  });

  ipcMain.handle('layouts:read-file', async (event, gameType) => {
    const fs = require('fs');
    try {
      const layoutsDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'layouts', 'default_layouts');

      if (!fs.existsSync(layoutsDir)) {
        return { success: false, error: 'Layouts directory not found' };
      }

      const allEntries = fs.readdirSync(layoutsDir);

      const layoutFiles = allEntries.filter(f => {
        const fullPath = path.join(layoutsDir, f);
        return (f.startsWith(gameType + '_') || f.startsWith(gameType + '_layout')) &&
               f.endsWith('.json') &&
               fs.statSync(fullPath).isFile();
      });

      if (layoutFiles.length > 0) {
        const filesWithVersions = layoutFiles.map(f => {
          const versionMatch = f.match(/_v?(\d+)\.json$/);
          const version = versionMatch ? parseInt(versionMatch[1], 10) : 0;
          const mtime = fs.statSync(path.join(layoutsDir, f)).mtime.getTime();
          return { filename: f, version, mtime };
        }).sort((a, b) => {
          if (a.version !== b.version) return b.version - a.version;
          return b.mtime - a.mtime;
        });

        const layoutFilePath = path.join(layoutsDir, filesWithVersions[0].filename);
        const content = fs.readFileSync(layoutFilePath, 'utf8');
        const versionStr = filesWithVersions[0].version > 0 ? filesWithVersions[0].version.toString() : '1.0';
        return { success: true, content, version: versionStr };
      }

      const layoutDirs = allEntries.filter(d => {
        return d.startsWith(gameType + '_') && fs.statSync(path.join(layoutsDir, d)).isDirectory();
      });

      if (layoutDirs.length === 0) {
        return { success: false, error: `No layout found for game type: ${gameType}` };
      }

      const dirsWithVersions = layoutDirs.map(d => {
        const match = d.match(/_v?(\d+)$/);
        return { dirname: d, version: match ? parseInt(match[1], 10) : 0 };
      }).sort((a, b) => b.version - a.version);

      const latestLayoutDir = path.join(layoutsDir, dirsWithVersions[0].dirname);
      const layoutFilePath = path.join(latestLayoutDir, 'layout.json');

      if (!fs.existsSync(layoutFilePath)) {
        return { success: false, error: 'Layout file not found' };
      }

      const content = fs.readFileSync(layoutFilePath, 'utf8');
      return { success: true, content, version: dirsWithVersions[0].version.toString() };
    } catch (error) {
      console.error('Error reading layout file:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('layouts:save-file', async (event, gameType, version, content) => {
    const fs = require('fs');
    try {
      const layoutsDir = path.join(app.getPath('appData'), 'TagHunterPlayground', 'layouts', 'default_layouts');

      if (!fs.existsSync(layoutsDir)) {
        fs.mkdirSync(layoutsDir, { recursive: true });
      }

      const layoutDir = path.join(layoutsDir, `${gameType}_${version}`);
      if (!fs.existsSync(layoutDir)) {
        fs.mkdirSync(layoutDir, { recursive: true });
      }

      const filePath = path.join(layoutDir, 'layout.json');
      fs.writeFileSync(filePath, content);

      const allLayoutDirs = fs.readdirSync(layoutsDir).filter(d => {
        return d.startsWith(gameType + '_') && fs.statSync(path.join(layoutsDir, d)).isDirectory();
      });

      const dirsWithVersions = allLayoutDirs.map(d => {
        const match = d.match(/_v?(\d+)$/);
        return { dirname: d, version: match ? parseInt(match[1], 10) : 0 };
      }).sort((a, b) => b.version - a.version);

      if (dirsWithVersions.length > 2) {
        for (let i = 2; i < dirsWithVersions.length; i++) {
          const oldDir = path.join(layoutsDir, dirsWithVersions[i].dirname);
          fs.rmSync(oldDir, { recursive: true, force: true });
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Error saving layout file:', error);
      return { success: false, error: error.message };
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
