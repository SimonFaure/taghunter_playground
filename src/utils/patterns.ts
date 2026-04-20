import { supabase } from '../lib/db';

const DEFAULT_PATTERN_FOLDERS = ['ado_adultes', 'kids', 'mini_kids'];

export interface PatternFile {
  uniqid: string;
  slug: string;
  fileName: string;
  storagePath: string;
}

export interface PatternOption {
  slug: string;
  name: string;
  uniqid: string;
}

function parsePatternFileName(fileName: string): { uniqid: string; slug: string } | null {
  const baseName = fileName.replace(/\.(json|csv)$/, '');
  if (!baseName.startsWith('pattern_')) return null;
  const afterPrefix = baseName.slice('pattern_'.length);
  const slugIdx = afterPrefix.indexOf('_');
  if (slugIdx === -1) return null;
  const uniqid = afterPrefix.slice(0, slugIdx);
  const slug = afterPrefix.slice(slugIdx + 1);
  if (!uniqid || !slug) return null;
  return { uniqid, slug };
}

export async function getPatternFilesFromStorage(gameTypeName: string): Promise<PatternFile[]> {
  const folderPath = `patterns/${gameTypeName}`;
  const { data, error } = await supabase.storage
    .from('resources')
    .list(folderPath, { limit: 1000 });

  if (error) {
    console.error(`Storage list error for ${folderPath}:`, error);
    return [];
  }
  if (!data) return [];

  const files: PatternFile[] = [];
  for (const item of data) {
    if (!item.name || item.name === '.emptyFolderPlaceholder') continue;
    const parsed = parsePatternFileName(item.name);
    if (parsed) {
      files.push({ uniqid: parsed.uniqid, slug: parsed.slug, fileName: item.name, storagePath: `${folderPath}/${item.name}` });
    }
  }
  return files;
}

export async function getPatternFolders(gameTypeName: string): Promise<string[]> {
  if (window.electron?.patterns?.listFolders) {
    try {
      const folders = await window.electron.patterns.listFolders(gameTypeName);
      return folders;
    } catch (error) {
      console.error('Error reading pattern folders:', error);
      return DEFAULT_PATTERN_FOLDERS;
    }
  }

  try {
    const storageFiles = await getPatternFilesFromStorage(gameTypeName);
    const storageSlugs = storageFiles.map(f => f.slug);

    const { data: patterns, error } = await supabase
      .from('patterns')
      .select('slug')
      .eq('game_type', gameTypeName);

    const dbSlugs = error ? [] : (patterns || []).map((p: { slug: string }) => p.slug);

    const merged = [...DEFAULT_PATTERN_FOLDERS];
    for (const slug of [...storageSlugs, ...dbSlugs]) {
      if (!merged.includes(slug)) merged.push(slug);
    }
    return merged;
  } catch (err) {
    console.warn('Error fetching pattern folders:', err);
    return DEFAULT_PATTERN_FOLDERS;
  }
}

async function readPatternName(gameTypeName: string, slug: string, uniqid?: string): Promise<string> {
  try {
    if (window.electron?.patterns?.readFile) {
      const csv = await window.electron.patterns.readFile(gameTypeName, slug, 'pattern.csv');
      const lines = csv.trim().split('\n');
      if (lines.length >= 2) {
        const headers = lines[0].split(',');
        const nameIdx = headers.findIndex(h => h.trim() === 'name');
        if (nameIdx !== -1) {
          const vals = lines[1].split(',');
          const raw = vals[nameIdx]?.trim().replace(/^"|"$/g, '');
          if (raw) return raw;
        }
      }
    } else {
      const filePath = uniqid
        ? `patterns/${gameTypeName}/pattern_${uniqid}_${slug}.csv`
        : `patterns/${gameTypeName}/pattern_${slug}.csv`;
      const { data } = supabase.storage.from('resources').getPublicUrl(filePath);
      const resp = await fetch(data.publicUrl);
      if (resp.ok) {
        const csv = await resp.text();
        const lines = csv.trim().split('\n');
        if (lines.length >= 2) {
          const headers = lines[0].split(',');
          const nameIdx = headers.findIndex(h => h.trim() === 'name');
          if (nameIdx !== -1) {
            const vals = lines[1].split(',');
            const raw = vals[nameIdx]?.trim().replace(/^"|"$/g, '');
            if (raw) return raw;
          }
        }
      }
    }
  } catch {
  }
  return slug;
}

export async function getPatternOptions(gameTypeName: string): Promise<PatternOption[]> {
  const storageFiles = await getPatternFilesFromStorage(gameTypeName);

  const seenSlugs = new Set<string>();
  const options: PatternOption[] = [];

  for (const file of storageFiles) {
    if (seenSlugs.has(file.slug)) continue;
    seenSlugs.add(file.slug);
    const name = await readPatternName(gameTypeName, file.slug, file.uniqid);
    options.push({ slug: file.slug, name, uniqid: file.uniqid });
  }

  if (window.electron?.patterns?.listFolders) {
    try {
      const folders: string[] = await window.electron.patterns.listFolders(gameTypeName);
      for (const slug of folders) {
        if (seenSlugs.has(slug)) continue;
        seenSlugs.add(slug);
        const name = await readPatternName(gameTypeName, slug);
        options.push({ slug, name, uniqid: '' });
      }
    } catch {}
  }

  return options;
}

