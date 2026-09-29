// Shared Excel/CSV roster importer used by two launch-flow features:
//   - Team import (LaunchGameModal step 2): TagQuest / Mystery / Tracks.
//   - Clash chip→clan assignments (collected in the launch modal, applied
//     after launch once clans exist).
//
// One parser, three shapes ('single' | 'team' | 'clan'). Parsing goes through
// the already-bundled SheetJS (xlsx), same as services/patternImport.ts, so we
// read .csv / .xls / .xlsx through one code path with no new dependency.
//
// Design: project_playground_team_import_excel_csv.

import type { RosterChip } from './launchResolve';

export type RosterImportMode = 'single' | 'team' | 'clan';

/** A clan slot known at launch-config time (Clash). index is the 1..N number. */
export interface ImportClanDef {
  index: number;
  name: string;
}

export interface RosterImportOptions {
  mode: RosterImportMode;
  /** Local Studio-synced roster to resolve rows against (strict match). */
  chips: RosterChip[];
  /** Chips already bound to another live game on this device - excluded. */
  busyChipIds?: Set<number>;
  /** Known clans (required for mode 'clan'). */
  clans?: ImportClanDef[];
}

export interface ImportedEntry {
  chip: RosterChip;
  /** Entry name: the team name (single) or the player name (team/clan). */
  name: string;
  /** Team name (team mode) or clan display name (clan mode). */
  group?: string;
  /** Resolved 1..N clan number (clan mode only). */
  clanIndex?: number;
  /** 1-based source row, for the preview. */
  rowIndex: number;
}

/** A row that couldn't be applied. `reason` is a stable code the UI translates. */
export interface SkippedEntry {
  rowIndex: number;
  reason: SkipReason;
  cells: string[];
}

export type SkipReason =
  | 'unknown-chip'
  | 'duplicate-chip'
  | 'chip-in-use'
  | 'missing-name'
  | 'missing-chip-ref'
  | 'id-number-mismatch'
  | 'unknown-clan'
  | 'missing-clan';

export interface RosterImportResult {
  mode: RosterImportMode;
  entries: ImportedEntry[];
  skipped: SkippedEntry[];
}

/** Thrown for fatal, whole-file problems. `code` is a stable UI-translatable key. */
export class RosterImportError extends Error {
  constructor(public code: FatalCode, public params?: Record<string, unknown>) {
    super(code);
    this.name = 'RosterImportError';
  }
}

export type FatalCode =
  | 'empty-file'
  | 'no-header'
  | 'missing-columns'
  | 'no-clans';

// ---------------------------------------------------------------------------
// Header synonym matching - normalize away case/accents/punctuation, then
// require a whole-cell match against a synonym set (so "team name" never
// collides with "name").
// ---------------------------------------------------------------------------

