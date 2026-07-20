// Parses a pattern file exported from the studio (CSV or XLSX) into the shape
// patternStore.importLocal expects. The studio embeds metadata so a manual
// upload here carries name / game_type / version / pattern_uniqid + the grid:
//
//   CSV : `#key,value` comment lines, a blank line, then a header row of
//         assignment-type keys + station-number rows.
//   XLSX: a "meta" sheet (key/value) + a "pattern" sheet (the grid).

export interface ParsedPattern {
  pattern_uniqid: string;
  name: string;
  game_type: string;
  version: number;
  is_default: boolean;
  pattern_slug: string | null;
  description: string | null;
  pattern_data: Array<{ index: number; assignments: Record<string, number> }>;
}

type Matrix = Array<Array<string | number>>;

function genUniqid(): string {
  return 'local_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Dedicated "meta" sheet - every row is [key, value] (tolerate a leading `#`).
function metaFromKeyValueRows(matrix: Matrix): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const row of matrix) {
    const key = String(row?.[0] ?? '').trim().replace(/^#/, '').trim().toLowerCase();
    if (key) meta[key] = row?.[1] != null ? String(row[1]).trim() : '';
  }
  return meta;
}

// Single-sheet file: metadata lives only on `#key,value` rows.
function metaFromHashRows(matrix: Matrix): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const row of matrix) {
    const first = String(row?.[0] ?? '').trim();
    if (!first.startsWith('#')) continue;
    const key = first.slice(1).trim().toLowerCase();
    if (key) meta[key] = row?.[1] != null ? String(row[1]).trim() : '';
  }
  return meta;
}

function gridRows(matrix: Matrix): Array<{ index: number; assignments: Record<string, number> }> {
  // Skip metadata (#...) and blank rows; the first remaining row is the header.
  const dataRows = matrix.filter((row) => {
    if (!row) return false;
    const allEmpty = row.every((c) => c == null || String(c).trim() === '');
    if (allEmpty) return false;
    const first = row[0] != null ? String(row[0]).trim() : '';
    return !first.startsWith('#');
  });
  if (dataRows.length < 2) return [];

  const header = dataRows[0].map((h) => String(h ?? '').trim());
  const out: Array<{ index: number; assignments: Record<string, number> }> = [];
  for (let r = 1; r < dataRows.length; r++) {
    const raw = dataRows[r];
    const assignments: Record<string, number> = {};
    header.forEach((key, i) => {
      if (!key) return;
      const cell = raw[i];
      if (cell == null || String(cell).trim() === '') return;
      const n = parseInt(String(cell).trim(), 10);
      if (Number.isFinite(n)) assignments[key] = n;
    });
    if (Object.keys(assignments).length) out.push({ index: out.length + 1, assignments });
  }
  return out;
}

export async function parsePatternFile(file: File): Promise<ParsedPattern> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });

  const names = wb.SheetNames;
  const metaSheetName = names.find((n) => n.toLowerCase() === 'meta');
  const gridSheetName = names.find((n) => n.toLowerCase() === 'pattern') ?? names[0];

  const gridMatrix = XLSX.utils.sheet_to_json(wb.Sheets[gridSheetName], {
    header: 1,
    blankrows: false,
  }) as Matrix;

  const meta = metaSheetName
    ? metaFromKeyValueRows(
        XLSX.utils.sheet_to_json(wb.Sheets[metaSheetName], { header: 1, blankrows: false }) as Matrix
      )
    : metaFromHashRows(gridMatrix);

  const game_type = (meta.game_type || '').toLowerCase().trim();
  if (!game_type) {
    throw new Error('This file has no game type. Use a pattern exported from the studio.');
  }

  const pattern_data = gridRows(gridMatrix);
  if (pattern_data.length === 0) {
    throw new Error('No pattern rows found in the file.');
  }

  const versionNum = parseFloat(meta.version || '');
  return {
    pattern_uniqid: meta.pattern_uniqid || genUniqid(),
    name: meta.name || file.name.replace(/\.(csv|xlsx?|xls)$/i, ''),
    game_type,
    version: Number.isFinite(versionNum) && versionNum > 0 ? versionNum : 1,
    // Imported patterns are always custom on this device - never a system default.
    is_default: false,
    pattern_slug: meta.pattern_slug || null,
    description: meta.description || null,
    pattern_data,
  };
}