async function readGameDataFile(uniqid: string): Promise<any> {
  if (window.electron?.games?.readFile) {
    try {
      const fileContent = await window.electron.games.readFile(uniqid, 'game-data.json');
      return JSON.parse(fileContent);
    } catch (error) {
      console.error('Error reading game data via Electron:', error);
      throw error;
    }
  } else {
    const { data } = supabase.storage
      .from('resources')
      .getPublicUrl(`scenarios/${uniqid}/game-data.json`);

    const response = await fetch(data.publicUrl);
    if (response.ok) {
      return await response.json();
    }

    const fallbackResponse = await fetch(`/data/games/${uniqid}/game-data.json`);
    if (!fallbackResponse.ok) {
      throw new Error(`Failed to fetch game data: ${fallbackResponse.statusText}`);
    }
    return await fallbackResponse.json();
  }
}


export async function getDefaultPatternId(uniqid: string): Promise<string | null> {
  try {
    const gameData = await readGameDataFile(uniqid);
    return gameData?.scenario?.default_pattern_id || null;
  } catch (error) {
    console.error('Error reading default_pattern_id:', error);
    return null;
  }
}

export interface PatternEnigma {
  id: string;
  pattern_id: string;
  enigma_id: string;
  good_answers: string[];
  wrong_answers: string[];
}

function parseCSV(csvContent: string): any[] {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',');
  const result: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.match(/(".*?"|[^,]+)(?=\s*,|\s*$)/g) || [];
    const obj: any = {};

    headers.forEach((header, index) => {
      let value = values[index]?.trim() || '';
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      obj[header.trim()] = value;
    });

    result.push(obj);
  }

  return result;
}

async function readPatternFileFromStorage(gameTypeName: string, patternName: string, filename: string, patternUniqid?: string): Promise<string> {
  const extensions = ['csv', 'json'];

  if (patternUniqid) {
    for (const ext of extensions) {
      const storagePath = `patterns/${gameTypeName}/pattern_${patternUniqid}_${patternName}.${ext}`;
      const { data } = supabase.storage.from('resources').getPublicUrl(storagePath);
      const response = await fetch(data.publicUrl);
      if (response.ok) {
        return await response.text();
      }
    }
  }

  const localResponse = await fetch(`/data/patterns/${gameTypeName}/${patternName}/${filename}`);
  if (!localResponse.ok) {
    throw new Error(`Pattern file not found: ${gameTypeName}/${patternName}/${filename}`);
  }
  return await localResponse.text();
}

export async function loadPatternEnigmasByUniqid(gameTypeName: string, patternUniqid: string): Promise<PatternEnigma[]> {
  const storageFiles = await getPatternFilesFromStorage(gameTypeName);
  const match = storageFiles.find(f => f.uniqid === patternUniqid);
  if (match) {
    return loadPatternEnigmas(gameTypeName, match.slug, match.uniqid);
  }
  return [];
}

export async function loadPatternEnigmas(gameTypeName: string, patternName: string, patternUniqid?: string): Promise<PatternEnigma[]> {
  try {
    if (window.electron?.patterns?.readFile) {
      const csvContent = await window.electron.patterns.readFile(gameTypeName, patternName, 'patterns_survival_balises.csv');
      const parsed = parseCSV(csvContent);

      return parsed.map((row: any) => {
        let goodAnswers: string[] = [];
        let wrongAnswers: string[] = [];

        try {
          const goodAnswersStr = row.good_answers || '[]';
          const fixedGoodAnswers = goodAnswersStr.replace(/""/g, '"');
          goodAnswers = JSON.parse(fixedGoodAnswers);
        } catch (e) {
          console.warn('Error parsing good_answers for row', row.id, ':', e);
          goodAnswers = [];
        }

        try {
          const wrongAnswersStr = row.wrong_answers || '[]';
          const fixedWrongAnswers = wrongAnswersStr.replace(/""/g, '"');
          wrongAnswers = JSON.parse(fixedWrongAnswers);
        } catch (e) {
          console.warn('Error parsing wrong_answers for row', row.id, ':', e);
          wrongAnswers = [];
        }

        return {
          id: row.id,
          pattern_id: row.pattern_id,
          enigma_id: row.enigma_id,
          good_answers: goodAnswers,
          wrong_answers: wrongAnswers,
        };
      });
    }

    const csvContent = await readPatternFileFromStorage(gameTypeName, patternName, 'patterns_survival_balises.csv', patternUniqid);
    const parsed = parseCSV(csvContent);

    return parsed.map((row: any) => {
      let goodAnswers: string[] = [];
      let wrongAnswers: string[] = [];

      try {
        const goodAnswersStr = row.good_answers || '[]';
        const fixedGoodAnswers = goodAnswersStr.replace(/""/g, '"');
        goodAnswers = JSON.parse(fixedGoodAnswers);
      } catch (e) {
        goodAnswers = [];
      }

      try {
        const wrongAnswersStr = row.wrong_answers || '[]';
        const fixedWrongAnswers = wrongAnswersStr.replace(/""/g, '"');
        wrongAnswers = JSON.parse(fixedWrongAnswers);
      } catch (e) {
        wrongAnswers = [];
      }

      return {
        id: row.id,
        pattern_id: row.pattern_id,
        enigma_id: row.enigma_id,
        good_answers: goodAnswers,
        wrong_answers: wrongAnswers,
      };
    });
  } catch (error) {
    console.error('Error loading pattern enigmas:', error);
    return [];
  }
}

export { readGameDataFile };
