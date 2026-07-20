/**
 * Mission-report layout model + per-game-type built-in defaults + resolver.
 *
 * A layout is a vertical stack of styled blocks rendered to print HTML by
 * `reportPrint.ts`. Resolution chain at print time:
 *   per-scenario override (game_meta.report_layout)
 *     → per-game-type global default (synced from studio - TODO, later phase)
 *       → built-in code default (this file).
 *
 * Block labels are NOT stored here: each block resolves its label from the
 * `report` i18n namespace in the TEAM's language at print time. Only `text`
 * blocks carry author-typed content.
 *
 * Design decision record: plan `team-mission-report-printing.md`.
 */

export type ReportGameType = 'mystery' | 'tracks' | 'tagquest' | 'clash';

/** Stat field ids available per game type (used inside `stat_grid` blocks). */
export const STAT_FIELDS_BY_TYPE: Record<ReportGameType, string[]> = {
  mystery: ['rate', 'success', 'fail', 'absent'],
  tracks: ['rate', 'correct', 'wrong', 'missing'],
  tagquest: ['quests', 'points', 'level', 'combos', 'players'],
  clash: ['territories', 'combos'],
};

export type BlockType =
  | 'logo'
  | 'game_title'
  | 'pdf_title'
  | 'team_name'
  | 'date'
  | 'duration'
  | 'score'
  | 'rank'
  | 'stat_grid'
  | 'text'
  // Structural blocks: `divider`/`spacer` are leaves; `row`/`frame` are
  // containers that hold other blocks in `children`.
  | 'divider'
  | 'spacer'
  | 'row'
  | 'frame';

export type Align = 'left' | 'center' | 'right';

export interface ReportBlock {
  type: BlockType;
  show: boolean;
  /** Font family override (bundled-catalog id); null ⇒ inherit layout font. */
  font?: string | null;
  /** Font size in px. */
  size?: number;
  color?: string;
  align?: Align;
  bold?: boolean;
  /** `stat_grid` only - the stat field ids to render as a labelled row. */
  fields?: string[];
  /** `text` only - author-typed content (single language for now). */
  text?: string;
  /** `logo` only - rendered width in px. */
  logoSize?: number;
  /** `divider` - line thickness in px (default 1). */
  thickness?: number;
  /** `divider` - line width as a % of the page (default 70). */
  width?: number;
  /** `spacer` - vertical gap height in px. */
  height?: number;
  /** `row` - horizontal gap between children in px (default 16). */
  gap?: number;
  /** `row` - horizontal distribution of children. */
  justify?: 'start' | 'center' | 'end' | 'between';
  /** `frame` - draw a border (default true). */
  bordered?: boolean;
  /** `frame` - border color (default #333333). */
  borderColor?: string;
  /** `frame` - background fill; empty/absent ⇒ transparent. */
  bgColor?: string;
  /** `frame` - inner padding in px (default 12). */
  padding?: number;
  /** `frame` - corner radius in px. */
  radius?: number;
  /** `row` / `frame` - nested blocks. */
  children?: ReportBlock[];
}

export interface ReportLayout {
  version: number;
  /** Default font family for the whole report (bundled-catalog id). */
  font: string;
  background: { mode: 'none' | 'color'; color?: string };
  blocks: ReportBlock[];
  /**
   * Per-game-type default report texts (designed in the studio "Report layouts"
   * page). The mission-report heading and the label printed above the team name.
   * A scenario overrides these via game_meta.pdf_title / game_meta.team_title;
   * a blank scenario value falls back to these.
   */
  pdfTitle?: string;
  teamTitle?: string;
  /**
   * Optional literal overrides for the standard block labels, keyed by label id
   * (`date`, `duration`, `score`, `rank`, and `stat_<field>`). A non-blank value
   * is printed verbatim in every language; blank / absent falls back to the
   * `report` i18n label resolved in the team's language.
   */
  labels?: Record<string, string>;
}

export const REPORT_LAYOUT_VERSION = 1;

