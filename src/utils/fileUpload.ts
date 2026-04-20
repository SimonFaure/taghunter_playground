import JSZip from 'jszip';
import { supabase } from '../lib/db';

export type FileType = 'game' | 'pattern' | 'cards' | 'layout' | 'unknown';

export interface UploadResult {
  type: FileType;
  name: string;
  data: any;
  isValid: boolean;
  error?: string;
}

export async function detectFileType(file: File): Promise<UploadResult> {
  const fileName = file.name.toLowerCase();
  const fileExtension = fileName.split('.').pop();

  if (fileExtension === 'zip') {
    return await handleZipFile(file);
  } else if (fileExtension === 'json') {
    return await handleJsonFile(file);
  } else if (fileExtension === 'csv') {
    return await handleCsvFile(file, fileName);
  } else {
    return {
      type: 'unknown',
      name: file.name,
      data: null,
      isValid: false,
      error: 'Unsupported file type. Please upload a ZIP, JSON, or CSV file.'
    };
  }
}

async function handleZipFile(file: File): Promise<UploadResult> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    const allFiles = zip.file(/.+/);

    let gameDataEntry = allFiles.find(e => !e.dir && e.name === 'game-data.json');
    if (!gameDataEntry) {
      gameDataEntry = allFiles.find(e => !e.dir && e.name.endsWith('/game-data.json'));
    }

    if (!gameDataEntry) {
      return {
        type: 'unknown',
        name: file.name,
        data: null,
        isValid: false,
        error: 'Invalid ZIP structure. game-data.json not found.'
      };
    }

    const prefix = gameDataEntry.name === 'game-data.json'
      ? ''
      : gameDataEntry.name.slice(0, gameDataEntry.name.lastIndexOf('/') + 1);

    const gameDataContent = await gameDataEntry.async('string');
    const gameData = JSON.parse(gameDataContent);
    const uniqid = gameData?.game?.uniqid || gameData?.scenario?.uniqid;

    if (!uniqid) {
      return {
        type: 'unknown',
        name: file.name,
        data: null,
        isValid: false,
        error: 'Invalid game structure: uniqid not found in game-data.json'
      };
    }

    const zipEntries: Record<string, Uint8Array> = {};

    for (const entry of allFiles) {
      if (entry.dir) continue;
      const relativePath = prefix ? entry.name.slice(prefix.length) : entry.name;
      if (!relativePath) continue;
      zipEntries[relativePath] = await entry.async('uint8array');
    }

    const gameName = gameData?.game?.title || gameData?.scenario?.title || gameData?.scenario?.name || 'Unknown Game';

    return {
      type: 'game',
      name: gameName,
      data: { uniqid, gameData, gameDataRaw: gameDataContent, zipEntries },
      isValid: true
    };
  } catch (error) {
    console.error('Error processing ZIP file:', error);
    return {
      type: 'unknown',
      name: file.name,
      data: null,
      isValid: false,
      error: `Failed to process ZIP file: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

async function handleJsonFile(file: File): Promise<UploadResult> {
  try {
    const text = await file.text();
    const data = JSON.parse(text);

    const fileName = file.name.toLowerCase();

    const layoutPattern = /^[^_]+_layout_[^.]+\.json$/;
    if (layoutPattern.test(fileName)) {
      const [gameType, , version] = file.name.replace('.json', '').split('_');
      return {
        type: 'layout',
        name: file.name,
        data: {
          layoutData: data,
          gameType,
          version,
          fileName: file.name,
          rawContent: text
        },
        isValid: true
      };
    }

    if (fileName.includes('layout')) {
      return {
        type: 'layout',
        name: file.name,
        data: { layoutData: data, fileName: file.name, rawContent: text },
        isValid: true
      };
    }

    const patternPattern = /^pattern_[^.]+\.json$/;
    if (patternPattern.test(fileName)) {
      const patternSlug = file.name.replace('.json', '');
      return {
        type: 'pattern',
        name: file.name,
        data: {
          patternData: data,
          patternSlug,
          fileName: file.name,
          rawContent: text
        },
        isValid: true
      };
    }

    return {
      type: 'unknown',
      name: file.name,
      data,
      isValid: false,
      error: 'Cannot determine JSON file type. Expected format: "{game_type}_layout_{version}.json" or "pattern_{pattern_slug}.json".'
    };
  } catch (error) {
    console.error('Error processing JSON file:', error);
    return {
      type: 'unknown',
      name: file.name,
      data: null,
      isValid: false,
      error: `Invalid JSON file: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

async function handleCsvFile(file: File, fileName: string): Promise<UploadResult> {
  try {
    const text = await file.text();

    if (fileName.includes('pattern')) {
      const patternSlug = file.name.replace('.csv', '');
      return {
        type: 'pattern',
        name: file.name,
        data: { csvContent: text, patternSlug, fileName: file.name },
        isValid: true
      };
    } else if (fileName.startsWith('on_demand_') || fileName.includes('card') || fileName.includes('client')) {
      return {
        type: 'cards',
        name: file.name,
        data: { csvContent: text, fileName: file.name },
        isValid: true
      };
    } else if (fileName.includes('layout')) {
      return {
        type: 'layout',
        name: file.name,
        data: { csvContent: text, fileName: file.name },
        isValid: true
      };
    } else {
      return {
        type: 'unknown',
        name: file.name,
        data: { csvContent: text },
        isValid: false,
        error: 'Cannot determine CSV file type. Filename should contain "pattern", "card"/"client", start with "on_demand_", or contain "layout".'
      };
    }
  } catch (error) {
    console.error('Error processing CSV file:', error);
    return {
      type: 'unknown',
      name: file.name,
      data: null,
      isValid: false,
      error: `Failed to read CSV file: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

export async function saveUploadedFile(result: UploadResult): Promise<void> {
  if (!result.isValid || !result.data) {
    throw new Error(result.error || 'Invalid upload result');
  }

  const electron = (window as any).electron;
  const isElectron = electron && electron.isElectron;

  if (!isElectron) {
    if (result.type === 'game') {
      await saveGameWeb(result.data);
    } else if (result.type === 'pattern') {
      await savePatternWeb(result.data);
    } else if (result.type === 'layout') {
      await saveLayoutWeb(result.data);
    } else if (result.type === 'cards') {
      await saveCardsWeb(result.data);
    } else {
      throw new Error(`Cannot save file of type: ${result.type}`);
    }
    return;
  }

  switch (result.type) {
    case 'game':
      await saveGame(result.data);
      break;
    case 'pattern':
      await savePattern(result.data);
      break;
    case 'cards':
      await saveCards(result.data);
      break;
    case 'layout':
      await saveLayout(result.data);
      break;
    default:
      throw new Error(`Cannot save file of type: ${result.type}`);
  }
}

async function saveGame(data: any): Promise<void> {
  const { uniqid, zipEntries } = data;
  const electron = (window as any).electron;

  for (const [entryPath, fileData] of Object.entries(zipEntries as Record<string, Uint8Array>)) {
    await electron.scenarios.saveZipEntry(uniqid, entryPath, btoa(String.fromCharCode(...fileData)));
  }

  await electron.scenarios.refresh();
}

async function savePattern(data: any): Promise<void> {
  const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

  if (isElectron) {
    await savePatternElectron(data);
  } else {
    await savePatternWeb(data);
  }
}

async function savePatternElectron(data: any): Promise<void> {
  const electron = (window as any).electron;
  const { patternData, patternSlug, fileName, csvContent } = data;

  if (csvContent) {
    await electron.patterns?.saveCsv(patternSlug, csvContent);
  } else if (patternData) {
    await electron.patterns?.save(patternSlug, patternData);
  } else {
    throw new Error('No pattern data or CSV content found');
  }

  console.log(`Pattern ${patternSlug} saved to Electron storage`);
}

async function savePatternWeb(data: any): Promise<void> {
  const { patternData, patternSlug, fileName, csvContent, rawContent } = data;

  const isJson = !!rawContent || !!patternData;
  const fileContent = rawContent || csvContent || JSON.stringify(patternData);
  const ext = isJson && !csvContent ? 'json' : 'csv';

  let gameType = 'mystery';
  if (patternData?.game_type) {
    gameType = patternData.game_type;
  } else if (csvContent) {
    const firstLine = csvContent.split('\n')[0] || '';
    const headers = firstLine.split(',');
    const gameTypeIndex = headers.indexOf('game_type');
    if (gameTypeIndex !== -1) {
      const secondLine = csvContent.split('\n')[1] || '';
      const values = secondLine.split(',');
      if (values[gameTypeIndex]) {
        gameType = values[gameTypeIndex].trim().replace(/^"|"$/g, '');
      }
    }
  }

  const storageFileName = fileName || `${patternSlug}.${ext}`;
  const storagePath = `patterns/${gameType}/${storageFileName}`;
  const blob = new Blob([fileContent], { type: ext === 'json' ? 'application/json' : 'text/csv' });

  const { error: uploadError } = await supabase.storage
    .from('resources')
    .upload(storagePath, blob, { upsert: true, contentType: blob.type });

  if (uploadError) {
    console.error('Error uploading pattern to storage:', uploadError);
    throw new Error(`Failed to upload pattern: ${uploadError.message}`);
  }

  const { error: upsertError } = await supabase
    .from('patterns')
    .upsert({
      slug: patternSlug,
      name: patternSlug,
      game_type: gameType,
    }, { onConflict: 'slug' });

  if (upsertError) {
    console.warn('Error upserting pattern record:', upsertError);
  }

  console.log(`Pattern ${patternSlug} saved to Supabase Storage at ${storagePath}`);
}

async function saveCards(data: any): Promise<void> {
  await saveCardsWeb(data);
}

async function saveCardsWeb(data: any): Promise<void> {
  const { csvContent, fileName } = data;

  const storagePath = `cards/${fileName}`;
  const blob = new Blob([csvContent], { type: 'text/csv' });

  const { error: uploadError } = await supabase.storage
    .from('resources')
    .upload(storagePath, blob, { upsert: true, contentType: 'text/csv' });

  if (uploadError) {
    console.error('Error uploading cards to storage:', uploadError);
    throw new Error(`Failed to upload cards: ${uploadError.message}`);
  }

  console.log(`Cards file ${fileName} saved to Supabase Storage at ${storagePath}`);
}

async function saveLayout(data: any): Promise<void> {
  const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

  if (isElectron) {
    await saveLayoutElectron(data);
  } else {
    await saveLayoutWeb(data);
  }
}

async function saveLayoutElectron(data: any): Promise<void> {
  const electron = (window as any).electron;
  const { layoutData, gameType, version, fileName } = data;

  const layoutIdentifier = fileName
    ? fileName.replace('.json', '')
    : (layoutData.name || layoutData.id || 'layout');

  await electron.layouts?.save(layoutIdentifier, layoutData);

  console.log(`Layout ${layoutIdentifier} saved to Electron storage`);
}

async function saveLayoutWeb(data: any): Promise<void> {
  const { layoutData, gameType, version, fileName, rawContent } = data;

  const resolvedFileName = fileName || `${gameType}_layout_${version || Date.now()}.json`;
  const resolvedGameType = gameType || resolvedFileName.split('_')[0];
  const storagePath = `layouts/${resolvedGameType}/${resolvedFileName}`;
  const fileContent = rawContent || JSON.stringify(layoutData);
  const blob = new Blob([fileContent], { type: 'application/json' });

  const { error: uploadError } = await supabase.storage
    .from('resources')
    .upload(storagePath, blob, { upsert: true, contentType: 'application/json' });

  if (uploadError) {
    console.error('Error uploading layout to storage:', uploadError);
    throw new Error(`Failed to upload layout: ${uploadError.message}`);
  }

  console.log(`Layout saved to Supabase Storage at ${storagePath}`);
}

async function saveGameWeb(data: any): Promise<void> {
  const { uniqid, gameData, gameDataRaw, zipEntries } = data;

  const mimeMap: Record<string, string> = {
    json: 'application/json',
    csv: 'text/csv',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg'
  };

  for (const [entryPath, fileData] of Object.entries(zipEntries as Record<string, Uint8Array>)) {
    const ext = entryPath.split('.').pop()?.toLowerCase() || '';
    const contentType = mimeMap[ext] || 'application/octet-stream';
    const storagePath = `scenarios/${uniqid}/${entryPath}`;

    const { error: uploadError } = await supabase.storage
      .from('resources')
      .upload(storagePath, fileData, { upsert: true, contentType });

    if (uploadError) {
      console.error(`Error uploading ${entryPath}:`, uploadError);
      throw new Error(`Failed to upload ${entryPath}: ${uploadError.message}`);
    }
  }

  const scenario = gameData?.game || gameData?.scenario || gameData;
  const title = scenario?.title || scenario?.name || uniqid;
  const gameType = scenario?.game_type || scenario?.type || 'mystery';
  const description = scenario?.description || '';
  const version = scenario?.version || '1.0';
  const durationMinutes = scenario?.duration_minutes || scenario?.duration || 60;
  const difficulty = scenario?.difficulty || 'medium';

  const { error: upsertError } = await supabase
    .from('scenarios')
    .upsert({
      uniqid,
      title,
      description,
      game_type: gameType,
      version,
      duration_minutes: durationMinutes,
      difficulty,
      updated_at: new Date().toISOString()
    }, { onConflict: 'uniqid' });

  if (upsertError) {
    console.warn('Warning: failed to upsert scenario record:', upsertError);
  }

  console.log(`Successfully saved scenario ${uniqid} to Supabase Storage`);
}
