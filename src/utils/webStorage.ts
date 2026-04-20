import { supabase } from '../lib/db';

interface StorageNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size?: number;
  children?: StorageNode[];
  expanded?: boolean;
}

export async function getWebStorageStructure(): Promise<StorageNode> {
  const root: StorageNode = {
    name: 'Browser Storage',
    path: '/',
    type: 'folder',
    expanded: true,
    children: []
  };

  const [scenariosFolder, layoutsFolder, patternsFolder, cardsFolder, configFolder] = await Promise.all([
    buildScenariosFolder(),
    buildLayoutsFolder(),
    buildPatternsFolder(),
    buildCardsFolder(),
    buildConfigFolder()
  ]);

  root.children = [scenariosFolder, layoutsFolder, patternsFolder, cardsFolder, configFolder];

  return root;
}

async function listStorageFolder(prefix: string): Promise<{ name: string; metadata?: { size?: number } }[]> {
  const { data, error } = await supabase.storage.from('resources').list(prefix, { limit: 1000 });
  if (error || !data) return [];
  return data;
}

async function listAllFilesRecursive(prefix: string): Promise<string[]> {
  const items = await listStorageFolder(prefix);
  const filePaths: string[] = [];

  for (const item of items) {
    if (!item.name || item.name === '.emptyFolderPlaceholder') continue;
    const fullPath = `${prefix}/${item.name}`;
    const isFolder = !item.name.includes('.');
    if (isFolder) {
      const nested = await listAllFilesRecursive(fullPath);
      filePaths.push(...nested);
    } else {
      filePaths.push(fullPath);
    }
  }

  return filePaths;
}

async function buildStorageTree(prefix: string, path: string): Promise<StorageNode[]> {
  const items = await listStorageFolder(prefix);
  const nodes: StorageNode[] = [];

  for (const item of items) {
    if (!item.name || item.name === '.emptyFolderPlaceholder') continue;

    const itemPath = `${path}/${item.name}`;
    const storagePath = `${prefix}/${item.name}`;
    const isFolder = !item.name.includes('.');

    if (isFolder) {
      const children = await buildStorageTree(storagePath, itemPath);
      nodes.push({
        name: item.name,
        path: itemPath,
        type: 'folder',
        expanded: false,
        children
      });
    } else {
      nodes.push({
        name: item.name,
        path: itemPath,
        type: 'file',
        size: item.metadata?.size
      });
    }
  }

  return nodes;
}

async function buildScenariosFolder(): Promise<StorageNode> {
  const scenariosFolder: StorageNode = {
    name: 'Scenarios',
    path: '/scenarios',
    type: 'folder',
    expanded: false,
    children: []
  };

  try {
    const scenarioEntries = await listStorageFolder('scenarios');

    for (const entry of scenarioEntries) {
      if (!entry.name || entry.name === '.emptyFolderPlaceholder') continue;

      const uniqid = entry.name;
      const children = await buildStorageTree(`scenarios/${uniqid}`, `/scenarios/${uniqid}`);

      scenariosFolder.children?.push({
        name: uniqid,
        path: `/scenarios/${uniqid}`,
        type: 'folder',
        expanded: false,
        children
      });
    }
  } catch (error) {
    console.error('Error building scenarios folder:', error);
  }

  return scenariosFolder;
}

async function buildLayoutsFolder(): Promise<StorageNode> {
  const layoutsFolder: StorageNode = {
    name: 'Layouts',
    path: '/layouts',
    type: 'folder',
    expanded: false,
    children: []
  };

  try {
    const entries = await listStorageFolder('layouts');
    for (const entry of entries) {
      if (!entry.name || entry.name === '.emptyFolderPlaceholder') continue;

      const isFolder = !entry.name.includes('.');
      if (isFolder) {
        const gameTypeFolder: StorageNode = {
          name: entry.name,
          path: `/layouts/${entry.name}`,
          type: 'folder',
          expanded: false,
          children: []
        };

        const innerFiles = await listStorageFolder(`layouts/${entry.name}`);
        for (const file of innerFiles) {
          if (file.name && file.name !== '.emptyFolderPlaceholder') {
            gameTypeFolder.children?.push({
              name: file.name,
              path: `/layouts/${entry.name}/${file.name}`,
              type: 'file',
              size: file.metadata?.size
            });
          }
        }

        layoutsFolder.children?.push(gameTypeFolder);
      } else {
        layoutsFolder.children?.push({
          name: entry.name,
          path: `/layouts/${entry.name}`,
          type: 'file',
          size: entry.metadata?.size
        });
      }
    }
  } catch (err) {
    console.warn('Error listing layouts from storage:', err);
  }

  return layoutsFolder;
}

async function buildPatternsFolder(): Promise<StorageNode> {
  const patternsFolder: StorageNode = {
    name: 'Patterns',
    path: '/patterns',
    type: 'folder',
    expanded: false,
    children: []
  };

  try {
    const gameTypeFolders = await listStorageFolder('patterns');

    for (const folder of gameTypeFolders) {
      if (!folder.name) continue;

      const gameTypeFolder: StorageNode = {
        name: folder.name,
        path: `/patterns/${folder.name}`,
        type: 'folder',
        expanded: false,
        children: []
      };

      const patternFiles = await listStorageFolder(`patterns/${folder.name}`);
      for (const file of patternFiles) {
        if (file.name) {
          gameTypeFolder.children?.push({
            name: file.name,
            path: `/patterns/${folder.name}/${file.name}`,
            type: 'file',
            size: file.metadata?.size
          });
        }
      }

      patternsFolder.children?.push(gameTypeFolder);
    }
  } catch (err) {
    console.warn('Error listing patterns from storage:', err);
  }

  return patternsFolder;
}

