// Custom launch-logo file handling. The logo screen (see LogoLaunchScreen)
// can show a per-device custom logo; the image is copied into AppData as
// `launch-logo.<ext>` and its filename is stored in config.json
// (`logoScreenLogoFile`). Kept separate from config.ts because this deals
// with binary image bytes rather than the JSON prefs blob.

import {
  readFile,
  writeFile,
  remove,
  exists,
  BaseDirectory,
} from '@tauri-apps/plugin-fs';

const FS_OPTS = { baseDir: BaseDirectory.AppData } as const;

const SUPPORTED_EXTS = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif'];

export function isSupportedLogoExt(ext: string): boolean {
  return SUPPORTED_EXTS.includes(ext.toLowerCase());
}

export function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return 'application/octet-stream';
  }
}

// Best-effort extension for a picked File — prefers the filename, falls
// back to the MIME subtype.
export function extForFile(file: File): string {
  const fromName = file.name.includes('.')
    ? file.name.split('.').pop()!.toLowerCase()
    : '';
  if (fromName) return fromName;
  const sub = (file.type.split('/')[1] ?? 'png').toLowerCase();
  if (sub === 'svg+xml') return 'svg';
  if (sub === 'jpeg') return 'jpg';
  return sub;
}

// Writes the logo bytes into AppData as `launch-logo.<ext>` and returns the
// filename. If a previous logo with a different name exists it's removed so
// no orphan file is left behind.
export async function writeLaunchLogo(
  bytes: Uint8Array,
  ext: string,
  previousFile?: string | null,
): Promise<string> {
  const filename = `launch-logo.${ext.toLowerCase()}`;
  await writeFile(filename, bytes, FS_OPTS);
  if (previousFile && previousFile !== filename) {
    await removeLaunchLogo(previousFile);
  }
  return filename;
}

export async function removeLaunchLogo(filename: string): Promise<void> {
  try {
    if (await exists(filename, FS_OPTS)) {
      await remove(filename, FS_OPTS);
    }
  } catch {
    // best effort — an orphan file is harmless
  }
}

// Reads a stored logo file back as an object URL suitable for an <img src>.
// Returns null if the file is missing or unreadable (caller falls back to
// the bundled TagHunter logo).
export async function readLaunchLogoUrl(filename: string): Promise<string | null> {
  try {
    if (!(await exists(filename, FS_OPTS))) return null;
    const bytes = await readFile(filename, FS_OPTS);
    const ext = filename.includes('.') ? filename.split('.').pop()! : 'png';
    const blob = new Blob([bytes], { type: mimeForExt(ext) });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}