function norm(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const SYN = {
  chipId: ['chip id', 'chipid', 'id', 'card id', 'cardid', 'si', 'si id', 'siid', 'puce id', 'puceid', 'id puce', 'id de puce', 'si card', 'si number'],
  chipNumber: ['chip number', 'chipnumber', 'number', 'num', 'no', 'n', 'numero', 'num puce', 'numero puce', 'key number', 'keynumber', 'card number', 'numero de puce', 'numero de carte', 'dossard', 'numero de dossard'],
  playerName: ['name', 'nom', 'player', 'joueur', 'player name', 'nom joueur', 'nom du joueur', 'nombre', 'jugador', 'participant', 'prenom'],
  teamName: ['team', 'team name', 'teamname', 'equipe', 'nom equipe', 'nom d equipe', 'nom de l equipe', 'equipo', 'nombre de equipo', 'nombre equipo'],
  clan: ['clan', 'clan name', 'clanname', 'clan number', 'nom clan', 'nom du clan', 'numero clan', 'clan id', 'equipe', 'equipo', 'team'],
} as const;

type ColKey = keyof typeof SYN;

/** First column index whose normalized header is in the synonym set, else -1. */
function findCol(header: string[], key: ColKey, taken: Set<number>): number {
  // Widen to readonly string[]: calling .includes on the union of literal
  // tuples intersects the parameter types down to never.
  const set: readonly string[] = SYN[key];
  for (let i = 0; i < header.length; i++) {
    if (taken.has(i)) continue;
    if (set.includes(header[i])) return i;
  }
  return -1;
}

interface ColumnMap {
  chipId: number;
  chipNumber: number;
  name: number;
  group: number; // team name (team) or clan (clan); -1 in single
}

/**
 * Resolve column indices for the given mode. Returns null when the required
 * columns for the mode aren't all present (so the caller can keep scanning
 * rows for a header). `name`/`group` distinction:
 *   single: name = player OR team synonyms (one name column); no group.
 *   team:   name = player synonyms; group = team synonyms (both required).
 *   clan:   name = player synonyms (optional); group = clan synonyms (required).
 */
function resolveColumns(header: string[], mode: RosterImportMode): ColumnMap | null {
  const taken = new Set<number>();
  const chipId = findCol(header, 'chipId', taken);
  if (chipId >= 0) taken.add(chipId);
  const chipNumber = findCol(header, 'chipNumber', taken);
  if (chipNumber >= 0) taken.add(chipNumber);

  // Need at least one chip identifier.
  if (chipId < 0 && chipNumber < 0) return null;

  if (mode === 'team') {
    const group = findCol(header, 'teamName', taken);
    if (group < 0) return null;
    taken.add(group);
    const name = findCol(header, 'playerName', taken);
    return { chipId, chipNumber, name, group };
  }

  if (mode === 'clan') {
    const group = findCol(header, 'clan', taken);
    if (group < 0) return null;
    taken.add(group);
    const name = findCol(header, 'playerName', taken);
    return { chipId, chipNumber, name, group };
  }

  // single: a single name column, matching either player or team synonyms.
  let name = findCol(header, 'playerName', taken);
  if (name < 0) name = findCol(header, 'teamName', taken);
  if (name < 0) return null;
  return { chipId, chipNumber, name, group: -1 };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Matrix = unknown[][];

/** Scan the first few rows for the one that resolves the required columns. */
function detectHeader(matrix: Matrix, mode: RosterImportMode): { rowIndex: number; header: string[]; cols: ColumnMap } {
  const limit = Math.min(matrix.length, 8);
  for (let r = 0; r < limit; r++) {
    const header = (matrix[r] ?? []).map(norm);
    const cols = resolveColumns(header, mode);
    if (cols) return { rowIndex: r, header, cols };
  }
  // Distinguish "found a header-ish row but missing required cols" from noise:
  // if any row had a chip identifier we treat it as a columns problem.
  throw new RosterImportError('missing-columns', { mode });
}

function cellStr(row: Matrix[number], i: number): string {
  if (i < 0) return '';
  return String(row[i] ?? '').trim();
}

function parseIntCell(s: string): number | null {
  if (!s) return null;
  const n = parseInt(s.replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

export async function parseRosterFile(file: File, opts: RosterImportOptions): Promise<RosterImportResult> {
  if (opts.mode === 'clan' && (!opts.clans || opts.clans.length === 0)) {
    throw new RosterImportError('no-clans');
  }

  const XLSX = await import('xlsx');
  const bytes = new Uint8Array(await file.arrayBuffer());
  // .xlsx/.xlsb/.ods are ZIP archives ("PK"); read as binary. Anything else is
  // text (CSV/TSV) - SheetJS defaults to a legacy codepage there and mangles
  // accented headers, so decode explicitly: UTF-8 (handles BOM), falling back
  // to Windows-1252 for the CSVs French Excel still writes.
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  let wb: import('xlsx').WorkBook;
  if (isZip) {
    wb = XLSX.read(bytes, { type: 'array' });
  } else {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('windows-1252').decode(bytes);
    }
    wb = XLSX.read(text, { type: 'string' });
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new RosterImportError('empty-file');

  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false }) as Matrix;
  if (matrix.length === 0) throw new RosterImportError('empty-file');

  const { rowIndex: headerRow, cols } = detectHeader(matrix, opts.mode);

  // Index chips for lookup.
  const byId = new Map<number, RosterChip>();
  const byNumber = new Map<number, RosterChip>();
  for (const c of opts.chips) {
    byId.set(c.id, c);
    byNumber.set(c.key_number, c);
  }
  const busy = opts.busyChipIds ?? new Set<number>();

  // Clan resolution: number (1..N) or name (accent/case-insensitive).
  const clanByIndex = new Map<number, ImportClanDef>();
  const clanByName = new Map<string, ImportClanDef>();
  for (const cl of opts.clans ?? []) {
    clanByIndex.set(cl.index, cl);
    clanByName.set(norm(cl.name), cl);
  }

  const entries: ImportedEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const seenChipIds = new Set<number>();

  for (let r = headerRow + 1; r < matrix.length; r++) {
    const row = matrix[r] ?? [];
    const rowIndex = r + 1; // 1-based for humans
    const cells = row.map((c) => String(c ?? ''));

    const idStr = cellStr(row, cols.chipId);
    const numStr = cellStr(row, cols.chipNumber);
    const nameStr = cellStr(row, cols.name);
    const groupStr = cellStr(row, cols.group);

    // Fully blank row → ignore silently. So is a row carrying only its chip
    // reference: the downloaded template lists every chip of the account with
    // empty name/team cells, and the chips left unfilled are simply unused.
    if (!nameStr && !groupStr) continue;

    // Resolve the chip: prefer id, fall back to number; cross-check when both.
    const idVal = parseIntCell(idStr);
    const numVal = parseIntCell(numStr);
    const chipById = idVal != null ? byId.get(idVal) : undefined;
    const chipByNum = numVal != null ? byNumber.get(numVal) : undefined;

    if (idVal == null && numVal == null) {
      skipped.push({ rowIndex, reason: 'missing-chip-ref', cells });
      continue;
    }

    if (chipById && chipByNum && chipById.id !== chipByNum.id) {
      skipped.push({ rowIndex, reason: 'id-number-mismatch', cells });
      continue;
    }
    const chip = chipById ?? chipByNum;
    if (!chip) {
      skipped.push({ rowIndex, reason: 'unknown-chip', cells });
      continue;
    }

    if (seenChipIds.has(chip.id)) {
      skipped.push({ rowIndex, reason: 'duplicate-chip', cells });
      continue;
    }
    if (busy.has(chip.id)) {
      skipped.push({ rowIndex, reason: 'chip-in-use', cells });
      continue;
    }

    if (opts.mode === 'clan') {
      const clan =
        clanByIndex.get(parseIntCell(groupStr) ?? -1) ?? clanByName.get(norm(groupStr));
      if (!clan) {
        skipped.push({ rowIndex, reason: 'unknown-clan', cells });
        continue;
      }
      seenChipIds.add(chip.id);
      entries.push({
        chip,
        name: nameStr || chip.key_name,
        group: clan.name,
        clanIndex: clan.index,
        rowIndex,
      });
      continue;
    }

    if (opts.mode === 'team') {
      if (!groupStr) {
        skipped.push({ rowIndex, reason: 'missing-name', cells });
        continue;
      }
      seenChipIds.add(chip.id);
      entries.push({ chip, name: nameStr || chip.key_name, group: groupStr, rowIndex });
      continue;
    }

    // single
    if (!nameStr) {
      skipped.push({ rowIndex, reason: 'missing-name', cells });
      continue;
    }
    seenChipIds.add(chip.id);
    entries.push({ chip, name: nameStr, rowIndex });
  }

  return { mode: opts.mode, entries, skipped };
}

// ---------------------------------------------------------------------------
// Template - correct headers + one row per chip of the account (id and
// printed number pre-filled, name/team left empty for the licensee to fill).
// Licensees know their chips by number (n° 3), not by the 7-digit SportIdent id.
// ---------------------------------------------------------------------------

function buildTemplateRows(
  mode: RosterImportMode,
  chips: RosterChip[],
  clans?: ImportClanDef[],
): (string | number)[][] {
  const sorted = [...chips].sort((a, b) => a.key_number - b.key_number || a.id - b.id);
  const rows: (string | number)[][] = [];

  if (mode === 'team') rows.push(['chip id', 'chip number', 'name', 'team name']);
  else if (mode === 'clan') rows.push(['chip id', 'chip number', 'name', 'clan']);
  else rows.push(['chip id', 'chip number', 'name']);
  const blanks = rows[0].length - 2;
  for (const c of sorted) rows.push([c.id, c.key_number, ...Array<string>(blanks).fill('')]);

  // Ensure at least one example row even when the roster is empty.
  if (rows.length === 1) {
    if (mode === 'team') rows.push([1001, 1, 'Alice', 'Team 1']);
    else if (mode === 'clan') rows.push([1001, 1, 'Alice', clans?.[0]?.name || '1']);
    else rows.push([1001, 1, 'Red team']);
  }

  return rows;
}

/**
 * The template as a real .xlsx (not CSV): French Excel opens a comma CSV as a
 * single column, and a licensee fills this in Excel.
 */
export async function buildTemplateXlsx(
  mode: RosterImportMode,
  chips: RosterChip[],
  clans?: ImportClanDef[],
): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const rows = buildTemplateRows(mode, chips, clans);
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = rows[0].map((_, i) => ({ wch: i < 2 ? 12 : 24 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, mode === 'clan' ? 'Clans' : 'Teams');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}