const BASE_FONT = 'Times New Roman';

/**
 * Built-in default layout for a game type - mirrors the attached mystery
 * example (logo, game title, pdf_title, team name + label, date, then stat
 * grids) and swaps in each type's native stat fields.
 */
/** A bordered "frame" box wrapping the given stat grids (refined-classic look). */
function statFrame(children: ReportBlock[]): ReportBlock {
  return { type: 'frame', show: true, bordered: true, borderColor: '#333333', padding: 12, radius: 6, children };
}

export function defaultReportLayout(gameType: string): ReportLayout {
  const type = normalizeGameType(gameType);
  const fields = STAT_FIELDS_BY_TYPE[type];
  // The example renders taux+durée on one row, then the three counters on the
  // next. Split the field list 2 / rest to reproduce that shape generically.
  const firstRow = fields.slice(0, 2);
  const restRow = fields.slice(2);

  // Refined-classic structure: centered header, a divider rule, the team
  // identity, then the stats inside a bordered frame.
  const blocks: ReportBlock[] = [
    { type: 'logo', show: true, align: 'center', logoSize: 110 },
    { type: 'game_title', show: true, size: 30, align: 'center', bold: false },
    { type: 'pdf_title', show: true, size: 18, align: 'center', bold: false },
    { type: 'divider', show: true, thickness: 1, width: 70, color: '#cccccc' },
    { type: 'team_name', show: true, size: 22, align: 'center', bold: true },
    { type: 'date', show: true, size: 18, align: 'center', bold: true },
  ];
  // Mystery, tagquest and clash print the team's elapsed time; tracks omits it.
  if (type !== 'tracks') {
    blocks.push({ type: 'duration', show: true, size: 16, align: 'center', bold: true });
  }
  if (type === 'tracks' || type === 'mystery') {
    const grids: ReportBlock[] = [{ type: 'stat_grid', show: true, fields: firstRow, size: 16, align: 'center' }];
    if (restRow.length) grids.push({ type: 'stat_grid', show: true, fields: restRow, size: 16, align: 'center' });
    blocks.push(statFrame(grids));
  } else {
    // tagquest / clash: one combined grid.
    blocks.push(statFrame([{ type: 'stat_grid', show: true, fields, size: 16, align: 'center' }]));
  }

  return {
    version: REPORT_LAYOUT_VERSION,
    font: BASE_FONT,
    background: { mode: 'none' },
    blocks,
    pdfTitle: '',
    teamTitle: '',
  };
}

export function normalizeGameType(raw: string): ReportGameType {
  const v = (raw || '').toLowerCase();
  if (v === 'mystery' || v === 'tracks' || v === 'tagquest' || v === 'clash') return v;
  // tagquest is the historical default game type.
  return 'tagquest';
}

/** Narrow an unknown value (e.g. parsed game_meta JSON) to a valid layout. */
export function isReportLayout(value: unknown): value is ReportLayout {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ReportLayout>;
  return Array.isArray(v.blocks) && typeof v.font === 'string';
}

/**
 * Resolve the layout to print for a scenario. Resolution chain:
 *   per-scenario override (`scenarioMeta.report_layout`, object or JSON string)
 *     → synced per-game-type default (`syncedDefault`, from reportLayoutsStore)
 *       → built-in code default (this file).
 *
 * `syncedDefault` is optional so the function stays sync + offline-safe; callers
 * with DB access pass the studio-designed default they fetched.
 */
export function resolveReportLayout(
  gameType: string,
  scenarioMeta: Record<string, unknown> | null | undefined,
  syncedDefault?: ReportLayout | null,
): ReportLayout {
  const override = scenarioMeta?.report_layout;
  let parsed: unknown = override;
  if (typeof override === 'string') {
    try {
      parsed = JSON.parse(override);
    } catch {
      parsed = null;
    }
  }
  if (isReportLayout(parsed)) return parsed;
  if (syncedDefault && isReportLayout(syncedDefault)) return syncedDefault;
  return defaultReportLayout(gameType);
}
