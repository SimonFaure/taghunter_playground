/**
 * Default print format (paper size + orientation) for mission reports.
 *
 * The studio report template defines the DESIGN; this store owns the physical
 * OUTPUT default: the studio-synced format (client's own, else the admin's)
 * with a built-in ticket fallback. The operator confirms/adjusts it per print
 * in the PrePrintModal - a one-shot choice that is NOT persisted, so the next
 * print opens on the default again.
 *
 * The chosen size becomes the generated report's `@page` size so the layout
 * matches the operator's actual paper before the OS print dialog opens.
 */

export type PaperSizeId = 'ticket_100x150' | 'a4' | 'a5' | 'a6' | 'custom';
export type Orientation = 'portrait' | 'landscape';

export interface PrintPrefs {
  paper: PaperSizeId;
  /** Used only when paper === 'custom' (millimetres). */
  customMm: { width: number; height: number };
  orientation: Orientation;
}

/** Portrait dimensions in millimetres; landscape swaps width/height. */
const PAPER_MM: Record<Exclude<PaperSizeId, 'custom'>, { width: number; height: number }> = {
  ticket_100x150: { width: 100, height: 150 },
  a4: { width: 210, height: 297 },
  a5: { width: 148, height: 210 },
  a6: { width: 105, height: 148 },
};

export const PAPER_PRESETS: PaperSizeId[] = ['ticket_100x150', 'a4', 'a5', 'a6', 'custom'];

// Studio-defined default (synced with the report layouts).
const SYNCED_DEFAULT_KEY = 'taghunter_print_prefs_synced_default';

export const DEFAULT_PRINT_PREFS: PrintPrefs = {
  // The legacy app printed the team report at 100×150mm - keep that default.
  paper: 'ticket_100x150',
  customMm: { width: 100, height: 150 },
  orientation: 'portrait',
};

/** Coerce a parsed unknown into valid prefs, filling holes from the built-in default. */
function normalizePrefs(parsed: Partial<PrintPrefs>): PrintPrefs {
  return {
    paper: PAPER_PRESETS.includes(parsed.paper as PaperSizeId) ? (parsed.paper as PaperSizeId) : DEFAULT_PRINT_PREFS.paper,
    customMm: {
      width: Number(parsed.customMm?.width) || DEFAULT_PRINT_PREFS.customMm.width,
      height: Number(parsed.customMm?.height) || DEFAULT_PRINT_PREFS.customMm.height,
    },
    orientation: parsed.orientation === 'landscape' ? 'landscape' : 'portrait',
  };
}

function readKey(key: string): PrintPrefs | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return normalizePrefs(JSON.parse(raw) as Partial<PrintPrefs>);
  } catch {
    return null;
  }
}

/** Where the default prefs come from (for the Settings → Printing info page). */
export type PrintPrefsSource = 'synced' | 'builtin';

export function getPrintPrefsInfo(): { prefs: PrintPrefs; source: PrintPrefsSource } {
  // Studio-synced default → built-in ticket default. (No device-local layer:
  // the PrePrintModal choice is per-print and never persisted.)
  const synced = readKey(SYNCED_DEFAULT_KEY);
  if (synced) return { prefs: synced, source: 'synced' };
  return { prefs: { ...DEFAULT_PRINT_PREFS }, source: 'builtin' };
}

export function getPrintPrefs(): PrintPrefs {
  return getPrintPrefsInfo().prefs;
}

/**
 * Record the studio-defined default print format (called by the sync when the
 * report layouts payload carries one). Null/invalid clears the synced default.
 */
export function setSyncedDefaultPrintPrefs(format: unknown): void {
  try {
    if (
      format && typeof format === 'object' &&
      PAPER_PRESETS.includes((format as Partial<PrintPrefs>).paper as PaperSizeId)
    ) {
      localStorage.setItem(SYNCED_DEFAULT_KEY, JSON.stringify(normalizePrefs(format as Partial<PrintPrefs>)));
    } else {
      localStorage.removeItem(SYNCED_DEFAULT_KEY);
    }
  } catch {
    /* localStorage may be unavailable; print just falls back to defaults */
  }
}

/** Portrait (width,height) in mm for the given prefs, before orientation swap. */
function basePaperMm(prefs: PrintPrefs): { width: number; height: number } {
  if (prefs.paper === 'custom') return prefs.customMm;
  return PAPER_MM[prefs.paper];
}

/** The CSS `@page { size: ... }` value, e.g. "100mm 150mm". */
export function cssPageSize(prefs: PrintPrefs): string {
  const { width, height } = basePaperMm(prefs);
  const [w, h] = prefs.orientation === 'landscape' ? [height, width] : [width, height];
  return `${w}mm ${h}mm`;
}
