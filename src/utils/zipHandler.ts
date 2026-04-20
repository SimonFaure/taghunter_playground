import JSZip from 'jszip';
import { supabase } from '../lib/db';

export interface ValidationResult {
  success: boolean;
  message?: string;
  uniqid?: string;
  gameType?: string;
}

export async function validateAndExtractZip(file: File): Promise<ValidationResult> {
  try {
    const zip = await JSZip.loadAsync(file);
    const fileList = Object.keys(zip.files);

    console.log('Files in ZIP:', fileList);

    const hasCsvFolder = fileList.some(f => f.includes('csv/') || f === 'csv' || f === 'csv/');
    const hasMediaFolder = fileList.some(f => f.includes('media/') || f === 'media' || f === 'media/');

    if (!hasCsvFolder || !hasMediaFolder) {
      return {
        success: false,
        message: `Invalid folder structure. ZIP must contain "csv" and "media" folders. Found: ${fileList.slice(0, 5).join(', ')}`
      };
    }

    let gameCsvFile = zip.files['csv/game.csv'];

    if (!gameCsvFile) {
      const gameCsvPath = fileList.find(f => f.endsWith('csv/game.csv') || f.endsWith('/csv/game.csv'));
      if (gameCsvPath) {
        gameCsvFile = zip.files[gameCsvPath];
      }
    }

    if (!gameCsvFile) {
      return {
        success: false,
        message: `game.csv not found in csv folder. Files found: ${fileList.filter(f => f.includes('.csv')).join(', ')}`
      };
    }

    const gameCsvContent = await gameCsvFile.async('text');
    const lines = gameCsvContent.trim().split('\n');

    if (lines.length < 2) {
      return {
        success: false,
        message: 'game.csv is empty or invalid.'
      };
    }

    const headers = lines[0].split(',');
    const values = lines[1].split(',');
    const gameData: Record<string, string> = {};

    headers.forEach((header, index) => {
      gameData[header.trim()] = values[index]?.trim() || '';
    });

    const uniqid = gameData.uniqid;
    const gameType = gameData.type;

    if (!uniqid) {
      return {
        success: false,
        message: 'uniqid not found in game.csv.'
      };
    }

    if (gameType === 'mystery') {
      const requiredFiles = [
        'game_enigmas.csv',
        'game_media_images.csv',
        'game_meta.csv',
        'game_sounds.csv',
        'game_user_meta.csv'
      ];

      for (const requiredFileName of requiredFiles) {
        const found = fileList.some(f => f.endsWith(`csv/${requiredFileName}`) || f.endsWith(`/${requiredFileName}`));
        if (!found) {
          return {
            success: false,
            message: `Missing required file for mystery game: ${requiredFileName}`
          };
        }
      }
    }

    await saveZipToDataFolder(zip, uniqid);

    return {
      success: true,
      uniqid,
      gameType
    };
  } catch (error) {
    return {
      success: false,
      message: `Error processing ZIP file: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

async function saveZipToDataFolder(zip: JSZip, uniqid: string): Promise<void> {
  const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

  if (isElectron) {
    for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) continue;

      const isBinary = relativePath.match(/\.(png|jpg|jpeg|gif|mp3|wav|ogg)$/i);
      const content = isBinary
        ? await zipEntry.async('base64')
        : await zipEntry.async('text');

      await (window as any).electron.games.writeFile(uniqid, relativePath, content, isBinary);
    }
  } else {
    await saveZipToBrowserStorage(zip, uniqid);
  }
}

async function saveZipToBrowserStorage(zip: JSZip, uniqid: string): Promise<void> {
  const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir);

  const CONCURRENCY = 5;
  let index = 0;

  async function uploadNext(): Promise<void> {
    if (index >= entries.length) return;
    const [relativePath, zipEntry] = entries[index++];

    const storagePath = `scenarios/${uniqid}/${relativePath}`;
    const isBinary = /\.(png|jpg|jpeg|gif|bmp|webp|mp3|wav|ogg|mp4|webm|mov)$/i.test(relativePath);

    let blob: Blob;
    if (isBinary) {
      const arrayBuffer = await zipEntry.async('arraybuffer');
      blob = new Blob([arrayBuffer]);
    } else {
      const text = await zipEntry.async('text');
      blob = new Blob([text], { type: 'text/plain' });
    }

    const { error } = await supabase.storage
      .from('resources')
      .upload(storagePath, blob, { upsert: true });

    if (error) {
      console.error(`[zipHandler] Failed to upload ${storagePath}:`, error.message);
    }

    return uploadNext();
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () => uploadNext());
  await Promise.all(workers);

  console.log(`[zipHandler] Uploaded ${entries.length} files to scenarios/${uniqid}/`);
}
