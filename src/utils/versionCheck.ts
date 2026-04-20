export function parseVersionFromFilename(filename: string): number {
  const versionMatch = filename.match(/_v?(\d+)\./);
  if (versionMatch) {
    return parseInt(versionMatch[1], 10);
  }
  return 0;
}

export function compareVersions(localVersion: number, remoteVersion: number): boolean {
  return remoteVersion > localVersion;
}

export function getHighestVersion(filenames: string[]): number {
  let highest = 0;
  for (const filename of filenames) {
    const version = parseVersionFromFilename(filename);
    if (version > highest) {
      highest = version;
    }
  }
  return highest;
}

export function getVersionsToKeep(filenames: string[], keepCount: number = 2): string[] {
  const filesWithVersions = filenames
    .map(filename => ({
      filename,
      version: parseVersionFromFilename(filename)
    }))
    .sort((a, b) => b.version - a.version);

  return filesWithVersions.slice(0, keepCount).map(f => f.filename);
}

export function getVersionsToDelete(filenames: string[], keepCount: number = 2): string[] {
  const filesWithVersions = filenames
    .map(filename => ({
      filename,
      version: parseVersionFromFilename(filename)
    }))
    .sort((a, b) => b.version - a.version);

  return filesWithVersions.slice(keepCount).map(f => f.filename);
}

export function groupFilesByBaseName(filenames: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();

  for (const filename of filenames) {
    const baseName = filename.replace(/_v?\d+\..*$/, '');
    if (!groups.has(baseName)) {
      groups.set(baseName, []);
    }
    groups.get(baseName)!.push(filename);
  }

  return groups;
}