async function buildCardsFolder(): Promise<StorageNode> {
  const cardsFolder: StorageNode = {
    name: 'Cards',
    path: '/cards',
    type: 'folder',
    expanded: false,
    children: []
  };

  try {
    const files = await listStorageFolder('cards');
    for (const file of files) {
      if (file.name) {
        cardsFolder.children?.push({
          name: file.name,
          path: `/cards/${file.name}`,
          type: 'file',
          size: file.metadata?.size
        });
      }
    }
  } catch (err) {
    console.warn('Error listing cards from storage:', err);
  }

  return cardsFolder;
}

function buildConfigFolder(): StorageNode {
  const configFolder: StorageNode = {
    name: 'Configuration',
    path: '/config',
    type: 'folder',
    expanded: false,
    children: []
  };

  const configKeys = ['app_config', 'selected_client', 'launched_games'];
  for (const key of configKeys) {
    const dataStr = localStorage.getItem(key);
    if (dataStr) {
      const size = new Blob([dataStr]).size;
      configFolder.children?.push({
        name: key,
        path: `/config/${key}`,
        type: 'file',
        size
      });
    }
  }

  return configFolder;
}

export function getWebStorageInfo(): { used: number; total: number } {
  let totalSize = 0;

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) {
      const value = localStorage.getItem(key);
      if (value) {
        totalSize += new Blob([key, value]).size;
      }
    }
  }

  const quota = 100 * 1024 * 1024;

  return { used: totalSize, total: quota };
}

export function getAllLocalStorageKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) {
      keys.push(key);
    }
  }
  return keys;
}

export function getLocalStorageItemSize(key: string): number {
  const value = localStorage.getItem(key);
  if (!value) return 0;
  return new Blob([key, value]).size;
}

export function clearLocalStorageByPrefix(prefix: string): number {
  let deletedCount = 0;
  const keysToDelete: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    localStorage.removeItem(key);
    deletedCount++;
  }

  return deletedCount;
}

export async function deleteWebStorageItem(path: string): Promise<boolean> {
  try {
    const pathParts = path.split('/').filter(p => p);

    if (pathParts.length === 0) {
      return false;
    }

    if (pathParts[0] === 'scenarios') {
      if (pathParts.length === 1) return false;

      const uniqid = pathParts[1];

      if (pathParts.length === 2) {
        const allFilePaths = await listAllFilesRecursive(`scenarios/${uniqid}`);
        if (allFilePaths.length > 0) {
          for (let i = 0; i < allFilePaths.length; i += 100) {
            await supabase.storage.from('resources').remove(allFilePaths.slice(i, i + 100));
          }
        }
        return true;
      }

      if (pathParts.length >= 3) {
        const storagePath = pathParts.slice(1).join('/');
        const lastPart = pathParts[pathParts.length - 1];
        const isFolder = !lastPart.includes('.');

        if (isFolder) {
          const allFilePaths = await listAllFilesRecursive(`scenarios/${storagePath}`);
          if (allFilePaths.length > 0) {
            await supabase.storage.from('resources').remove(allFilePaths);
          }
          return true;
        }

        const { error } = await supabase.storage
          .from('resources')
          .remove([`scenarios/${storagePath}`]);

        return !error;
      }
    }

    if (pathParts[0] === 'layouts') {
      if (pathParts.length === 2) {
        const gameType = pathParts[1];
        const allFilePaths = await listAllFilesRecursive(`layouts/${gameType}`);
        if (allFilePaths.length > 0) {
          const { error } = await supabase.storage.from('resources').remove(allFilePaths);
          return !error;
        }
        return true;
      }

      if (pathParts.length >= 3) {
        const filePath = pathParts.slice(1).join('/');
        const { error } = await supabase.storage
          .from('resources')
          .remove([`layouts/${filePath}`]);
        return !error;
      }
    }

    if (pathParts[0] === 'patterns') {
      if (pathParts.length >= 2) {
        const fileName = pathParts.slice(1).join('/');
        const { error } = await supabase.storage
          .from('resources')
          .remove([`patterns/${fileName}`]);

        if (!error && pathParts.length === 3) {
          const slug = pathParts[2].replace(/\.(json|csv)$/, '');
          await supabase.from('patterns').delete().eq('slug', slug);
        }

        return !error;
      }
    }

    if (pathParts[0] === 'cards') {
      if (pathParts.length >= 2) {
        const fileName = pathParts.slice(1).join('/');
        const { error } = await supabase.storage
          .from('resources')
          .remove([`cards/${fileName}`]);

        return !error;
      }
    }

    if (pathParts[0] === 'config') {
      if (pathParts.length === 2) {
        localStorage.removeItem(pathParts[1]);
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error('Error deleting web storage item:', error);
    return false;
  }
}
