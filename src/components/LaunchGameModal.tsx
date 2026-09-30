import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ChevronRight, ChevronLeft, Usb, Save, Upload, FileDown, Loader2 } from 'lucide-react';
import type { SiPuce } from '../types/database';
import * as cardsStore from '../services/cardsStore';
import * as cardsRepo from '../services/cardsRepo';
import * as patternStore from '../services/patternStore';
import * as scenarioStore from '../services/scenarioStore';
import * as gameTypesStore from '../services/gameTypesStore';
import * as clientPreferencesStore from '../services/clientPreferencesStore';
import * as launchConfigsStore from '../services/launchConfigsStore';
import * as namePoolsStore from '../services/namePoolsStore';
import {
  buildRoster,
  buildClashContiguousAssignments,
  extractTracksOptions,
  extractDefaultPatternId,
  resolveDefaultPattern,
  EMPTY_TRACKS_OPTIONS,
  type TracksLaunchOptions,
  type PatternOption,
} from '../services/launchResolve';
import { ConfirmDialog } from './ConfirmDialog';
import { RosterImportModal } from './RosterImportModal';
import {
  parseRosterFile,
  buildTemplateXlsx,
  RosterImportError,
  type RosterImportResult,
  type RosterImportMode,
} from '../services/rosterImport';
import { isOperatorOnly } from '../services/operatorMode';
import { DEFAULT_CLASH_PURGE_STATION } from '../services/clash';
import {
  listActiveLaunchedGames,
  getLaunchedGameState,
  listLaunchDevices,
  listBusyDeviceIds,
  type PairedDeviceStatusRow,
} from '../services/launchedGames';
import { useAuth } from './auth/AuthProvider';
import { HelpDot } from '../help';
import { LANG_NAMES, SUPPORTED_LANGS } from '../services/langFlags';
import { computeAutoRegAssignments, type RegAssignmentMap } from '../services/regAssignments';
import { displayDeviceLabel } from '../services/lanPairing';
import { RegAssignChips, type RegTeamDef } from './RegAssignChips';

export interface LaunchDeviceSelection {
  /** Whether to register the mother itself as a participating device. */
  include_self: boolean;
  /** paired_devices.id of every non-self peer to send a join_game command to. */
  satellite_targets: number[];
  /** Station-based self-register modes only: the resolved device_id →
   *  team_numbers registration assignment (persisted as meta.regAssignments).
   *  An EMPTY map means "deliberately no assignment" (the step-3 toggle is off)
   *  and must be honoured as-is. Only `undefined` means "nobody decided" ⇒ the
   *  launch path auto-assigns (headless Quick Launch). The wizard always sets
   *  it, so it never leaves this ambiguous. */
  reg_assignments?: RegAssignmentMap;
}

// Walk a `Localized<>` map shape - `{ en: '...', fr: '...' }` - looking for
// every language key that has at least one non-empty value across the whole
// gameMeta. Used to populate the launch language picker so we only offer
// languages the scenario actually has translations for.
//
// The key must be a KNOWN language code, not just any 2-letter key - otherwise
// ubiquitous fields like `id: "123"` get mistaken for a language (Indonesian),
// surfacing a bogus "id (id)" option and falsely enabling the flag picker.
function collectScenarioLanguages(value: unknown, found: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) collectScenarioLanguages(v, found);
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (SUPPORTED_LANGS.includes(k) && typeof v === 'string' && v.trim().length > 0) {
      found.add(k);
    } else {
      collectScenarioLanguages(v, found);
    }
  }
}

// The authoritative language list studio writes alongside the data. Prefer this
// over walking for Localized keys: on disk (post playground.php compat) the
// translatable fields are flattened to default-lang strings and the per-language
// copies live in a `translations` envelope, so the tree-walk under-reports.
function extractAvailableLanguages(rawGameData: unknown): string[] {
  if (!rawGameData || typeof rawGameData !== 'object') return [];
  const root = rawGameData as Record<string, unknown>;
  const candidates: unknown[] = [
    root.available_languages,
    (root.scenario as { available_languages?: unknown } | undefined)?.available_languages,
    (root.game_data as { available_languages?: unknown } | undefined)?.available_languages,
    (root.game_meta as { available_languages?: unknown } | undefined)?.available_languages,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      const langs = c.filter((x): x is string => typeof x === 'string' && SUPPORTED_LANGS.includes(x));
      if (langs.length > 0) return langs;
    }
  }
  return [];
}

function extractDefaultLanguage(rawGameData: unknown): string | null {
  if (!rawGameData || typeof rawGameData !== 'object') return null;
  const root = rawGameData as Record<string, unknown>;
  const candidates: unknown[] = [
    root.default_language,
    (root.scenario as { default_language?: unknown } | undefined)?.default_language,
    (root.game_data as { default_language?: unknown } | undefined)?.default_language,
    (root.game_meta as { default_language?: unknown } | undefined)?.default_language,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length === 2) return c;
  }
  return null;
}

// ---------------------------------------------------------------- Tracks
// Tracks launch options are parsed from the scenario's game_meta. The editor
// enables a subset of each group; the operator picks one at launch. Labels
// mirror the studio's RoutesSection / DisplaysSection / etc. copy.
// The values here are i18next keys (in the `launchModal` namespace), resolved
// to display copy at the call sites via `t()`.
export const TRACKS_ROUTE_LABELS: Record<string, string> = {
  default: 'launchModal:routeDefault',
  reverse: 'launchModal:routeReverse',
  first_half: 'launchModal:routeFirstHalf',
  last_half: 'launchModal:routeLastHalf',
  odd: 'launchModal:routeOdd',
  even: 'launchModal:routeEven',
};
export const TRACKS_DISPLAY_LABELS: Record<string, string> = {
  full: 'launchModal:displayFull',
  map: 'launchModal:displayMap',
  simple: 'launchModal:displaySimple',
};
export const TRACKS_PLAY_MODE_LABELS: Record<string, string> = {
  itinerary: 'launchModal:playModeItinerary',
  free: 'launchModal:playModeFree',
};
export const TRACKS_SCORE_TYPE_LABELS: Record<string, string> = {
  percentage: 'launchModal:scoreTypePercentage',
  points: 'launchModal:scoreTypePoints',
};

/** Compact radio group for a tracks launch option. Hidden when ≤1 option (auto-selected).
 *  `disabledKeys` greys out choices that don't apply to the current setup (kept
 *  visible, with `hint` explaining why, instead of silently disappearing). */
export function TracksRadioGroup({
  label,
  name,
  options,
  value,
  onChange,
  helpDot,
  disabledKeys,
  hint,
}: {
  label: string;
  name: string;
  options: Array<{ key: string; label: string }>;
  value: string;
  onChange: (key: string) => void;
  helpDot?: React.ReactNode;
  disabledKeys?: string[];
  hint?: string;
}) {
  if (options.length <= 1) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <label className="pg-label !mb-0">{label}</label>
        {helpDot}
      </div>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const disabled = !!disabledKeys?.includes(o.key);
          return (
            <label
              key={o.key}
              className={`px-3 py-2 rounded-lg border-2 text-sm transition-all ${
                disabled
                  ? 'border-[var(--pg-line)] bg-[var(--pg-surface-2)] text-[var(--pg-text-dim)] opacity-50 cursor-not-allowed'
                  : value === o.key
                    ? 'border-[var(--pg-accent-line)] bg-[var(--pg-accent-tint)] text-[var(--pg-accent-bright)] cursor-pointer'
                    : 'border-[var(--pg-line)] bg-[var(--pg-surface-2)] text-[var(--pg-text-muted)] hover:border-[var(--pg-line-strong)] cursor-pointer'
              }`}
            >
              <input
                type="radio"
                name={name}
                value={o.key}
                checked={value === o.key}
                disabled={disabled}
                onChange={() => {
                  if (!disabled) onChange(o.key);
                }}
                className="sr-only"
              />
              {o.label}
            </label>
          );
        })}
      </div>
      {hint && <p className="text-xs text-[var(--pg-text-dim)]">{hint}</p>}
    </div>
  );
}

/** Multi-select variant for tracks routes. Hidden when ≤1 option (the single
 *  route is auto-selected). At least one option must stay checked. */
export function TracksCheckboxGroup({
  label,
  options,
  value,
  onChange,
  hint,
}: {
  label: string;
  options: Array<{ key: string; label: string }>;
  value: string[];
  onChange: (keys: string[]) => void;
  hint?: string;
}) {
  if (options.length <= 1) return null;
  const toggle = (key: string) => {
    const set = new Set(value);
    if (set.has(key)) {
      // Don't allow unchecking the last remaining route.
      if (set.size <= 1) return;
      set.delete(key);
    } else {
      set.add(key);
    }
    // Preserve declaration order so team assignment is deterministic.
    onChange(options.map((o) => o.key).filter((k) => set.has(k)));
  };
  return (
    <div className="space-y-2">
      <label className="pg-label !mb-0">{label}</label>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const checked = value.includes(o.key);
          return (
            <label
              key={o.key}
              className={`px-3 py-2 rounded-lg border-2 cursor-pointer text-sm transition-all ${
                checked
                  ? 'border-[var(--pg-accent-line)] bg-[var(--pg-accent-tint)] text-[var(--pg-accent-bright)]'
                  : 'border-[var(--pg-line)] bg-[var(--pg-surface-2)] text-[var(--pg-text-muted)] hover:border-[var(--pg-line-strong)]'
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(o.key)}
                className="sr-only"
              />
              {o.label}
            </label>
          );
        })}
      </div>
      {hint && <p className="text-xs text-[var(--pg-text-dim)]">{hint}</p>}
    </div>
  );
}

interface LaunchGameModalProps {
  isOpen: boolean;
  onClose: () => void;
  gameTitle: string;
  gameUniqid: string;
  gameTypeName: string;
  onLaunch: (config: GameConfig, deviceSelection: LaunchDeviceSelection) => void | Promise<void>;
  /** Seed step-1 from a saved config (Edit a config, or headless critical-fallback). */
  prefillConfig?: Partial<GameConfig>;
  /** When editing an existing config, its current name (seeds the Save field). */
  prefillConfigName?: string;
  /** Amber banner shown atop step 1 - e.g. the reason a headless launch fell back here. */
  noticeText?: string;
  /** Fired after a config is saved so the host can refresh counts / toast. */
  onConfigSaved?: (name: string) => void;
}

export interface GameConfig {
  name: string;
  numberOfTeams: number;
  firstChipIndex: number;
  /** Manual-roster path (all game types): pre-fill the step-2 team names from the
   *  scenario's audience name pool instead of the cards' key_name. Purely a UI
   *  convenience applied when building / re-rolling the roster - the names are
   *  baked into `teams`, so nothing server-side depends on this flag. */
  nameFromPool?: boolean;
  pattern: string;
  duration: number;
  messageDisplayDuration: number;
  enigmaImageDisplayDuration: number;
  colorblindMode: boolean;
  /** Mystery: relabeled "Auto-reset page" - auto-return the display to ready after results. */
  autoResetTeam: boolean;
  /** Mystery: once a team's results summary is on screen, pressing Enter resets
   *  the display (same as the on-screen refresh button). Defaults to true. */
  enterToReset?: boolean;
  /** Seconds the results stay on screen before the auto page-reset (when autoResetTeam). */
  delayBeforeReset: number;
  /** Mystery: show the author-placed idle layout (title + subtitle) on the
   *  between-teams screen. When off, the idle screen shows the background only. */
  showIdleLayout?: boolean;
  /** Mystery: subtitle text shown on the idle (between-teams) screen, under the
   *  scenario title. Only used when showIdleLayout is on and the scenario's idle
   *  layout enables the subtitle element.
   *  Leave blank to hide the subtitle (the title still shows). */
  idleSubtitle?: string;
  /** Mystery+tracks: no roster pre-built; each registered card's first bip creates+starts a team. */
  autoRegisterTeam?: boolean;
  /** Mystery+tracks: a finished card can start a fresh run after the cooldown. */
  reuseCards?: boolean;
  /** Mystery+tracks: mass start (all teams start together) vs staggered starts
   *  (départs différés, the default - each team starts on its own first bip).
   *  Mass start pre-registers the roster (autoRegisterTeam off, counts on step 2)
   *  and is incompatible with self-registration, so selecting it forces
   *  selfRegisterTeam off. Tracks multi-route launches use their own fixed-roster
   *  flow instead (selecting 2+ parcours resets this to false). */
  massStart?: boolean;
  /** Mystery+tracks: each team types its own name on its first bip. Implies dynamic
   *  team mode (no roster) - the bip creates the team, then prompts for the name. */
  selfRegisterTeam?: boolean;
  /** Minutes after a card finishes before it can be reused (when reuseCards). */
  reuseDelayMinutes?: number;
  /** Mystery+tracks: draw a fun pooled team name (by audience+language) instead of the card's key_name.
   *  Mutually exclusive with selfRegisterTeam (both children of autoRegisterTeam). */
  useNamePool?: boolean;
  /** Audience for the name pool draw - always derived from the scenario's game_public
   *  (no manual override). Persisted so the server-side draw keeps working.
   *  Canonical trio mirrors studio's src/types/audience.ts. */
  namePoolAudience?: 'mini_kids' | 'kids' | 'ado_adultes';
  /** Self-register child: show a "Choose my team name for me" button in the overlay
   *  that draws a pooled name (scenario audience + the player's/launch language). */
  addRandomNameOption?: boolean;
  /** Self-register child: let the player pick their team's display language via flag
   *  radios in the overlay. Only offered when the scenario ships 2+ languages. */
  allowPlayerLanguageChoice?: boolean;
  /** The scenario's available languages (2-letter codes). Carried so the runtime
   *  self-register overlay can offer the flag radios. Persisted as meta.availableLanguages. */
  scenarioLanguages?: string[];
  victoryType?: 'speed' | 'score';
  playMode?: 'solo' | 'team';
  teammatesPerTeam?: number;
  testMode?: boolean;
  teams?: Team[];
  /** Tagquest: seconds to keep the result (full image + score) on screen after
   *  each punch animation completes, before the page resets to its hidden state. */
  visibilityHideDelaySec?: number;
  /** Selected language code from the launch picker (drives translations + video subtitles). */
  language?: string;
  /** Play tutorial video on each team's first bip (mystery/tracks only). Off if no video exists. */
  playTutorialOnBip?: boolean;
  /** Play intro video (per-scenario scenario_video) on each team's first bip. Off if scenario has none. */
  playIntroOnBip?: boolean;
  /** Tracks: the selected route key(s). `route` carries the primary/fallback
   *  (always the first of `routes`); `routes` carries the full multi-selection.
   *  When 2+ routes are selected, auto-register is disabled and each team is
   *  assigned a route in order (team N → routes[(N-1) % routes.length]). */
  route?: string;
  /** Tracks: the operator-selected route set (1+). With 2+ entries the launch is
   *  multi-route: teams are assigned a route in order on the team-config step. */
  routes?: string[];
  /** Tracks: the studio-enabled route set, persisted so the Add Team form can
   *  offer a per-team route override. */
  tracksRoutes?: string[];
  /** Tracks: selected display mode (full | map | simple). */
  displayMode?: string;
  /** Tracks: selected play mode (itinerary | free). Named distinctly from tagquest's `playMode`. */
  trackPlayMode?: 'itinerary' | 'free';
  /** Tracks: selected score type (percentage | points). */
  scoreType?: 'percentage' | 'points';
  /** Tracks: malus subtracted per minute over the time limit (points or %). */
  malusPerMinute?: number;
  /** Tracks: "clues page on team return" - on the second bip after a team
   *  returns, show the map with every checkpoint revealed (no per-checkpoint
   *  animation). Was a studio scenario option; now chosen per launch. */
  cluesPage?: { enabled: boolean; show_title: boolean; show_text: boolean; show_image: boolean };
  /** Clash: number of active clans (2-4). */
  clashNumClans?: number;
  /** Clash: max players per clan; 0/undefined ⇒ unlimited. */
  clashMaxPerClan?: number;
  /** Clash "Équipes prédéfinies" (clashRegistrationMode==='bulk'): how many
   *  contiguous chips to deal to EACH clan, uniformly (mirrors TagQuest's
   *  teammatesPerTeam). 0/undefined ⇒ none pre-dealt. Consumed at launch to
   *  build the clan blocks; not needed by the runtime. */
  clashChipsPerClan?: number;
  /** Clash: how players bind to a clan at runtime. 'self' = live on the
   *  registration screen; 'bulk' = predefined clans dealt at launch. */
  clashRegistrationMode?: 'self' | 'bulk';
  /** Clash: per-territory physical balise station codes, pre-filled from the
   *  scenario and overridable per venue at launch (replaces the old pattern). */
  clashBalises?: number[][];
  /** Clash: chip→clan assignments imported from Excel/CSV. Applied AFTER launch
   *  (clans/team_ids only exist post-launch) via clashRegister. clanIndex is the
   *  1..N clan number (matches team_number). */
  clashChipAssignments?: Array<{ chipId: number; chipNumber: number; clanIndex: number; name?: string }>;
  /** Clash "The Purge": launch toggle, default ON - only offered when the
   *  scenario has a purge image (forced off otherwise, no built-in fallback). */
  clashPurgeEnabled?: boolean;
  /** Clash "The Purge": physical SI station whose punch attempts a purge.
   *  Default 25; must not collide with any territory balise station. */
  clashPurgeStation?: number;
  /** TagQuest: when true the roster is NOT pre-built - players bind their chip
   *  to a team at game start on the registration screen (mirrors Clash's
   *  clashRegistrationMode='self'). Team mode → predefined named teams players
   *  join (reuses the server clash_register / lg_clash_members binding). Solo
   *  mode → each bipped chip enrolls itself as its own team on the fly. */
  tagquestSelfRegister?: boolean;
  /** TagQuest self-register (team mode): max players per team; 0/undefined ⇒
   *  unlimited. Persisted into clash_config.max_per_clan so the mother enforces
   *  the cap in clash_register, exactly like Clash. */
  tagquestMaxPerTeam?: number;
  /** TagQuest self-register (team mode): the predefined team display names, one
   *  per team (numberOfTeams). Seeded "Équipe N" and editable at launch. */
  tagquestTeamNames?: string[];
  /** TagQuest: show the quest images as a low-opacity ghost grid at the start of
   *  every punch animation (before the one-by-one reveal). Off ⇒ unrevealed slots
   *  are invisible instead of dimmed - the staggered reveal itself is unchanged.
   *  Defaults from the scenario's audience: on for mini_kids/kids, off for
   *  ado_adultes. Missing in meta ⇒ true (pre-feature games keep the ghost). */
  tagquestShowQuestPreview?: boolean;
  /** TagQuest: on a partial combination, draw the visual of each station still
   *  missing (dimmed, red ring). Off ⇒ a missing slot stays blank, so finding
   *  WHICH station is missing is part of the game (retours sept #55). Missing
   *  in meta ⇒ true (pre-feature games keep the visuals). */
  tagquestShowMissingStations?: boolean;
  /** TagQuest (score victory + team mode only): weight each team's earned
   *  points by largest-headcount ÷ own-headcount so uneven team sizes compete
   *  fairly - the same effectif rule Clash applies. Default on. Missing in
   *  meta ⇒ false (pre-feature games keep raw scores). See tagquestScoring.ts. */
  tagquestScoreWeighting?: boolean;
}

export interface Teammate {
  chipId: number;
  chipNumber: number;
  name: string;
}

export interface Team {
  chipId: number;
  chipNumber: number;
  name: string;
  teammates?: Teammate[];
  /** Per-team display language (2-letter ISO). Defaults to the launch language. */
  language?: string;
  /** Tracks multi-route launch: this team's assigned route key. Persisted at
   *  launch as a `route:{teamId}` meta override (read by the tracks runtime). */
  route?: string;
}

// Canonical audience trio for the name-pool draw - mirrors studio's
// src/types/audience.ts (game_meta.game_public). Legacy values fold onto it.
type NamePoolAudience = 'mini_kids' | 'kids' | 'ado_adultes';
function normalizeGamePublic(raw: unknown): NamePoolAudience {
  const v = String(raw ?? '').toLowerCase();
  if (['adults', 'adult', 'adultes', 'teens', 'ado'].includes(v)) return 'ado_adultes';
  if (v === 'mini_kids' || v === 'ado_adultes') return v;
  return 'kids';
}

export function LaunchGameModal({
  isOpen,
  onClose,
  gameTitle,
  gameUniqid,
  gameTypeName,
  onLaunch,
  prefillConfig,
  prefillConfigName,
  noticeText,
  onConfigSaved,
}: LaunchGameModalProps) {
  const { t } = useTranslation();
  const { user } = useAuth();

  const getDefaultName = () => {
    const now = new Date();
    const date = now.toLocaleDateString('fr-FR');
    const time = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return `${gameTitle} ${date} ${time}`;
  };

  const [config, setConfig] = useState<GameConfig>({
    name: '',
    numberOfTeams: 1,
    firstChipIndex: 1,
    pattern: '',
    duration: 60,
    messageDisplayDuration: 5,
    enigmaImageDisplayDuration: 1,
    colorblindMode: false,
    autoResetTeam: true,
    delayBeforeReset: 10,
    enterToReset: false,
    showIdleLayout: true,
    idleSubtitle: '',
    autoRegisterTeam: false,
    reuseCards: false,
    massStart: false,
    selfRegisterTeam: false,
    reuseDelayMinutes: 5,
    victoryType: 'score',
    playMode: 'team',
    teammatesPerTeam: 2,
    testMode: false,
    visibilityHideDelaySec: 10,
    tagquestSelfRegister: false,
    tagquestMaxPerTeam: 0,
    tagquestShowQuestPreview: true,
    tagquestShowMissingStations: true,
    tagquestScoreWeighting: true,
  });
  const [patternFolders, setPatternFolders] = useState<PatternOption[]>([]);
  const [defaultPattern, setDefaultPattern] = useState<string>('');
  const [step, setStep] = useState<1 | 2 | 3>(1);
  // Step-3 state - the paired-device picker. Loaded lazily when the user
  // advances to step 3; reset on modal close so a fresh open doesn't show
  // stale online indicators.
  const [pairedDevices, setPairedDevices] = useState<PairedDeviceStatusRow[]>([]);
  // THIS device's row in pairedDevices. Not the `is_self` row: the list comes
  // from the mother's db, where `is_self` is the MOTHER - on a child (e.g. an
  // operator-only tablet) the mother is just another launch target.
  const [selfDeviceId, setSelfDeviceId] = useState<number | null>(null);
  // Child talking to an older mother build: it can't say which row is us, and
  // it refuses a join_game aimed at itself - so its row is not a launch target.
  const [motherOutdated, setMotherOutdated] = useState(false);
  const [pairedLoading, setPairedLoading] = useState(false);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<number>>(new Set());
  const [motherChecked, setMotherChecked] = useState(true);
  // Station-based self-register modes: per-device registration-team overrides.
  // Auto-until-touched - a device with no entry shows (and launches with) the
  // live round-robin auto-deal; an entry pins the operator's explicit choice
  // and survives team/device changes until reset to auto.
  const [regOverrides, setRegOverrides] = useState<Map<number, number[]>>(new Map());
  // The per-device assignment UI is opt-in: OFF by default so the common case
  // (every device shows the full team grid) stays uncluttered. Launching with
  // the switch off sends no assignments; pinned overrides are kept in memory
  // so flipping the switch back on restores them.
  const [regAssignActive, setRegAssignActive] = useState(false);
  // Operator-only device: this machine never participates in games. When true
  // the "this device participates" checkbox is forced off + disabled.
  const [operatorOnly, setOperatorOnly] = useState(false);
  // paired_devices.id of devices already running another active game - these
  // can't be selected here (one game per device). The launching device itself
  // can still dispatch; it just can't also *participate* if it's busy.
  const [busyDeviceIds, setBusyDeviceIds] = useState<Set<number>>(new Set());
  const [scenarioLanguages, setScenarioLanguages] = useState<string[]>([]);
  const [scenarioDefaultLang, setScenarioDefaultLang] = useState<string>('en');
  // Clash: scenario territories (name + points) for the launch-time balise
  // override grid. Editable station codes live in config.clashBalises.
  const [clashTerritories, setClashTerritories] = useState<
    Array<{ index: number; name: string; points: number }>
  >([]);
  // Clash: per-territory balise station codes pre-filled from the scenario,
  // seeded into the launch config (the isOpen effect reads it from state).
  const [clashBalisesSeed, setClashBalisesSeed] = useState<number[][]>([]);
  // Clash: scenario-authored clan display names, indexed 0..N-1. Used to build
  // the import's clan set (resolve a "clan" cell by number or name).
  const [clashClanNames, setClashClanNames] = useState<string[]>([]);
  // Clash "The Purge": the feature is only offered when the scenario ships a
  // purge image (game_meta.purge_image) - no built-in fallback marker exists.
  const [clashHasPurgeImage, setClashHasPurgeImage] = useState(false);
  // Clash "The Purge": the scenario-authored purge station (game_meta
  // .purge_station). Since retours #50 the author picks it in Studio - where
  // the territory picker reserves it - and this launch field just prefills
  // from it. Falls back to the historic 25 for pre-#50 scenarios.
  const [clashPurgeStationSeed, setClashPurgeStationSeed] = useState<number>(
    DEFAULT_CLASH_PURGE_STATION,
  );
  // Scenario's audience (game_meta.game_public) - default for the name-pool draw.
  const [scenarioPublic, setScenarioPublic] = useState<NamePoolAudience>('kids');
  // Scenario-authored timing defaults (game_meta) that prefill the launch fields:
  // message_display_time -> messageDisplayDuration, animation_enigma_duration ->
  // enigmaImageDisplayDuration. Operator can still override per launch.
  const [scenarioMessageDisplayTime, setScenarioMessageDisplayTime] = useState<number>(5);
  const [scenarioEnigmaDuration, setScenarioEnigmaDuration] = useState<number>(1);
  const [hasTutorialVideo, setHasTutorialVideo] = useState(false);
  const [hasIntroVideo, setHasIntroVideo] = useState(false);
  const [prefTutorialDefault, setPrefTutorialDefault] = useState(false);
  const [prefIntroDefault, setPrefIntroDefault] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  // Clash "Équipes prédéfinies": the operator's hand-edited chip→clan allocation
  // (step 2). null = follow the automatic contiguous deal (or an Excel import),
  // recomputed live from the numbers; the first manual edit pins the whole list.
  const [clashManualAssignments, setClashManualAssignments] = useState<
    Array<{ chipId: number; chipNumber: number; clanIndex: number; name?: string }> | null
  >(null);
  // Candidate pooled team names for the scenario's audience + launch language,
  // split into the client's own list and the default catalog so the bulk
  // "Utiliser les noms de la liste" assignment prefers the client's names and
  // only completes from the default pool when the client list is too short.
  // Empty when no pool file is synced - the pool controls hide in that case.
  const [poolNamesClient, setPoolNamesClient] = useState<string[]>([]);
  const [poolNamesGlobal, setPoolNamesGlobal] = useState<string[]>([]);
  const [tracksOptions, setTracksOptions] = useState<TracksLaunchOptions>(EMPTY_TRACKS_OPTIONS);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Mystery shows the pattern read-only behind a "Modify" toggle so the
  // scenario's own pattern isn't changed by accident.
  const [editPattern, setEditPattern] = useState(false);
  // Tracks: checkpoint count from game_meta + a warning when the selected
  // pattern's row count doesn't match it (the checkpoint↔station binding is
  // positional, so a mismatch silently misaligns scoring).
  const [tracksCheckpointCount, setTracksCheckpointCount] = useState(0);
  const [tracksPatternWarning, setTracksPatternWarning] = useState('');
  const [availableChips, setAvailableChips] = useState<SiPuce[]>([]);
  const [onDemandChips, setOnDemandChips] = useState<SiPuce[]>([]);
  const [hasOnDemandCards, setHasOnDemandCards] = useState(false);
  const [useOnDemandCards, setUseOnDemandCards] = useState(false);
  const [usedChipIds, setUsedChipIds] = useState<Set<number>>(new Set());
  // Save-configuration UI (step 1). The inline name field appears when the
  // operator clicks "Save configuration"; saving does NOT launch.
  const [showSaveField, setShowSaveField] = useState(false);
  const [configName, setConfigName] = useState('');
  const [savePending, setSavePending] = useState(false);
  const [overwriteConfirm, setOverwriteConfirm] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  // Step-3 launch in flight. The ref is the real guard (a double-click fires
  // two submits before React re-renders the disabled button); the state drives
  // the spinner.
  const [launching, setLaunching] = useState(false);
  const launchingRef = useRef(false);
  // Excel/CSV roster import (step 2). The hidden file input is triggered by the
  // Import button; a successful parse opens the preview/confirm modal.
  const rosterFileInputRef = useRef<HTMLInputElement>(null);
  const clashFileInputRef = useRef<HTMLInputElement>(null);
  const [importResult, setImportResult] = useState<RosterImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    void isOperatorOnly().then(setOperatorOnly).catch(() => setOperatorOnly(false));
  }, []);

  // Load pooled team names for the scenario's audience + the launch language
  // (falling back to the scenario default). Refreshes when the language changes.
  useEffect(() => {
    let cancelled = false;
    const lang = config.language ?? scenarioDefaultLang;
    namePoolsStore
      .listPoolNamesTiered(scenarioPublic, lang)
      .then((tiers) => {
        if (cancelled) return;
        setPoolNamesClient(tiers.client);
        setPoolNamesGlobal(tiers.global);
      })
      .catch(() => {
        if (cancelled) return;
        setPoolNamesClient([]);
        setPoolNamesGlobal([]);
      });
    return () => { cancelled = true; };
  }, [scenarioPublic, config.language, scenarioDefaultLang]);

  useEffect(() => {
    const loadData = async () => {
      if (!gameTypeName || !gameUniqid) return;

      const gameTypeLc = gameTypeName.toLowerCase();
      const [rows, rawGameData] = await Promise.all([
        patternStore.list({ gameType: gameTypeLc }),
        scenarioStore.getGameData(gameUniqid),
      ]);

      const options: PatternOption[] = rows.map(r => ({
        slug: r.pattern_slug ?? r.pattern_uniqid,
        name: r.name || r.pattern_slug || r.pattern_uniqid,
        uniqid: r.pattern_uniqid,
        isDefault: r.is_default,
      }));
      setPatternFolders(options);

      // Pre-select the scenario's own default pattern, else the game type's
      // is_default pattern, else the first - a wrong pre-selected pattern
      // silently breaks scoring (no station ever matches a punch).
      setDefaultPattern(resolveDefaultPattern(options, extractDefaultPatternId(rawGameData)));

      // Discover the scenario's languages. Prefer the authoritative
      // `available_languages` array studio writes; fall back to walking for
      // Localized keys only when it's absent (older/partial data). Default to the
      // scenario's declared default_language; fall back to 'en' if neither
      // exists. Empty set means no localization - picker stays hidden.
      let sortedLangs = extractAvailableLanguages(rawGameData);
      if (sortedLangs.length === 0) {
        const langs = new Set<string>();
        collectScenarioLanguages(rawGameData, langs);
        sortedLangs = Array.from(langs).sort();
      }
      setScenarioLanguages(sortedLangs);
      const defaultLang = extractDefaultLanguage(rawGameData) || sortedLangs[0] || 'en';
      setScenarioDefaultLang(defaultLang);

      // Clash: parse territories → grid labels + pre-filled balise station codes.
      const gmClash =
        ((rawGameData as { game_meta?: Record<string, unknown> } | null)?.game_meta
          ?? (rawGameData as { game_data?: { game_meta?: Record<string, unknown> } } | null)?.game_data
            ?.game_meta) ?? {};
      const terrArr = Array.isArray((gmClash as { territories?: unknown }).territories)
        ? ((gmClash as { territories: unknown[] }).territories)
        : [];
      const resolveTerrName = (n: unknown): string =>
        typeof n === 'string'
          ? n
          : n && typeof n === 'object'
            ? String(
                (n as Record<string, string>)[defaultLang] ??
                  Object.values(n as Record<string, string>)[0] ??
                  '',
              )
            : '';
      const clashBalisesInit: number[][] = terrArr.map((t) =>
        Array.isArray((t as { balises?: unknown }).balises)
          ? ((t as { balises: unknown[] }).balises).map(Number).filter((x) => !Number.isNaN(x))
          : [],
      );
      setClashBalisesSeed(clashBalisesInit);
      setClashTerritories(
        terrArr.map((t, i) => ({
          index: i,
          name: resolveTerrName((t as { name?: unknown }).name) || `T${i + 1}`,
          points: parseInt(String((t as { points?: unknown }).points ?? '0'), 10) || 0,
        })),
      );
      // Clan display names (same localisation shape as territory names).
      const clansArr = Array.isArray((gmClash as { clans?: unknown }).clans)
        ? ((gmClash as { clans: unknown[] }).clans)
        : [];
      setClashClanNames(clansArr.map((c) => resolveTerrName((c as { name?: unknown }).name)));
      setClashHasPurgeImage(
        typeof (gmClash as { purge_image?: unknown }).purge_image === 'string' &&
          ((gmClash as { purge_image: string }).purge_image).length > 0,
      );
      const authoredPurgeStation = parseInt(
        String((gmClash as { purge_station?: unknown }).purge_station ?? ''),
        10,
      );
      setClashPurgeStationSeed(
        Number.isFinite(authoredPurgeStation) && authoredPurgeStation > 0
          ? authoredPurgeStation
          : DEFAULT_CLASH_PURGE_STATION,
      );

      // Audience for name-pool draws: scenario's game_meta.game_public, folded
      // onto the canonical trio (legacy 'adults'/'teens' -> 'ado_adultes').
      const gp = (rawGameData as { game_meta?: { game_public?: unknown } } | null)?.game_meta?.game_public;
      setScenarioPublic(normalizeGamePublic(gp));

      // Scenario-authored timing defaults → prefill the launch fields. Both live
      // in game_meta (top-level or under legacy game_data.game_meta). Fall back
      // to the historic launch defaults (5s / 1s) when unset or non-positive.
      const gmTiming =
        (rawGameData as { game_meta?: Record<string, unknown> } | null)?.game_meta
        ?? (rawGameData as { game_data?: { game_meta?: Record<string, unknown> } } | null)?.game_data?.game_meta;
      const msgTime = parseInt(String(gmTiming?.message_display_time ?? ''), 10);
      setScenarioMessageDisplayTime(Number.isFinite(msgTime) && msgTime > 0 ? msgTime : 5);
      const enigDur = parseInt(String(gmTiming?.animation_enigma_duration ?? ''), 10);
      setScenarioEnigmaDuration(Number.isFinite(enigDur) && enigDur > 0 ? enigDur : 1);

      // Tracks: parse the enabled route/display/play_mode/score_type sets +
      // default time/malus from game_meta. No-op (empty) for other types.
      if (gameTypeLc === 'tracks') {
        setTracksOptions(extractTracksOptions(rawGameData));
        const gm = (rawGameData as { game_meta?: { checkpoints?: unknown } } | null)?.game_meta
          ?? (rawGameData as { game_data?: { game_meta?: { checkpoints?: unknown } } } | null)?.game_data?.game_meta;
        const cps = gm?.checkpoints;
        setTracksCheckpointCount(Array.isArray(cps) ? cps.length : 0);
      } else {
        setTracksOptions(EMPTY_TRACKS_OPTIONS);
        setTracksCheckpointCount(0);
      }

      // Resolve game-type capabilities + whether tutorial/intro videos are
      // actually available locally so we know whether to render each toggle.
      const gameTypeLcLocal = gameTypeName.toLowerCase();
      const gt = await gameTypesStore.getGameType(gameTypeLcLocal);
      const resolvedTutorial = await gameTypesStore.resolveTutorialVideoUrl(gameTypeLcLocal);
      setHasTutorialVideo(!!gt?.supports_tutorial_video && resolvedTutorial !== null);

      // Intro video = per-scenario scenario_video. Probe game-data for either
      // a top-level `scenario_video` (post-Stage-3) or legacy `medias.video`.
      const introCandidate =
        (rawGameData as { scenario_video?: unknown } | null)?.scenario_video
        ?? ((rawGameData as { game_meta?: { scenario_video?: unknown } } | null)?.game_meta?.scenario_video)
        ?? ((rawGameData as { medias?: { video?: unknown } } | null)?.medias?.video);
      const hasIntro = typeof introCandidate === 'string' && introCandidate.trim().length > 0;
      setHasIntroVideo(!!gt?.supports_intro_video && hasIntro);

      // Pre-fill the toggles from the client's saved preferences.
      if (user?.client_id) {
        const pref = await clientPreferencesStore.getGamePref(user.client_id, gameTypeLcLocal);
        setPrefTutorialDefault(!!pref.play_tutorial_default);
        setPrefIntroDefault(!!pref.play_intro_default);
      }
    };
    loadData();
  }, [gameTypeName, gameUniqid, user?.client_id]);

  useEffect(() => {
    if (isOpen) {
      const isTracksType = gameTypeName.toLowerCase() === 'tracks';
      const isMysteryType = gameTypeName.toLowerCase() === 'mystery';
      // Tracks default selections: first enabled key in declaration order;
      // score type uses the `default`-flagged one, falling back to first enabled.
      const defaultScoreType =
        tracksOptions.scoreTypes.find((s) => s.isDefault)?.key ??
        tracksOptions.scoreTypes[0]?.key;
      setConfig({
        numberOfTeams: 10,
        firstChipIndex: 1,
        pattern: defaultPattern,
        duration: isTracksType ? tracksOptions.defaultTime : (isMysteryType ? 90 : 60),
        messageDisplayDuration: scenarioMessageDisplayTime,
        enigmaImageDisplayDuration: scenarioEnigmaDuration,
        colorblindMode: false,
        autoResetTeam: true,
        delayBeforeReset: 10,
        enterToReset: false,
        showIdleLayout: true,
        idleSubtitle: '',
        // Mystery and Tracks teams both form dynamically on first bip - there is
        // no pre-built roster by default, so auto-register is implicit (the launch
        // UI exposes only the name-source choice, never an on/off toggle). A fixed
        // roster is reached only via Import roster or, for Tracks, selecting 2+
        // parcours (which forces auto-register off further down).
        autoRegisterTeam: isMysteryType || isTracksType,
        reuseCards: false,
        massStart: false,
        selfRegisterTeam: false,
        reuseDelayMinutes: 5,
        useNamePool: false,
        namePoolAudience: scenarioPublic,
        victoryType: 'score',
        playMode: 'team',
        teammatesPerTeam: 2,
        testMode: false,
        visibilityHideDelaySec: 10,
        language: scenarioDefaultLang,
        playTutorialOnBip: hasTutorialVideo && prefTutorialDefault,
        playIntroOnBip: hasIntroVideo && prefIntroDefault,
        route: tracksOptions.routes[0],
        routes: tracksOptions.routes[0] ? [tracksOptions.routes[0]] : [],
        tracksRoutes: tracksOptions.routes,
        displayMode: tracksOptions.displays[0],
        trackPlayMode: tracksOptions.playModes[0] as 'itinerary' | 'free' | undefined,
        scoreType: defaultScoreType as 'percentage' | 'points' | undefined,
        malusPerMinute: tracksOptions.defaultMalus,
        // Clues page on team return - off by default; the operator opts in per launch.
        cluesPage: { enabled: false, show_title: true, show_text: true, show_image: true },
        // Clash defaults - 2 clans, unlimited per clan, self-registration.
        // Équipes prédéfinies deals 10 chips per clan out of the box (the
        // operator adjusts the number, or edits the blocks chip by chip, on
        // step 2). A saved config's own value overrides this below.
        clashNumClans: 2,
        clashMaxPerClan: 0,
        clashChipsPerClan: 10,
        clashRegistrationMode: 'self',
        clashBalises: clashBalisesSeed,
        // The Purge - ON by default when the scenario has a purge image.
        clashPurgeEnabled: clashHasPurgeImage,
        clashPurgeStation: clashPurgeStationSeed,
        // TagQuest teams are predetermined by default (operator builds the
        // roster on step 2). Self-register is an opt-in that mirrors Clash.
        tagquestSelfRegister: false,
        tagquestMaxPerTeam: 0,
        // Ghost preview of the quest images on each bip - audience-driven
        // default (kids audiences like the spoiler, adults don't). Re-derived
        // whenever scenarioPublic loads/changes; a saved config overrides below.
        tagquestShowQuestPreview: scenarioPublic !== 'ado_adultes',
        // Effectif weighting - on by default so uneven team sizes compete
        // fairly out of the box (score victory + team mode only).
        tagquestScoreWeighting: true,
        // A saved config (Edit / headless fallback) overrides the computed
        // defaults. `name` stays blank - it's per-instance, never restored.
        ...(prefillConfig ?? {}),
        // A saved config may carry a pattern that no longer exists (deleted /
        // renamed in studio). Fall back to the default pattern rather than
        // launching with a stale id that silently breaks scoring.
        ...(prefillConfig?.pattern &&
        patternFolders.length > 0 &&
        !patternFolders.some((o) => o.uniqid === prefillConfig.pattern)
          ? { pattern: defaultPattern }
          : {}),
        // Mystery never persists an auto-register=off state EXCEPT for mass
        // start (whose fixed roster is the point), so re-assert it after any
        // saved-config restore unless the saved config is mass-start. Tracks
        // needs no re-assert: its saved configs carry a consistent pair
        // (multi-route and mass-start both persist auto-register off).
        ...(isMysteryType ? { autoRegisterTeam: !prefillConfig?.massStart } : {}),
        // A saved config can't re-enable the purge on a scenario that (no
        // longer) has a purge image - clamp AFTER the prefill spread.
        ...(clashHasPurgeImage ? {} : { clashPurgeEnabled: false }),
        name: '',
      });
      setStep(1);
      setTeams([]);
      setClashManualAssignments(null);
      setPairedDevices([]);
      setSelectedDeviceIds(new Set());
      setMotherChecked(true);
      setRegOverrides(new Map());
      setRegAssignActive(false);
      setShowAdvanced(false);
      setEditPattern(false);
      // Seed the save field when editing an existing config; otherwise reset.
      setConfigName(prefillConfigName ?? '');
      setShowSaveField(!!prefillConfigName);
      setSavePending(false);
      setOverwriteConfirm(null);
      setSavedFlash(null);
    }
  }, [isOpen, defaultPattern, patternFolders, scenarioDefaultLang, scenarioPublic, scenarioMessageDisplayTime, scenarioEnigmaDuration, hasTutorialVideo, hasIntroVideo, prefTutorialDefault, prefIntroDefault, gameTypeName, tracksOptions, clashBalisesSeed, clashHasPurgeImage, clashPurgeStationSeed, prefillConfig, prefillConfigName]);

  // Tracks: warn when the selected pattern's row count doesn't match the
  // course's checkpoint count. The checkpoint↔station binding is positional
  // (pattern row N ↔ Nth checkpoint), so a mismatch silently misaligns scoring.
  useEffect(() => {
    if (gameTypeName.toLowerCase() !== 'tracks' || !config.pattern || tracksCheckpointCount === 0) {
      setTracksPatternWarning('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const stations = await patternStore.getTracksCheckpointStations(config.pattern);
        if (cancelled) return;
        if (stations.size !== tracksCheckpointCount) {
          setTracksPatternWarning(
            t('launchModal:tracksPatternMismatch', {
              rows: stations.size,
              checkpoints: tracksCheckpointCount,
            }),
          );
        } else {
          setTracksPatternWarning('');
        }
      } catch {
        if (!cancelled) setTracksPatternWarning('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameTypeName, config.pattern, tracksCheckpointCount]);

  const allChips = useOnDemandCards
    ? [...availableChips, ...onDemandChips]
    : availableChips;

  const isTagQuest = gameTypeName.toLowerCase() === 'tagquest';
  const isTracks = gameTypeName.toLowerCase() === 'tracks';
  const isMystery = gameTypeName.toLowerCase() === 'mystery';
  const isClash = gameTypeName.toLowerCase() === 'clash';
  // The Purge: the purge station must not collide with any territory balise
  // station (effective set = launch override, else scenario seed) - the same
  // physical punch can't both validate and purge. This is a HARD launch gate.
  const clashPurgeCollision = useMemo(() => {
    if (!isClash || !config.clashPurgeEnabled) return null;
    const station = config.clashPurgeStation ?? clashPurgeStationSeed;
    for (const terr of clashTerritories) {
      const override = config.clashBalises?.[terr.index];
      const effective =
        override && override.length > 0 ? override : clashBalisesSeed[terr.index] ?? [];
      if (effective.includes(station)) {
        return { station, territory: terr.name };
      }
    }
    return null;
  }, [isClash, config.clashPurgeEnabled, config.clashPurgeStation, clashPurgeStationSeed, config.clashBalises, clashTerritories, clashBalisesSeed]);
  // Tracks multi-route launch: 2+ routes selected ⇒ teams get a per-team route
  // (assigned in order on the team-config step) and auto-register is disabled.
  const multipleRoutes = isTracks && (config.routes?.length ?? 0) > 1;
  // Auto-register + reuse-cards are offered for the card-collection runtimes
  // that create teams on bip (mystery, tracks) - not tagquest.
  const supportsDynamicTeams = isMystery || isTracks;
  const isTeamMode = isTagQuest && config.playMode === 'team';
  // Clash 'bulk' (Équipes prédéfinies) uses step 2 the way mass-start Mystery
  // does: the chip-block numbers (puces par clan / indice de la première puce)
  // live there, with a preview of what each clan gets.
  const isClashBulk = isClash && (config.clashRegistrationMode ?? 'self') === 'bulk';
  // Dynamic-team launches build no roster, so step 2 (Configure teams) is
  // skipped: step 1 advances straight to the device picker, and the device
  // picker's Back button must return to step 1 (not the never-visited step 2).
  // Clash self-register is the same: clans come from the scenario and players
  // bind chips on the registration screen, so there is no roster to edit.
  const skipsRosterStep =
    // Multi-route Tracks ALWAYS stops on step 2 - that's where each team gets
    // its parcours - so a stale auto/self-register flag can't skip it.
    !multipleRoutes &&
    (!!config.autoRegisterTeam ||
    !!config.selfRegisterTeam ||
    (isTagQuest && !!config.tagquestSelfRegister) ||
    // Clash 'self' binds chips live on the registration screen - nothing to
    // configure up front. 'bulk' does stop on step 2 (chip blocks per clan).
    (isClash && !isClashBulk));
  // Station-based self-register: step 3 lets the operator pin each selected
  // device to specific team(s) for registration (a hard-locked kiosk). Clash
  // 'self' mode + TagQuest self-register team mode only - bulk hands out chip
  // blocks from one place and solo has no predefined teams to assign.
  // Design: project_selfregister_team_device_assignment.
  const regAssignEnabled =
    (isClash && (config.clashRegistrationMode ?? 'self') === 'self') ||
    (isTagQuest && !!config.tagquestSelfRegister && config.playMode === 'team');
  // The assignment chips/payload only apply once the operator opts in via the
  // step-3 slide switch - `regAssignEnabled` is "this mode supports it".
  const regAssignOn = regAssignEnabled && regAssignActive;
  const regTeamDefs: RegTeamDef[] = !regAssignEnabled
    ? []
    : isClash
      ? Array.from(
          { length: Math.max(2, Math.min(config.clashNumClans ?? 2, 4)) },
          (_, i) => ({ number: i + 1, name: clashClanNames[i] || `Clan ${i + 1}` }),
        )
      : Array.from({ length: Math.max(1, config.numberOfTeams) }, (_, i) => ({
          number: i + 1,
          name: config.tagquestTeamNames?.[i] || `Équipe ${i + 1}`,
        }));
  // The live auto-deal: every device that actually takes part in this launch
  // gets teams, in listing order (mother first when it participates, then the
  // selected satellites). Reader-less devices are included too - the flag is
  // only knowable while a device is online, so filtering on it used to leave
  // the whole list unassigned. Rows stay individually editable either way.
  const autoRegDeviceIds: number[] = (() => {
    const selfRow = pairedDevices.find((d) => d.id === selfDeviceId);
    const ids: number[] = [];
    if (selfRow && motherChecked && !busyDeviceIds.has(selfRow.id) && !operatorOnly) {
      ids.push(selfRow.id);
    }
    for (const d of pairedDevices) {
      if (d.id === selfDeviceId) continue;
      if (!selectedDeviceIds.has(d.id) || busyDeviceIds.has(d.id)) continue;
      ids.push(d.id);
    }
    return ids;
  })();
  const autoRegAssignments: RegAssignmentMap = regAssignOn
    ? computeAutoRegAssignments(autoRegDeviceIds, regTeamDefs.length)
    : {};
  // Auto-until-touched: an override pins the operator's explicit choice (team
  // numbers beyond the current team count are dropped, not persisted); no
  // override shows whatever the auto-deal currently computes.
  const effectiveRegAssignment = (deviceId: number): { teams: number[]; manual: boolean } => {
    const override = regOverrides.get(deviceId);
    if (override) {
      return { teams: override.filter((n) => n <= regTeamDefs.length), manual: true };
    }
    return { teams: autoRegAssignments[deviceId] ?? [], manual: false };
  };
  const toggleRegTeam = (deviceId: number, teamNumber: number) => {
    setRegOverrides((prev) => {
      const next = new Map(prev);
      const cur = next.get(deviceId) ?? autoRegAssignments[deviceId] ?? [];
      const set = new Set(cur.filter((n) => n <= regTeamDefs.length));
      if (set.has(teamNumber)) set.delete(teamNumber);
      else set.add(teamNumber);
      next.set(deviceId, Array.from(set).sort((a, b) => a - b));
      return next;
    });
  };
  const resetRegAssignment = (deviceId: number) => {
    setRegOverrides((prev) => {
      if (!prev.has(deviceId)) return prev;
      const next = new Map(prev);
      next.delete(deviceId);
      return next;
    });
  };
  const chipsPerTeam = isTeamMode ? (config.teammatesPerTeam ?? 2) : 1;
  const totalChipsNeeded = config.numberOfTeams * chipsPerTeam;
  const maxTeams = allChips.length > 0 ? Math.floor(allChips.length / chipsPerTeam) : undefined;
  const totalMaxTeams = maxTeams;
  // 1-based: value N = "start at the Nth chip", so the last valid start that
  // still leaves room for every team is `length - needed + 1` (floored at 1).
  const maxFirstChipIndex = allChips.length > 0
    ? Math.max(1, allChips.length - totalChipsNeeded + 1)
    : undefined;

  useEffect(() => {
    if (!isOpen || !user) return;

    // Chip roster comes from the local `cards` table (synced from studio's
    // client_cards) plus optional on-demand JSON. Pending-write rows show
    // up here too so the operator can assign a freshly-registered card to
    // a team in the same launch session.
    const loadChips = async () => {
      try {
        const rows = await cardsRepo.list();
        setAvailableChips(
          rows.map((r) => ({
            id: r.id,
            key_number: r.key_number,
            key_name: r.key_name,
            color: r.color,
            created_at: '',
            updated_at: '',
          }))
        );
      } catch (err) {
        console.error('[LaunchGameModal] failed to read cards table:', err);
        setAvailableChips([]);
      }

      try {
        const onDemandJson = await cardsStore.getOnDemandCardsJson();
        const cards = (onDemandJson as { cards?: Array<{ id?: number; key_number: number; key_name: string; color?: string | null }> } | null)?.cards;
        if (cards && cards.length > 0) {
          const mapped: SiPuce[] = cards.map((c) => ({
            id: c.id ?? c.key_number,
            key_number: c.key_number,
            key_name: c.key_name,
            color: c.color ?? null,
            created_at: '',
            updated_at: '',
          }));
          setOnDemandChips(mapped.sort((a, b) => a.key_number - b.key_number));
          setHasOnDemandCards(true);
        } else {
          setOnDemandChips([]);
          setHasOnDemandCards(false);
        }
      } catch (err) {
        console.error('[LaunchGameModal] failed to read on-demand cards:', err);
        setOnDemandChips([]);
        setHasOnDemandCards(false);
      }
    };

    // Used chips: enumerate active games' teams.key_id so the user can't
    // re-assign a chip already in play. With per-client scoping this only
    // sees the current client's active games.
    const loadUsedChips = async () => {
      try {
        const active = await listActiveLaunchedGames();
        if (active.length === 0) {
          setUsedChipIds(new Set());
          return;
        }
        const used = new Set<number>();
        for (const game of active) {
          try {
            const state = await getLaunchedGameState(game.id, 0);
            for (const t of state.teams ?? []) {
              if (t.key_id !== null && t.key_id !== undefined) used.add(t.key_id);
            }
          } catch (err) {
            console.warn('[LaunchGameModal] state fetch failed for', game.id, err);
          }
        }
        setUsedChipIds(used);
      } catch (err) {
        console.error('[LaunchGameModal] loadUsedChips failed:', err);
        setUsedChipIds(new Set());
      }
    };

    loadChips();
    loadUsedChips();
  }, [isOpen, user]);

  // The full candidate set (client list ∪ default catalog, de-duplicated
  // case-insensitively, client names first) - used only for presence checks
  // (whether to show the "Utiliser les noms de la liste" affordances).
  const poolNames = (() => {
    const seenLc = new Set(poolNamesClient.map((n) => n.trim().toLowerCase()));
    const extra = poolNamesGlobal.filter((n) => !seenLc.has(n.trim().toLowerCase()));
    return [...poolNamesClient, ...extra];
  })();

  const shuffleNames = (arr: string[]): string[] => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // Draw sequence for the "Utiliser les noms de la liste" assignment: the
  // client's own names first (shuffled), then the default catalog (shuffled,
  // de-duplicated against the client list) to COMPLETE when the client pool is
  // too small for the team count. Only wraps once BOTH tiers are exhausted.
  const buildPoolNameSequence = (): string[] => {
    const seenLc = new Set(poolNamesClient.map((n) => n.trim().toLowerCase()));
    const globalExtra = poolNamesGlobal.filter((n) => !seenLc.has(n.trim().toLowerCase()));
    return [...shuffleNames(poolNamesClient), ...shuffleNames(globalExtra)];
  };

  // Assign pooled names to a roster: draw the client-first / default-completed
  // sequence and hand each team a distinct name (wrapping only if there are more
  // teams than names across both tiers). Returns the list unchanged when no pool
  // is available. Only the team name is overwritten - teammate names + chips are
  // left intact.
  const applyPoolNames = (list: Team[]): Team[] => {
    const seq = buildPoolNameSequence();
    if (seq.length === 0) return list;
    return list.map((team, i) => ({ ...team, name: seq[i % seq.length] }));
  };

  // TagQuest self-register: fill the predefined team-name inputs from the pool
  // (client names first, completed from the default catalog), one per team.
  const assignTagquestTeamNamesFromPool = () => {
    const seq = buildPoolNameSequence();
    if (seq.length === 0) return;
    const count = Math.max(1, config.numberOfTeams);
    const names = Array.from({ length: count }, (_, i) => seq[i % seq.length]);
    setConfig({ ...config, tagquestTeamNames: names });
  };

  const handleNextStep = () => {
    // Clash never edits a roster: clans are dealt numerically at launch, so
    // step 2 only carries the chip-block numbers (and their preview).
    if (isClash) {
      setTeams([]);
      setStep(2);
      return;
    }
    // Roster build lives in launchResolve so the headless Quick Launch path
    // produces an identical roster from the same inputs.
    const combinedChips = [...availableChips, ...onDemandChips];
    let roster = buildRoster(config, combinedChips, gameTypeName);
    // Pre-fill pooled names when the operator chose the pool source (mystery/
    // tracks mass-start fixed roster) or the legacy TagQuest fill-from-pool toggle.
    if (config.nameFromPool || ((isMystery || isTracks) && config.useNamePool)) roster = applyPoolNames(roster);
    // Tracks multi-route: pre-assign each team a route in order (cycling). The
    // operator can override per team via the step-2 dropdown; GameList applies
    // the same default for any team left unassigned (e.g. headless launches).
    if (multipleRoutes) {
      const sel = config.routes ?? [];
      roster = roster.map((team, i) => ({ ...team, route: team.route ?? sel[i % sel.length] }));
    }
    setTeams(roster);
    setStep(2);
  };

  // Mass-start Mystery/Tracks and predetermined TagQuest register their roster
  // on step 2: the team-count and first-chip controls live there and rebuild the
  // roster in place on change. Rebuilding discards manual name edits (like
  // adjusting the count on step 1 would), so the operator sets counts first,
  // then names.
  const rebuildRosterFromCounts = (patch: Partial<GameConfig>) => {
    const next: GameConfig = { ...config, ...patch };
    setConfig(next);
    const combinedChips = [...availableChips, ...onDemandChips];
    let roster = buildRoster(next, combinedChips, gameTypeName);
    if (next.useNamePool || next.nameFromPool) roster = applyPoolNames(roster);
    // Same in-order route pre-assignment handleNextStep does - rebuilding here
    // must not leave a multi-route roster without routes.
    if (multipleRoutes) {
      const sel = next.routes ?? [];
      if (sel.length > 0) roster = roster.map((team, i) => ({ ...team, route: sel[i % sel.length] }));
    }
    setTeams(roster);
  };

  // ---- Excel/CSV team roster import (step 2) ------------------------------
  // Single-chip modes (Mystery/Tracks/solo TagQuest) parse {chip, name}; team
  // mode adds a "team name" column and groups rows into multi-member teams.
  const teamImportMode: RosterImportMode = isTeamMode ? 'team' : 'single';

  // Clash clan set for the chip→clan import: 1..N slots with scenario-authored
  // names (fall back to "Clan N"). Resolves a "clan" cell by number or name.
  const clashClanDefs = Array.from({ length: config.clashNumClans ?? 2 }, (_, i) => ({
    index: i + 1,
    name: clashClanNames[i] || `Clan ${i + 1}`,
  }));

  // Step-1 affordance: reach the roster step for a dynamic-team game (Mystery
  // defaults to auto-register, which normally skips step 2). Turning auto/self
  // register off makes the imported fixed roster the source of truth.
  const goToManualRosterStep = () => {
    const next: GameConfig = { ...config, autoRegisterTeam: false, selfRegisterTeam: false };
    setConfig(next);
    const combinedChips = [...availableChips, ...onDemandChips];
    let roster = buildRoster(next, combinedChips, gameTypeName);
    if (next.nameFromPool) roster = applyPoolNames(roster);
    setTeams(roster);
    setStep(2);
  };

  const handleRosterFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setImportError(null);
    try {
      const result = await parseRosterFile(file, {
        mode: teamImportMode,
        chips: allChips,
        busyChipIds: usedChipIds,
      });
      setImportResult(result);
    } catch (err) {
      setImportError(rosterImportErrorMessage(err, teamImportMode));
    }
  };

  const handleClashFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportError(null);
    try {
      const result = await parseRosterFile(file, {
        mode: 'clan',
        chips: allChips,
        busyChipIds: usedChipIds,
        clans: clashClanDefs,
      });
      setImportResult(result);
    } catch (err) {
      setImportError(rosterImportErrorMessage(err, 'clan'));
    }
  };

  // Translate a thrown import error (fatal, whole-file) into a display string.
  const rosterImportErrorMessage = (err: unknown, mode: RosterImportMode): string => {
    if (err instanceof RosterImportError) {
      if (err.code === 'missing-columns') {
        const needs =
          mode === 'team'
            ? t('launchModal:importNeedsTeam')
            : mode === 'clan'
              ? t('launchModal:importNeedsClan')
              : t('launchModal:importNeedsName');
        return t('launchModal:importErrorMissingColumns', { needs });
      }
      const map: Record<string, string> = {
        'empty-file': 'launchModal:importErrorEmptyFile',
        'no-header': 'launchModal:importErrorNoHeader',
        'no-clans': 'launchModal:importErrorNoClans',
      };
      return t(map[err.code] ?? 'launchModal:importErrorGeneric', { message: err.code });
    }
    return t('launchModal:importErrorGeneric', { message: err instanceof Error ? err.message : String(err) });
  };

  // Turn the confirmed import into the teams roster (replace-all) and jump to
  // the roster step if we were still on step 1.
  const applyRosterImport = () => {
    if (!importResult) return;
    const { mode, entries } = importResult;

    // Clash: store chip→clan assignments in config; applied after launch.
    if (mode === 'clan') {
      setConfig((prev) => ({
        ...prev,
        clashChipAssignments: entries.map((en) => ({
          chipId: en.chip.id,
          chipNumber: en.chip.key_number,
          clanIndex: en.clanIndex ?? 1,
          name: en.name,
        })),
      }));
      setImportResult(null);
      return;
    }

    let newTeams: Team[];
    let teammatesPerTeam = config.teammatesPerTeam ?? 2;

    if (mode === 'team') {
      // Group by team name, preserving first-seen order.
      const order: string[] = [];
      const groups = new Map<string, typeof entries>();
      for (const en of entries) {
        const key = en.group ?? '';
        if (!groups.has(key)) { groups.set(key, []); order.push(key); }
        groups.get(key)!.push(en);
      }
      newTeams = order.map((label) => {
        const members = groups.get(label)!;
        const first = members[0];
        return {
          chipId: first.chip.id,
          chipNumber: first.chip.key_number,
          name: label,
          teammates: members.map((m) => ({
            chipId: m.chip.id,
            chipNumber: m.chip.key_number,
            name: m.name,
          })),
        };
      });
      teammatesPerTeam = Math.max(2, ...newTeams.map((tm) => tm.teammates?.length ?? 1));
    } else {
      newTeams = entries.map((en) => ({
        chipId: en.chip.id,
        chipNumber: en.chip.key_number,
        name: en.name,
      }));
    }

    setConfig((prev) => ({
      ...prev,
      autoRegisterTeam: false,
      selfRegisterTeam: false,
      numberOfTeams: newTeams.length,
      ...(mode === 'team' ? { teammatesPerTeam } : {}),
    }));
    setTeams(newTeams);
    setImportResult(null);
    if (step === 1) setStep(2);
  };

  const downloadImportTemplate = async (mode: RosterImportMode) => {
    const bytes = await buildTemplateXlsx(mode, allChips, mode === 'clan' ? clashClanDefs : undefined);
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${mode === 'clan' ? 'clans' : 'teams'}-template-${gameTypeName.toLowerCase()}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Clash capacity pre-check: clans whose imported assignment count exceeds the
  // per-clan cap. Surfaced as warnings in the preview (non-blocking).
  const clashCapacityWarnings = (() => {
    if (importResult?.mode !== 'clan') return [];
    const cap = config.clashMaxPerClan ?? 0;
    if (cap <= 0) return [];
    const counts = new Map<number, number>();
    for (const e of importResult.entries) {
      counts.set(e.clanIndex ?? 0, (counts.get(e.clanIndex ?? 0) ?? 0) + 1);
    }
    return clashClanDefs
      .filter((c) => (counts.get(c.index) ?? 0) > cap)
      .map((c) => ({ clan: c.name, max: cap, count: counts.get(c.index) ?? 0 }));
  })();

  // Clash "Équipes prédéfinies" (step 2): what each clan gets, chip by chip.
  // Unedited, it IS the block GameList would deal at launch - same free-chip
  // list (client cards minus chips held by an active game) and same helper, so
  // the operator sees exactly what will happen. Touching any chip pins the whole
  // allocation into `clashManualAssignments`, which is sent as
  // config.clashChipAssignments at launch (the path the Excel import uses).
  const clashChipById = new Map(allChips.map((c) => [c.id, c]));
  const clashBulkAllocation = (() => {
    if (!isClashBulk) return null;
    const free = availableChips.filter((c) => !usedChipIds.has(c.id));
    const numClans = Math.max(2, Math.min(config.clashNumClans ?? 2, 4));
    const perClan = Math.max(0, config.clashChipsPerClan ?? 10);
    const imported = config.clashChipAssignments ?? [];
    const source: Array<{ chipId: number; clanIndex: number }> =
      clashManualAssignments ??
      (imported.length > 0
        ? imported
        : buildClashContiguousAssignments(free, config.firstChipIndex, perClan, numClans));
    // Group by clan, dropping duplicates and clans that no longer exist (the
    // clan count can shrink after an import).
    const byClan = new Map<number, number[]>();
    const seen = new Set<number>();
    for (const a of source) {
      if (a.clanIndex < 1 || a.clanIndex > numClans || seen.has(a.chipId)) continue;
      seen.add(a.chipId);
      byClan.set(a.clanIndex, [...(byClan.get(a.clanIndex) ?? []), a.chipId]);
    }
    const clans = Array.from({ length: numClans }, (_, i) => ({
      index: i + 1,
      name: clashClanNames[i] || `Clan ${i + 1}`,
      chipIds: byClan.get(i + 1) ?? [],
    }));
    return {
      clans,
      free,
      freeCount: free.length,
      needed: perClan * numClans,
      assignedIds: seen,
      isManual: clashManualAssignments !== null,
      isImported: clashManualAssignments === null && imported.length > 0,
    };
  })();

  // Pin the current allocation as the manual one (chipNumber/name carried along
  // for the summary UI - the launch path only reads chipId + clanIndex).
  const commitClashClans = (clans: Array<{ index: number; chipIds: number[] }>) => {
    setClashManualAssignments(
      clans.flatMap((c) =>
        c.chipIds.map((id) => {
          const chip = clashChipById.get(id);
          return {
            chipId: id,
            chipNumber: chip?.key_number ?? 0,
            clanIndex: c.index,
            name: chip?.key_name ?? undefined,
          };
        }),
      ),
    );
  };

  const editClashClan = (clanIndex: number, edit: (chipIds: number[]) => number[]) => {
    if (!clashBulkAllocation) return;
    commitClashClans(
      clashBulkAllocation.clans.map((c) =>
        c.index === clanIndex ? { ...c, chipIds: edit(c.chipIds) } : c,
      ),
    );
  };

  // Add the next unassigned free chip to a clan (no-op when everything is taken).
  const addClashChip = (clanIndex: number) => {
    if (!clashBulkAllocation) return;
    const next = clashBulkAllocation.free.find((c) => !clashBulkAllocation.assignedIds.has(c.id));
    if (!next) return;
    editClashClan(clanIndex, (ids) => [...ids, next.id]);
  };
  const updateTeamRoute = (index: number, route: string) => {
    setTeams(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], route };
      return updated;
    });
  };

  const updateTeamName = (index: number, newName: string) => {
    setTeams(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], name: newName };
      return updated;
    });
  };

  const updateTeamLanguage = (index: number, lang: string) => {
    setTeams(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], language: lang };
      return updated;
    });
  };

  const updateTeamChip = (index: number, chipId: number) => {
    const chip = allChips.find(c => c.id === chipId);
    if (!chip) return;

    setTeams(prev => {
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        chipId: chip.id,
        chipNumber: chip.key_number,
        name: chip.key_name
      };
      return updated;
    });
  };

  const updateTeammateName = (teamIndex: number, teammateIndex: number, newName: string) => {
    setTeams(prev => {
      const updated = [...prev];
      const team = { ...updated[teamIndex] };
      const mates = [...(team.teammates ?? [])];
      mates[teammateIndex] = { ...mates[teammateIndex], name: newName };
      team.teammates = mates;
      if (teammateIndex === 0) {
        team.name = newName;
        team.chipId = mates[0].chipId;
        team.chipNumber = mates[0].chipNumber;
      }
      updated[teamIndex] = team;
      return updated;
    });
  };

  const updateTeammateChip = (teamIndex: number, teammateIndex: number, chipId: number) => {
    const chip = allChips.find(c => c.id === chipId);
    if (!chip) return;
    setTeams(prev => {
      const updated = [...prev];
      const team = { ...updated[teamIndex] };
      const mates = [...(team.teammates ?? [])];
      mates[teammateIndex] = { ...mates[teammateIndex], chipId: chip.id, chipNumber: chip.key_number };
      team.teammates = mates;
      if (teammateIndex === 0) {
        team.chipId = chip.id;
        team.chipNumber = chip.key_number;
      }
      updated[teamIndex] = team;
      return updated;
    });
  };

  const allUsedTeammateChipIds = (): Set<number> => {
    const ids = new Set<number>();
    teams.forEach(t => (t.teammates ?? []).forEach(m => ids.add(m.chipId)));
    return ids;
  };

  // Advance to the device picker (step 3). Lazy-fetch the paired list and
  // pre-check the mother + every currently-online satellite. Offline peers
  // are visible but unchecked - the operator can opt to queue a join_game
  // command that wakes them up when they reconnect (15-minute TTL on the
  // pending_commands row).
  const advanceToDevices = async () => {
    setStep(3);
    setPairedLoading(true);
    try {
      const [{ devices: rows, selfId, motherOutdated: outdated }, busy] = await Promise.all([listLaunchDevices(), listBusyDeviceIds()]);
      setPairedDevices(rows);
      setSelfDeviceId(selfId);
      setMotherOutdated(outdated);
      setBusyDeviceIds(busy);
      // Pre-check only online, non-self peers that aren't already in a game
      // (on a child this includes the mother, unless it's an older build).
      setSelectedDeviceIds(new Set(rows.filter(r => r.id !== selfId && r.online && !busy.has(r.id) && !(outdated && r.is_self)).map(r => r.id)));
      // This device participates by default unless it's already running a game.
      // Operator-only devices never participate.
      const selfRow = rows.find(r => r.id === selfId);
      setMotherChecked(operatorOnly ? false : !(selfRow && busy.has(selfRow.id)));
    } catch (err) {
      console.error('[LaunchGameModal] failed to load paired devices:', err);
      setPairedDevices([]);
      setBusyDeviceIds(new Set());
    } finally {
      setPairedLoading(false);
    }
  };

  // Step 3, station-based self-register: the per-device registration-team
  // chips shown under each participating device row.
  const renderRegAssignRow = (deviceId: number) => {
    if (!regAssignOn || regTeamDefs.length === 0) return null;
    const { teams: assigned, manual } = effectiveRegAssignment(deviceId);
    const assignedNames = assigned
      .map((n) => regTeamDefs.find((d) => d.number === n)?.name)
      .filter((n): n is string => !!n);
    return (
      <div className="px-3 pb-3 pl-10">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--pg-text-dim)] shrink-0">
          {t('launchModal:regAssignLabel')}
        </span>
        <RegAssignChips
          teams={regTeamDefs}
          value={assigned}
          onToggle={(n) => toggleRegTeam(deviceId, n)}
          trailing={
            <>
              {assigned.length === 0 && (
                <span className="text-xs italic text-[var(--pg-text-dim)]">
                  {t('launchModal:regAssignAllTeams')}
                </span>
              )}
              {manual ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    resetRegAssignment(deviceId);
                  }}
                  className="text-[10px] uppercase px-1.5 py-0.5 rounded border border-[var(--pg-line)] text-[var(--pg-text-muted)] hover:text-[var(--pg-text)] hover:border-[var(--pg-line-strong)]"
                  title={t('launchModal:regAssignResetTitle')}
                >
                  {t('launchModal:regAssignReset')}
                </button>
              ) : (
                <span
                  className="text-[10px] uppercase px-1.5 py-0.5 rounded border border-[var(--pg-line)] text-[var(--pg-text-dim)]"
                  title={t('launchModal:regAssignAutoTitle')}
                >
                  {t('launchModal:regAssignAuto')}
                </span>
              )}
            </>
          }
        />
      </div>
      {/* Plain-language restatement of the chips - the operator scans this
          column to check the whole plan without decoding chip states. */}
      {assignedNames.length > 0 && (
        <div className="mt-1 text-xs text-[var(--pg-accent-bright)]">
          {t('launchModal:regAssignSummary', { teams: assignedNames.join(', ') })}
        </div>
      )}
      </div>
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (step === 1) {
      // HARD gate: the purge station colliding with a balise station would make
      // one physical punch mean two things. Surface the error (auto-open the
      // Advanced card where it lives) and refuse to advance.
      if (clashPurgeCollision) {
        setShowAdvanced(true);
        return;
      }
      // Dynamic-team modes (auto-register / self-register) build no roster, so
      // skip the team-config step. TagQuest self-register is the same: players
      // bind their chip to a team at game start (Clash-style), so there is no
      // pre-built roster to edit here.
      if (skipsRosterStep) {
        setTeams([]);
        await advanceToDevices();
      } else {
        handleNextStep();
      }
      return;
    }

    if (step === 2) {
      await advanceToDevices();
      return;
    }

    // step === 3: actually launch. Ignore repeat clicks while a launch is in
    // flight - each one used to start another game.
    if (launchingRef.current) return;
    // Reader-not-detected is no longer a launch gate. The game pages
    // surface a banner if the dongle is missing and auto-bind via the
    // 'reader:status' event once it's plugged in.
    const finalConfig = {
      ...config,
      name: config.name.trim() || getDefaultName(),
      teams,
      // Clash "Équipes prédéfinies": a hand-edited allocation travels as
      // clashChipAssignments (the path the Excel import already uses). An
      // emptied allocation also zeroes chipsPerClan, otherwise the launch would
      // read "no assignments" and re-deal the very blocks the operator cleared.
      ...(isClashBulk && clashManualAssignments
        ? {
            clashChipAssignments: clashManualAssignments,
            ...(clashManualAssignments.length === 0 ? { clashChipsPerClan: 0 } : {}),
          }
        : {}),
      // Always derive the name-pool audience from the scenario (no manual
      // override), and carry the scenario's languages for the self-register
      // overlay's flag radios.
      namePoolAudience: scenarioPublic,
      scenarioLanguages,
    };
    // Never dispatch to a device already in another game, even if a stale id
    // lingered in the selection. Likewise, don't let this device participate
    // if it's busy (one game per device - it can still host/dispatch).
    const selfRow = pairedDevices.find((r) => r.id === selfDeviceId);
    const selfBusy = !!(selfRow && busyDeviceIds.has(selfRow.id));
    const outdatedMotherId = motherOutdated ? pairedDevices.find((r) => r.is_self)?.id : undefined;
    const satellite_targets = Array.from(selectedDeviceIds).filter(
      (id) => !busyDeviceIds.has(id) && id !== outdatedMotherId
    );
    const includeSelf = motherChecked && !selfBusy && !operatorOnly;
    // Station-based self-register: resolve the auto/manual per-device teams
    // into the final map persisted as meta.regAssignments. Devices with no
    // teams get no entry (they keep the pick-any-team grid).
    // ALWAYS sent, even when the toggle is off - an empty map is this wizard
    // stating "no assignment". Omitting the key made the toggle a no-op: the
    // launch path reads a missing key as "headless Quick Launch" and auto-deals.
    const reg_assignments: RegAssignmentMap = {};
    if (regAssignOn) {
      const participantIds = [
        ...(includeSelf && selfRow ? [selfRow.id] : []),
        ...satellite_targets,
      ];
      for (const id of participantIds) {
        const { teams: assigned } = effectiveRegAssignment(id);
        if (assigned.length > 0) reg_assignments[id] = assigned;
      }
    }
    launchingRef.current = true;
    setLaunching(true);
    try {
      await onLaunch(finalConfig, {
        include_self: includeSelf,
        satellite_targets,
        reg_assignments,
      });
    } finally {
      // Re-arm in case the modal stays open (launch error) or is reopened.
      launchingRef.current = false;
      setLaunching(false);
    }
  };

  // Persist the current step-1 settings as a named, scenario-assigned config.
  // Does NOT launch and does NOT advance the wizard. Strips the per-instance
  // name/teams (handled in launchConfigsStore).
  const performSaveConfig = async (name: string) => {
    if (!user?.client_id) return;
    setSavePending(true);
    try {
      await launchConfigsStore.upsertByName(user.client_id, gameUniqid, name, config);
      setOverwriteConfirm(null);
      setSavedFlash(name);
      onConfigSaved?.(name);
      window.setTimeout(() => setSavedFlash(null), 2500);
    } catch (err) {
      console.error('[LaunchGameModal] failed to save launch config:', err);
    } finally {
      setSavePending(false);
    }
  };

  const handleSaveConfigClick = async () => {
    const name = configName.trim();
    if (!name || !user?.client_id) return;
    // Overwrite-on-name-match: confirm before replacing an existing config.
    const exists = await launchConfigsStore.existsByName(user.client_id, gameUniqid, name);
    if (exists) {
      setOverwriteConfirm(name);
    } else {
      await performSaveConfig(name);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="pg-overlay">
      <div className="relative w-full h-full max-w-4xl max-h-screen overflow-auto bg-[var(--pg-bg)] shadow-2xl md:rounded-[var(--pg-radius-lg)] md:m-8 md:h-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between p-6 bg-[var(--pg-surface)] border-b border-[var(--pg-line)]">
          <h2 className="pg-modal-title text-2xl">{t('launchModal:title')}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="pg-modal-close"
            >
              <X size={24} />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {step === 1 && (
          <>
          {noticeText && (
            <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm">
              <span>{noticeText}</span>
            </div>
          )}
          <div className="space-y-2">
            <label htmlFor="name" className="pg-label">
              {t('launchModal:gameName')}
            </label>
            <input
              type="text"
              id="name"
              value={config.name}
              onChange={(e) => setConfig({ ...config, name: e.target.value })}
              placeholder={getDefaultName()}
              className="pg-input"
            />
            <p className="text-xs text-[var(--pg-text-dim)]">{t('launchModal:gameNameHint', { default: getDefaultName() })}</p>
          </div>

          {/* TagQuest: Duration + Language sit directly under the title, on one
              row (Mystery-style). For other types they live in the shared grid. */}
          {isTagQuest && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <div className="flex items-center gap-1">
                  <label htmlFor="duration" className="pg-label !mb-0">
                    {t('launchModal:durationMinutes')}
                  </label>
                  <HelpDot topic="launch.duration" />
                </div>
                <input
                  type="number"
                  id="duration"
                  min="1"
                  value={config.duration}
                  onChange={(e) => setConfig({ ...config, duration: parseInt(e.target.value) || 1 })}
                  className="pg-input"
                  required
                />
              </div>
              {scenarioLanguages.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1">
                    <label htmlFor="language" className="pg-label !mb-0">
                      {t('launchModal:language')}
                    </label>
                    <HelpDot topic="launch.language" />
                  </div>
                  <select
                    id="language"
                    value={config.language || scenarioDefaultLang}
                    onChange={(e) => setConfig({ ...config, language: e.target.value })}
                    className="pg-select"
                  >
                    {scenarioLanguages.map((lang) => (
                      <option key={lang} value={lang}>
                        {LANG_NAMES[lang] || lang} ({lang})
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-[var(--pg-text-dim)]">
                    {t('launchModal:languageHint')}
                  </p>
                </div>
              )}
            </div>
          )}

          {isTagQuest && (
            <>
              <div className="space-y-3 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
                <label className="pg-label">
                  {t('launchModal:victoryType')}
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config, victoryType: 'score' })}
                    className={`relative p-4 rounded-[var(--pg-radius-md)] border-2 text-left transition-all ${
                      config.victoryType === 'score'
                        ? 'border-[var(--pg-accent-line)] bg-[var(--pg-accent-tint)]'
                        : 'border-[var(--pg-line)] bg-[var(--pg-surface-3)] hover:border-[var(--pg-line-strong)]'
                    }`}
                  >
                    <div className={`font-semibold text-sm mb-1 ${config.victoryType === 'score' ? 'text-[var(--pg-accent-bright)]' : 'text-[var(--pg-text-muted)]'}`}>
                      {t('launchModal:victoryScore')}
                    </div>
                    <div className="text-xs text-[var(--pg-text-dim)] leading-snug">
                      {t('launchModal:victoryScoreDesc')}
                    </div>
                    {config.victoryType === 'score' && (
                      <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[var(--pg-accent)]" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config, victoryType: 'speed' })}
                    className={`relative p-4 rounded-[var(--pg-radius-md)] border-2 text-left transition-all ${
                      config.victoryType === 'speed'
                        ? 'border-orange-500 bg-orange-500/10'
                        : 'border-[var(--pg-line)] bg-[var(--pg-surface-3)] hover:border-[var(--pg-line-strong)]'
                    }`}
                  >
                    <div className={`font-semibold text-sm mb-1 ${config.victoryType === 'speed' ? 'text-orange-400' : 'text-[var(--pg-text-muted)]'}`}>
                      {t('launchModal:victorySpeed')}
                    </div>
                    <div className="text-xs text-[var(--pg-text-dim)] leading-snug">
                      {t('launchModal:victorySpeedDesc')}
                    </div>
                    {config.victoryType === 'speed' && (
                      <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-orange-500" />
                    )}
                  </button>
                </div>
              </div>

              {/* Merged "Mode de jeu" card - play mode + team registration.
                  The predetermined roster's counts (Number of teams / teammates /
                  first chip) live on step 2, Mystery mass-start style; only
                  self-register team mode keeps its count here (it never reaches
                  step 2). Pattern moved to Advanced (Mystery-style); Duration +
                  Language keep the Mystery-style two-column row below. */}
              <div className="space-y-4 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
                <label className="pg-label">
                  {t('launchModal:playMode')}
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config, playMode: 'team' })}
                    className={`relative p-4 rounded-[var(--pg-radius-md)] border-2 text-left transition-all ${
                      config.playMode === 'team'
                        ? 'border-teal-500 bg-teal-500/10'
                        : 'border-[var(--pg-line)] bg-[var(--pg-surface-3)] hover:border-[var(--pg-line-strong)]'
                    }`}
                  >
                    <div className={`font-semibold text-sm mb-1 ${config.playMode === 'team' ? 'text-teal-400' : 'text-[var(--pg-text-muted)]'}`}>
                      {t('launchModal:playModeTeam')}
                    </div>
                    <div className="text-xs text-[var(--pg-text-dim)] leading-snug">
                      {t('launchModal:playModeTeamDesc')}
                    </div>
                    {config.playMode === 'team' && (
                      <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-teal-500" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config, playMode: 'solo' })}
                    className={`relative p-4 rounded-[var(--pg-radius-md)] border-2 text-left transition-all ${
                      config.playMode === 'solo'
                        ? 'border-teal-500 bg-teal-500/10'
                        : 'border-[var(--pg-line)] bg-[var(--pg-surface-3)] hover:border-[var(--pg-line-strong)]'
                    }`}
                  >
                    <div className={`font-semibold text-sm mb-1 ${config.playMode === 'solo' ? 'text-teal-400' : 'text-[var(--pg-text-muted)]'}`}>
                      {t('launchModal:playModeSolo')}
                    </div>
                    <div className="text-xs text-[var(--pg-text-dim)] leading-snug">
                      {t('launchModal:playModeSoloDesc')}
                    </div>
                    {config.playMode === 'solo' && (
                      <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-teal-500" />
                    )}
                  </button>
                </div>

                {/* Team registration - Predetermined roster (default, sized and
                    built on the next step) vs Self-register (players bind their
                    chip to a team at game start on the registration screen,
                    mirroring Clash's clashRegistrationMode='self'). */}
                <div className="pt-3 border-t border-[var(--pg-line)] space-y-3">
                  <label className="pg-label">{t('launchModal:teamRegistrationHeading', { defaultValue: 'Team registration' })}</label>
                  <div className="pg-pill-group">
                    {([
                      { key: false, label: t('launchModal:regPredetermined', { defaultValue: 'Predetermined teams' }) },
                      { key: true, label: t('launchModal:regSelfRegister', { defaultValue: 'Self-register' }) },
                    ] as const).map((opt) => (
                      <button
                        key={String(opt.key)}
                        type="button"
                        onClick={() => setConfig({ ...config, tagquestSelfRegister: opt.key })}
                        className={`pg-pill flex-1${!!config.tagquestSelfRegister === opt.key ? ' is-active' : ''}`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-[var(--pg-text-dim)]">
                    {t('launchModal:tagquestRegHint', { defaultValue: 'Predetermined: you assign chips to teams on the next step. Self-register: players bip their chip to join a team on the registration screen at game start - just like Clash.' })}
                  </p>

                  {/* Team-count controls. Self-register team mode keeps them here
                      (it never reaches step 2, and the team-name inputs below are
                      driven by the count). The predetermined roster moves its
                      count / teammates / first-chip fields to step 2, Mystery
                      mass-start style, so they sit next to the roster they build. */}
                  {config.tagquestSelfRegister && config.playMode === 'team' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <label htmlFor="numberOfTeams" className="pg-label">
                          {t('launchModal:numberOfTeams')}
                          {totalMaxTeams !== undefined && (
                            <span className="ml-2 text-xs text-[var(--pg-text-dim)]">
                              {t('launchModal:maxCount', { max: totalMaxTeams })}
                            </span>
                          )}
                        </label>
                        <input
                          type="number"
                          id="numberOfTeams"
                          min="1"
                          max={config.testMode ? Math.min(maxTeams ?? 5, 5) : maxTeams}
                          value={config.numberOfTeams}
                          onChange={(e) => {
                            const val = parseInt(e.target.value) || 1;
                            const effectiveMax = config.testMode
                              ? Math.min(maxTeams ?? 5, 5)
                              : maxTeams;
                            const clampedTeams = effectiveMax !== undefined ? Math.min(val, effectiveMax) : val;
                            const clampedFirst = maxTeams !== undefined
                              ? Math.max(1, Math.min(config.firstChipIndex, maxTeams - clampedTeams + 1))
                              : config.firstChipIndex;
                            setConfig({ ...config, numberOfTeams: clampedTeams, firstChipIndex: clampedFirst });
                          }}
                          className="pg-input"
                          required
                        />
                        {maxTeams !== undefined && config.numberOfTeams > maxTeams && (
                          <p className="text-xs text-red-400">{t('launchModal:exceedsAvailableCards', { max: maxTeams })}</p>
                        )}
                      </div>

                      {/* Self-register team mode: "Joueurs max par équipe" sits on
                          the same line as "Nombre d'équipes" (the first-chip index
                          column is hidden in this mode). */}
                      <div className="space-y-2">
                        <label htmlFor="tagquestMaxPerTeam" className="pg-label">
                          {t('launchModal:maxPerTeam', { defaultValue: 'Max players per team' })}
                        </label>
                        <input
                          type="number"
                          id="tagquestMaxPerTeam"
                          min="0"
                          value={config.tagquestMaxPerTeam ?? 0}
                          onChange={(e) => setConfig({ ...config, tagquestMaxPerTeam: Math.max(0, parseInt(e.target.value) || 0) })}
                          className="pg-input"
                        />
                        <p className="text-xs text-[var(--pg-text-dim)]">{t('launchModal:zeroUnlimited', { defaultValue: '0 = unlimited' })}</p>
                      </div>
                    </div>
                  )}

                  {config.tagquestSelfRegister && config.playMode === 'team' && (
                    <div className="space-y-3 pt-1">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <label className="pg-label !mb-0">{t('launchModal:teamNamesLabel', { defaultValue: 'Team names' })}</label>
                          {poolNames.length > 0 && (
                            <button
                              type="button"
                              onClick={assignTagquestTeamNamesFromPool}
                              className="pg-btn pg-btn--ghost text-sm"
                            >
                              🎲 {t('launchModal:fillFromNamePool')}
                            </button>
                          )}
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          {Array.from({ length: Math.max(1, config.numberOfTeams) }, (_, i) => (
                            <input
                              key={i}
                              type="text"
                              value={config.tagquestTeamNames?.[i] ?? `Équipe ${i + 1}`}
                              onChange={(e) => {
                                const names = Array.from({ length: Math.max(1, config.numberOfTeams) }, (_, j) =>
                                  config.tagquestTeamNames?.[j] ?? `Équipe ${j + 1}`);
                                names[i] = e.target.value;
                                setConfig({ ...config, tagquestTeamNames: names });
                              }}
                              className="pg-input"
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {config.tagquestSelfRegister && config.playMode === 'solo' && (
                    <p className="text-xs text-[var(--pg-text-dim)] pt-1">
                      {t('launchModal:tagquestSoloSelfRegHint', { defaultValue: 'Each player bips their own chip on the registration screen to enrol; one team is created per chip. Start the game once everyone has joined.' })}
                    </p>
                  )}
                </div>
              </div>
            </>
          )}

          {/* TagQuest renders Duration + Language under the title (below), its
              registration mode in the merged "Mode de jeu" card and its roster
              counts on step 2, with the pattern in Advanced - so this whole
              shared grid is skipped for TagQuest. */}
          {!isTagQuest && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Mass-start Mystery/Tracks registers teams before launch, so its
                team-count and first-chip controls live on step 2 (roster), not here. */}
            {!(config.autoRegisterTeam || config.selfRegisterTeam || isClash || isTagQuest || ((isMystery || isTracks) && config.massStart)) && (
            <>
            <div className="space-y-2">
              <label htmlFor="numberOfTeams" className="pg-label">
                {t('launchModal:numberOfTeams')}
                {totalMaxTeams !== undefined && (
                  <span className="ml-2 text-xs text-[var(--pg-text-dim)]">
                    {t('launchModal:maxCount', { max: totalMaxTeams })}
                  </span>
                )}
              </label>
              <input
                type="number"
                id="numberOfTeams"
                min="1"
                max={config.testMode ? Math.min(maxTeams ?? 5, 5) : maxTeams}
                value={config.numberOfTeams}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || 1;
                  const effectiveMax = config.testMode
                    ? Math.min(maxTeams ?? 5, 5)
                    : maxTeams;
                  const clampedTeams = effectiveMax !== undefined ? Math.min(val, effectiveMax) : val;
                  const clampedFirst = maxTeams !== undefined
                    ? Math.max(1, Math.min(config.firstChipIndex, maxTeams - clampedTeams + 1))
                    : config.firstChipIndex;
                  setConfig({ ...config, numberOfTeams: clampedTeams, firstChipIndex: clampedFirst });
                }}
                className="pg-input"
                required
              />
              {maxTeams !== undefined && config.numberOfTeams > maxTeams && (
                <p className="text-xs text-red-400">{t('launchModal:exceedsAvailableCards', { max: maxTeams })}</p>
              )}
              {isTeamMode && (
                <div className="mt-3 space-y-2">
                  <label htmlFor="teammatesPerTeam" className="pg-label">
                    {t('launchModal:teammatesPerTeam')}
                    {allChips.length > 0 && (
                      <span className="ml-2 text-xs text-[var(--pg-text-dim)]">
                        {t('launchModal:chipsNeededAvailable', { needed: totalChipsNeeded, available: allChips.length })}
                      </span>
                    )}
                  </label>
                  <input
                    type="number"
                    id="teammatesPerTeam"
                    min="2"
                    value={config.teammatesPerTeam ?? 2}
                    onChange={(e) => {
                      const val = Math.max(2, parseInt(e.target.value) || 2);
                      const newMax = allChips.length > 0 ? Math.floor(allChips.length / val) : undefined;
                      const clampedTeams = newMax !== undefined ? Math.min(config.numberOfTeams, newMax) : config.numberOfTeams;
                      setConfig({ ...config, teammatesPerTeam: val, numberOfTeams: clampedTeams });
                    }}
                    className="pg-input"
                  />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="firstChipIndex" className="pg-label">
                {t('launchModal:indexOfFirstChip')}
              </label>
              <input
                type="number"
                id="firstChipIndex"
                min="1"
                {...(maxFirstChipIndex !== undefined ? { max: maxFirstChipIndex } : {})}
                value={config.firstChipIndex}
                onChange={(e) => {
                  let val = Math.max(1, parseInt(e.target.value) || 1);
                  if (maxFirstChipIndex !== undefined) val = Math.min(val, maxFirstChipIndex);
                  setConfig({ ...config, firstChipIndex: val });
                }}
                className="pg-input"
                required
              />
            </div>
            </>
            )}

            {/* Pattern lives in the main grid for every type except Mystery,
                Tracks and TagQuest, where it's moved into Advanced behind a
                "Modify" toggle. */}
            {!isMystery && !isTracks && !isTagQuest && (
            <div className="space-y-2">
              <label htmlFor="pattern" className="pg-label">
                {t('launchModal:pattern')}
              </label>
              <select
                id="pattern"
                value={config.pattern}
                onChange={(e) => setConfig({ ...config, pattern: e.target.value })}
                className="pg-select"
                required
              >

                {patternFolders.length === 0 ? (
                  <option value="">{t('launchModal:loadingPatterns')}</option>
                ) : (
                  patternFolders.map((option) => (
                    <option key={option.uniqid || option.slug} value={option.uniqid}>
                      {option.name}
                    </option>
                  ))
                )}
              </select>
              {tracksPatternWarning && (
                <p className="text-xs text-amber-300/90 flex items-start gap-1.5">
                  <span aria-hidden>⚠️</span>
                  <span>{tracksPatternWarning}</span>
                </p>
              )}
            </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <label htmlFor="duration" className="pg-label !mb-0">
                  {t('launchModal:durationMinutes')}
                </label>
                <HelpDot topic="launch.duration" />
              </div>
              <input
                type="number"
                id="duration"
                min="1"
                value={config.duration}
                onChange={(e) => setConfig({ ...config, duration: parseInt(e.target.value) || 1 })}
                className="pg-input"
                required
              />
            </div>

            {/* Language sits alongside duration on the same row. Only shown when
                the scenario ships at least one language. */}
            {scenarioLanguages.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1">
                  <label htmlFor="language" className="pg-label !mb-0">
                    {t('launchModal:language')}
                  </label>
                  <HelpDot topic="launch.language" />
                </div>
                <select
                  id="language"
                  value={config.language || scenarioDefaultLang}
                  onChange={(e) => setConfig({ ...config, language: e.target.value })}
                  className="pg-select"
                >
                  {scenarioLanguages.map((lang) => (
                    <option key={lang} value={lang}>
                      {LANG_NAMES[lang] || lang} ({lang})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-[var(--pg-text-dim)]">
                  {t('launchModal:languageHint')}
                </p>
              </div>
            )}

          </div>
          )}

          {isClash && (
            <div className="space-y-4 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
              <div className="text-sm font-semibold text-[var(--pg-text)]">{t('launchModal:clashSetup')}</div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="pg-label">{t('launchModal:numberOfClans')}</label>
                  <select
                    value={config.clashNumClans ?? 2}
                    onChange={(e) => {
                      // The clan count reshapes the deal, so any hand-edited
                      // allocation is dropped back to the automatic one.
                      setClashManualAssignments(null);
                      setConfig({ ...config, clashNumClans: parseInt(e.target.value) });
                    }}
                    className="pg-select"
                  >
                    {[2, 3, 4].map((n) => (
                      <option key={n} value={n}>{t('launchModal:clansOption', { count: n })}</option>
                    ))}
                  </select>
                </div>
                {/* Max-per-clan is a live self-register cap; predefined clans get
                    a fixed block per clan instead, so it's hidden in that mode. */}
                {(config.clashRegistrationMode ?? 'self') === 'self' && (
                  <div className="space-y-1">
                    <label className="pg-label">{t('launchModal:maxPlayersPerClan')}</label>
                    <input
                      type="number"
                      min="0"
                      value={config.clashMaxPerClan ?? 0}
                      onChange={(e) => setConfig({ ...config, clashMaxPerClan: Math.max(0, parseInt(e.target.value) || 0) })}
                      className="pg-input"
                    />
                    <p className="text-xs text-[var(--pg-text-dim)]">{t('launchModal:zeroUnlimited')}</p>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <TracksRadioGroup
                  label={t('launchModal:clashRegistration')}
                  name="clashRegMode"
                  options={[
                    { key: 'self', label: t('launchModal:regSelfRegister') },
                    { key: 'bulk', label: t('launchModal:clashRegBulk') },
                  ]}
                  value={config.clashRegistrationMode ?? 'self'}
                  onChange={(k) => {
                    setClashManualAssignments(null);
                    setConfig({ ...config, clashRegistrationMode: k as 'self' | 'bulk' });
                  }}
                />
                <p className="text-xs text-[var(--pg-text-dim)]">
                  {t('launchModal:clashRegHint')}
                </p>
              </div>

              {/* Prédéfinies: the chip-block numbers (puces par clan / indice de
                  la première puce) live on step 2 - see the clash block there. */}
              {isClashBulk && (
                <p className="text-xs text-[var(--pg-text-dim)]">
                  {t('launchModal:clashBulkNextStepHint')}
                </p>
              )}

              {/* Import chip→clan assignments from Excel/CSV. Clans only exist
                  after launch, so these are stored in config and applied by
                  GameList once the game is created (via clashRegister). */}
              <div className="space-y-2 pt-3 border-t border-[var(--pg-line)]">
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => clashFileInputRef.current?.click()}
                    className="pg-btn pg-btn--ghost text-sm flex items-center gap-1.5"
                  >
                    <Upload size={16} />
                    {t('launchModal:importClanAssignments')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void downloadImportTemplate('clan')}
                    className="pg-btn pg-btn--ghost text-sm flex items-center gap-1.5"
                    title={t('launchModal:downloadTemplate')}
                  >
                    <FileDown size={16} />
                  </button>
                </div>
                <input
                  ref={clashFileInputRef}
                  type="file"
                  accept=".csv,.xls,.xlsx"
                  onChange={handleClashFileChange}
                  className="hidden"
                />
                {importError && (
                  <div className="px-3 py-2 rounded-[var(--pg-radius-md)] text-sm bg-[var(--pg-danger-soft,#3d1620)] text-[var(--pg-danger,#f87171)]">
                    {importError}
                  </div>
                )}
                {(config.clashChipAssignments?.length ?? 0) > 0 && (
                  <div className="flex items-center gap-3 text-xs text-[var(--pg-text-dim)]">
                    <span>
                      {t('launchModal:clashAssignmentsSummary', { count: config.clashChipAssignments!.length })}
                    </span>
                    <button
                      type="button"
                      onClick={() => setConfig({ ...config, clashChipAssignments: undefined })}
                      className="text-[var(--pg-accent-bright)] hover:underline"
                    >
                      {t('launchModal:clashAssignmentsClear')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Mystery + Tracks: chips + team-name handling. Teams normally
              auto-register on first bip - the operator only chooses HOW each team
              is named, and whether a finished chip can start a new game. Tracks
              multi-route keeps this card too (naming + reuse still apply to its
              fixed roster); only self-registration is unavailable there. */}
          {(isMystery || isTracks) && (
            <div className="space-y-3 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-[var(--pg-text)]">{t('launchModal:chipsAndTeamNamesHeading')}</h3>
                <HelpDot topic="launch.auto-register" />
              </div>
              <p className="text-xs text-[var(--pg-text-dim)]">{t('launchModal:chipsAndTeamNamesIntro')}</p>

              {/* Start mode - Mystery + Tracks. Mass start (all teams begin
                  together) is incompatible with self-registration, so choosing it
                  forces selfRegisterTeam off and the team-names radio below drops
                  its "self" option. Multi-route Tracks needs a pre-built roster to
                  assign the routes, so staggered must NOT re-enable on-bip
                  auto-registration there. */}
              <TracksRadioGroup
                label={t('launchModal:startModeHeading')}
                name="startMode"
                options={[
                  { key: 'staggered', label: t('launchModal:startModeStaggered') },
                  { key: 'mass', label: t('launchModal:startModeMass') },
                ]}
                value={config.massStart ? 'mass' : 'staggered'}
                onChange={(k) =>
                  setConfig({
                    ...config,
                    massStart: k === 'mass',
                    // Mass start = all teams begin together, so the roster must be
                    // registered before launch (fixed roster on step 2). Staggered
                    // goes back to on-bip auto-registration - except multi-route,
                    // which stays on its fixed roster.
                    autoRegisterTeam: multipleRoutes ? false : k !== 'mass',
                    ...(k === 'mass'
                      ? { selfRegisterTeam: false, addRandomNameOption: false, allowPlayerLanguageChoice: false }
                      : {}),
                  })
                }
              />

              {/* Self-registration is unavailable with mass start (hidden) and
                  with several parcours (shown disabled + why: the roster must
                  exist before launch so each team can be given a route). */}
              <TracksRadioGroup
                label={t('launchModal:teamNamesHeading')}
                name="mysteryNameMode"
                options={[
                  ...(config.massStart ? [] : [{ key: 'self', label: t('launchModal:nameModeSelf') }]),
                  { key: 'auto', label: t('launchModal:autoDetermineTeamNames') },
                ]}
                disabledKeys={multipleRoutes ? ['self'] : undefined}
                hint={multipleRoutes && !config.massStart ? t('launchModal:selfRegisterMultiRouteHint') : undefined}
                value={config.selfRegisterTeam ? 'self' : 'auto'}
                onChange={(k) =>
                  setConfig({
                    ...config,
                    selfRegisterTeam: k === 'self',
                    // Entering self-register clears the auto-name source;
                    // leaving it clears self-register's sub-options.
                    ...(k === 'self'
                      ? { useNamePool: false }
                      : { addRandomNameOption: false, allowPlayerLanguageChoice: false }),
                  })
                }
              />

              {config.selfRegisterTeam ? (
                <div className="ml-1 space-y-3">
                  {/* Self-register sub-option: re-rollable random name button in the overlay. */}
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      id="addRandomNameOption"
                      checked={!!config.addRandomNameOption}
                      onChange={(e) => setConfig({ ...config, addRandomNameOption: e.target.checked })}
                      className="w-5 h-5 accent-[var(--pg-accent)]"
                    />
                    <label htmlFor="addRandomNameOption" className="text-sm font-medium text-[var(--pg-text-muted)]">
                      {t('launchModal:addRandomNameOption')}
                      <span className="ml-2 text-xs text-[var(--pg-text-dim)] font-normal">{t('launchModal:addRandomNameOptionHint')}</span>
                    </label>
                    <HelpDot topic="launch.random-name" />
                  </div>

                  {/* Per-team language via flag picker - only when the scenario ships 2+ languages. */}
                  {scenarioLanguages.length >= 2 && (
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        id="allowPlayerLanguageChoice"
                        checked={!!config.allowPlayerLanguageChoice}
                        onChange={(e) => setConfig({ ...config, allowPlayerLanguageChoice: e.target.checked })}
                        className="w-5 h-5 accent-[var(--pg-accent)]"
                      />
                      <label htmlFor="allowPlayerLanguageChoice" className="text-sm font-medium text-[var(--pg-text-muted)]">
                        {t('launchModal:allowPlayerLanguageChoice')}
                        <span className="ml-2 text-xs text-[var(--pg-text-dim)] font-normal">{t('launchModal:allowPlayerLanguageChoiceHint')}</span>
                      </label>
                      <HelpDot topic="launch.player-language" />
                    </div>
                  )}
                </div>
              ) : (
                <div className="ml-1">
                  <TracksRadioGroup
                    label={t('launchModal:autoNameSourceLabel')}
                    name="mysteryAutoNameSource"
                    options={[
                      { key: 'pool', label: t('launchModal:useNamePoolRandom') },
                      { key: 'chip', label: t('launchModal:useChipName') },
                    ]}
                    value={config.useNamePool ? 'pool' : 'chip'}
                    onChange={(k) => setConfig({ ...config, useNamePool: k === 'pool' })}
                  />
                </div>
              )}

              {/* Reuse finished chips - a chip that completed a game can start a
                  fresh one after a cooldown. */}
              <div className="flex items-center gap-3 pt-3 border-t border-[var(--pg-line)]">
                <input
                  type="checkbox"
                  id="reuseCards"
                  checked={!!config.reuseCards}
                  onChange={(e) => setConfig({ ...config, reuseCards: e.target.checked })}
                  className="w-5 h-5 accent-[var(--pg-accent)]"
                />
                <label htmlFor="reuseCards" className="text-sm font-medium text-[var(--pg-text-muted)]">
                  {t(isMystery ? 'launchModal:reusePuces' : 'launchModal:reuseCards')}
                  <span className="ml-2 text-xs text-[var(--pg-text-dim)] font-normal">{t(isMystery ? 'launchModal:reusePucesHint' : 'launchModal:reuseCardsHint')}</span>
                </label>
                <HelpDot topic="launch.reuse-cards" />
              </div>
              {config.reuseCards && (
                <div className="ml-8 space-y-2">
                  <label htmlFor="reuseDelayMinutes" className="pg-label">
                    {t(isMystery ? 'launchModal:reuseDelayPucesMinutes' : 'launchModal:reuseDelayMinutes')}
                  </label>
                  <input
                    type="number"
                    id="reuseDelayMinutes"
                    min="0"
                    value={config.reuseDelayMinutes ?? 5}
                    onChange={(e) => setConfig({ ...config, reuseDelayMinutes: Math.max(0, parseInt(e.target.value) || 0) })}
                    className="pg-input"
                    required
                  />
                </div>
              )}
            </div>
          )}

          {/* Parcours (Tracks) - the studio-enabled route set, multi-select, in
              its own section. Selecting 2+ parcours forces a fixed roster
              (auto-register off) and each team is assigned a route in order on
              the team step. Hidden when only one parcours is offered
              (auto-selected). */}
          {isTracks && tracksOptions.routes.length > 1 && (
            <div className="space-y-4 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
              <TracksCheckboxGroup
                label={t('launchModal:tracksRoute')}
                options={tracksOptions.routes.map((k) => ({ key: k, label: TRACKS_ROUTE_LABELS[k] ? t(TRACKS_ROUTE_LABELS[k]) : k }))}
                value={config.routes ?? (config.route ? [config.route] : [])}
                onChange={(keys) =>
                  setConfig({
                    ...config,
                    routes: keys,
                    // `route` stays the primary/fallback (first selected).
                    route: keys[0] ?? config.route,
                    // Several routes ⇒ a pre-built roster is required to assign
                    // them in order, so auto-register and self-registration (with
                    // its children) are off. Start mode and the auto-name source
                    // stay as chosen - the "Puces et noms d'équipes" card keeps
                    // rendering for multi-route, minus self-registration.
                    ...(keys.length > 1
                      ? {
                          autoRegisterTeam: false,
                          selfRegisterTeam: false,
                          addRandomNameOption: false,
                          allowPlayerLanguageChoice: false,
                        }
                      : {}),
                  })
                }
                hint={t('launchModal:tracksRoutesHint')}
              />
            </div>
          )}

          {isTracks && (
            <div className="space-y-4 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
              <TracksRadioGroup
                label={t('launchModal:tracksDisplayMode')}
                name="tracksDisplay"
                options={tracksOptions.displays.map((k) => ({ key: k, label: TRACKS_DISPLAY_LABELS[k] ? t(TRACKS_DISPLAY_LABELS[k]) : k }))}
                value={config.displayMode ?? ''}
                onChange={(k) => setConfig({ ...config, displayMode: k })}
              />
              <TracksRadioGroup
                label={t('launchModal:tracksPlayMode')}
                name="tracksPlayMode"
                options={tracksOptions.playModes.map((k) => ({ key: k, label: TRACKS_PLAY_MODE_LABELS[k] ? t(TRACKS_PLAY_MODE_LABELS[k]) : k }))}
                value={config.trackPlayMode ?? ''}
                onChange={(k) => setConfig({ ...config, trackPlayMode: k as 'itinerary' | 'free' })}
              />
              <TracksRadioGroup
                label={t('launchModal:tracksScoreType')}
                name="tracksScoreType"
                options={tracksOptions.scoreTypes.map((s) => ({ key: s.key, label: TRACKS_SCORE_TYPE_LABELS[s.key] ? t(TRACKS_SCORE_TYPE_LABELS[s.key]) : s.key }))}
                value={config.scoreType ?? ''}
                onChange={(k) => setConfig({ ...config, scoreType: k as 'percentage' | 'points' })}
                helpDot={<HelpDot topic="launch.score-type" />}
              />

              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-[var(--pg-text)]">{t('launchModal:tracksCluesSectionTitle')}</h3>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!config.cluesPage?.enabled}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        cluesPage: {
                          enabled: e.target.checked,
                          show_title: config.cluesPage?.show_title ?? true,
                          show_text: config.cluesPage?.show_text ?? true,
                          show_image: config.cluesPage?.show_image ?? true,
                        },
                      })
                    }
                    className="mt-0.5 w-4 h-4 accent-[var(--pg-accent)]"
                  />
                  <span>
                    <span className="font-medium text-[var(--pg-text)]">
                      {t('launchModal:tracksCluesPage')}
                    </span>
                    <span className="block text-xs text-[var(--pg-text-dim)]">
                      {t('launchModal:tracksCluesPageHint')}
                    </span>
                  </span>
                </label>
                {config.cluesPage?.enabled && (
                  <div className="ml-6 mt-2 space-y-1.5">
                    {(
                      [
                        ['show_title', 'tracksCluesShowTitle'],
                        ['show_text', 'tracksCluesShowText'],
                        ['show_image', 'tracksCluesShowImage'],
                      ] as const
                    ).map(([key, i18nKey]) => (
                      <label
                        key={key}
                        className="flex items-center gap-2 text-sm text-[var(--pg-text-muted)]"
                      >
                        <input
                          type="checkbox"
                          checked={config.cluesPage?.[key] !== false}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              cluesPage: {
                                enabled: config.cluesPage?.enabled ?? true,
                                show_title: config.cluesPage?.show_title ?? true,
                                show_text: config.cluesPage?.show_text ?? true,
                                show_image: config.cluesPage?.show_image ?? true,
                                [key]: e.target.checked,
                              },
                            })
                          }
                          className="w-4 h-4 accent-[var(--pg-accent)]"
                        />
                        <span>{t(`launchModal:${i18nKey}`)}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {(hasOnDemandCards || isMystery) && (
          <div className="space-y-4 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
            {hasOnDemandCards && (
              <div className="flex items-center gap-3 pb-3 border-b border-[var(--pg-line)]">
                <input
                  type="checkbox"
                  id="useOnDemandCards"
                  checked={useOnDemandCards}
                  onChange={(e) => {
                    setUseOnDemandCards(e.target.checked);
                    if (!e.target.checked) {
                      const newMax = availableChips.length;
                      if (newMax > 0) {
                        setConfig(prev => {
                          const clampedTeams = Math.min(prev.numberOfTeams, newMax);
                          const clampedFirst = Math.max(1, Math.min(prev.firstChipIndex, newMax - clampedTeams + 1));
                          return { ...prev, numberOfTeams: clampedTeams, firstChipIndex: clampedFirst };
                        });
                      }
                    }
                  }}
                  className="w-5 h-5 accent-[var(--pg-accent)]"
                />
                <label htmlFor="useOnDemandCards" className="text-sm font-medium text-[var(--pg-text-muted)]">
                  {t('launchModal:useOnDemandCards')}
                  <span className="ml-2 text-xs text-[var(--pg-text-dim)]">{t('launchModal:additionalCardsAvailable', { count: onDemandChips.length })}</span>
                </label>
              </div>
            )}

            {isMystery && (
            <>
            {/* The idle (between-teams) screen shows whenever no reveal is on
                screen - before the first team and between teams. */}
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="showIdleLayout"
                checked={config.showIdleLayout ?? true}
                onChange={(e) => setConfig({ ...config, showIdleLayout: e.target.checked })}
                className="w-5 h-5 shrink-0 accent-[var(--pg-accent)]"
              />
              <label htmlFor="showIdleLayout" className="text-sm font-medium text-[var(--pg-text-muted)]">
                {t('launchModal:showIdleLayout')}
                <span className="ml-2 text-xs text-[var(--pg-text-dim)] font-normal">
                  {t('launchModal:showIdleLayoutHint')}
                </span>
              </label>
            </div>

            {(config.showIdleLayout ?? true) && (
            <div className="ml-8 space-y-2">
              <label htmlFor="idleSubtitle" className="pg-label">
                {t('launchModal:idleSubtitle')}
              </label>
              <input
                type="text"
                id="idleSubtitle"
                value={config.idleSubtitle ?? ''}
                onChange={(e) => setConfig({ ...config, idleSubtitle: e.target.value })}
                placeholder={t('launchModal:idleSubtitlePlaceholder')}
                className="pg-input"
              />
              <p className="text-xs text-[var(--pg-text-dim)]">
                {t('launchModal:idleSubtitleHint')}
              </p>
            </div>
            )}
            </>
            )}
            </div>
          )}

            {/* Advanced settings - its own collapsible card/section. */}
            <div className="space-y-4 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="text-sm text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] transition"
              >
                {showAdvanced ? '▾' : '▸'} {t('launchModal:advanced')}
              </button>
              {showAdvanced && (
                <div className="mt-4 space-y-4">
                  {/* The Purge (Clash) - once per game, a clan can punch the purge
                      station to reset the leading clan's strongest territory to
                      neutral. Only offered when the scenario ships a purge image
                      (no built-in fallback marker exists). The station must not
                      collide with a territory balise - HARD launch gate. */}
                  {isClash && (
                    <div className="space-y-2">
                      <div className="text-sm font-semibold text-[var(--pg-text)]">{t('launchModal:thePurge')}</div>
                      {clashHasPurgeImage ? (
                        <>
                          <div className="flex items-center gap-3">
                            <input
                              type="checkbox"
                              id="clashPurgeEnabled"
                              checked={!!config.clashPurgeEnabled}
                              onChange={(e) => setConfig({ ...config, clashPurgeEnabled: e.target.checked })}
                              className="w-5 h-5 accent-[var(--pg-accent)]"
                            />
                            <label htmlFor="clashPurgeEnabled" className="text-sm font-medium text-[var(--pg-text-muted)]">
                              {t('launchModal:enablePurge')}
                              <span className="ml-2 text-xs text-[var(--pg-text-dim)] font-normal">
                                {t('launchModal:purgeNote')}
                              </span>
                            </label>
                          </div>
                          {config.clashPurgeEnabled && (
                            <div className="space-y-1 ml-8">
                              <label className="pg-label" htmlFor="clashPurgeStation">{t('launchModal:purgeStation')}</label>
                              <input
                                type="number"
                                id="clashPurgeStation"
                                min="1"
                                value={config.clashPurgeStation ?? clashPurgeStationSeed}
                                onChange={(e) =>
                                  setConfig({
                                    ...config,
                                    clashPurgeStation: Math.max(
                                      1,
                                      parseInt(e.target.value) || clashPurgeStationSeed,
                                    ),
                                  })
                                }
                                className="pg-input w-28"
                              />
                              <p className="text-xs text-[var(--pg-text-dim)]">
                                {t('launchModal:purgeStationHint')}
                              </p>
                            </div>
                          )}
                          {clashPurgeCollision && (
                            <p className="text-xs text-red-400 flex items-start gap-1.5 ml-8">
                              <span aria-hidden>⛔</span>
                              <span>
                                {t('launchModal:purgeCollision', {
                                  station: clashPurgeCollision.station,
                                  territory: clashPurgeCollision.territory,
                                })}
                              </span>
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="text-xs text-[var(--pg-text-dim)]">
                          {t('launchModal:purgeUnavailable')}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Pattern (Mystery + Tracks + TagQuest) - read-only with a Modify
                      toggle so the scenario's own pattern isn't changed by accident.
                      For Tracks it binds each checkpoint to a physical station
                      (positional), so a row-count mismatch is surfaced below. */}
                  {(isMystery || isTracks || isTagQuest) && (
                    <div className="space-y-2">
                      <label className="pg-label">{t('launchModal:pattern')}</label>
                      {editPattern ? (
                        <select
                          id="pattern"
                          value={config.pattern}
                          onChange={(e) => setConfig({ ...config, pattern: e.target.value })}
                          className="pg-select"
                          required
                        >
                          {patternFolders.length === 0 ? (
                            <option value="">{t('launchModal:loadingPatterns')}</option>
                          ) : (
                            patternFolders.map((option) => (
                              <option key={option.uniqid || option.slug} value={option.uniqid}>
                                {option.name}
                              </option>
                            ))
                          )}
                        </select>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-[var(--pg-text-muted)]">
                            {patternFolders.find((o) => o.uniqid === config.pattern)?.name ?? t('launchModal:loadingPatterns')}
                          </span>
                          <button
                            type="button"
                            onClick={() => setEditPattern(true)}
                            className="inline-flex items-center gap-1 text-xs text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] transition"
                            title={t('launchModal:modify')}
                          >
                            ✏️ {t('launchModal:modify')}
                          </button>
                        </div>
                      )}
                      {isTracks && tracksPatternWarning && (
                        <p className="text-xs text-amber-300/90 flex items-start gap-1.5">
                          <span aria-hidden>⚠️</span>
                          <span>{tracksPatternWarning}</span>
                        </p>
                      )}
                    </div>
                  )}

                  {/* Animation timings. */}
                  <div className="space-y-3">
                    {isMystery && (
                      <div className="text-sm font-semibold text-[var(--pg-text)]">{t('launchModal:advAnimation')}</div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label htmlFor="messageDisplayDuration" className="pg-label">
                          {t('launchModal:messageDisplayDuration')}
                        </label>
                        <input
                          type="number"
                          id="messageDisplayDuration"
                          min="1"
                          value={config.messageDisplayDuration}
                          onChange={(e) => setConfig({ ...config, messageDisplayDuration: parseInt(e.target.value) || 1 })}
                          className="pg-input"
                        />
                      </div>
                      <div className="space-y-2">
                        <label htmlFor="enigmaImageDisplayDuration" className="pg-label">
                          {t('launchModal:imageDisplayDuration')}
                        </label>
                        <input
                          type="number"
                          id="enigmaImageDisplayDuration"
                          min="1"
                          value={config.enigmaImageDisplayDuration}
                          onChange={(e) => setConfig({ ...config, enigmaImageDisplayDuration: parseInt(e.target.value) || 1 })}
                          className="pg-input"
                        />
                      </div>
                    </div>
                  </div>

                  {/* First-bip videos - moved into Advanced. Quest has no per-team
                      first bip: its videos play once, when the game starts. */}
                  {(hasTutorialVideo || hasIntroVideo) && (
                    <div className="space-y-3 p-4 bg-[var(--pg-surface-3)] rounded-[var(--pg-radius-md)]">
                      <div className="text-sm font-medium text-[var(--pg-text-muted)]">{t(isTagQuest ? 'launchModal:startVideos' : 'launchModal:firstBipVideos')}</div>
                      {hasTutorialVideo && (
                        <label className="flex items-center gap-3 text-sm text-[var(--pg-text-muted)]">
                          <input
                            type="checkbox"
                            checked={!!config.playTutorialOnBip}
                            onChange={(e) => setConfig({ ...config, playTutorialOnBip: e.target.checked })}
                          />
                          {t(isTagQuest ? 'launchModal:playTutorialVideoAtStart' : 'launchModal:playTutorialVideo')}
                        </label>
                      )}
                      {hasIntroVideo && (
                        <label className="flex items-center gap-3 text-sm text-[var(--pg-text-muted)]">
                          <input
                            type="checkbox"
                            checked={!!config.playIntroOnBip}
                            onChange={(e) => setConfig({ ...config, playIntroOnBip: e.target.checked })}
                          />
                          {t(isTagQuest ? 'launchModal:playIntroVideoAtStart' : 'launchModal:playIntroVideo')}
                        </label>
                      )}
                      <p className="text-xs text-[var(--pg-text-dim)]">
                        {t(isTagQuest ? 'launchModal:startVideosHint' : 'launchModal:firstBipVideosHint')}
                      </p>
                    </div>
                  )}

                  {/* Réinitialisation après passage équipe - Mystery only. */}
                  {isMystery && (
                    <div className="space-y-3 pt-3 border-t border-[var(--pg-line)]">
                      <div className="text-sm font-semibold text-[var(--pg-text)]">{t('launchModal:advReset')}</div>
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          id="enterToReset"
                          checked={config.enterToReset ?? false}
                          onChange={(e) => setConfig({ ...config, enterToReset: e.target.checked })}
                          className="w-5 h-5 shrink-0 accent-[var(--pg-accent)]"
                        />
                        <label htmlFor="enterToReset" className="text-sm font-medium text-[var(--pg-text-muted)]">
                          {t('launchModal:enterToReset')}
                          <span className="ml-2 text-xs text-[var(--pg-text-dim)] font-normal">{t('launchModal:enterToResetHint')}</span>
                        </label>
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          id="autoResetTeam"
                          checked={config.autoResetTeam}
                          onChange={(e) => setConfig({ ...config, autoResetTeam: e.target.checked })}
                          className="w-5 h-5 shrink-0 accent-[var(--pg-accent)]"
                        />
                        <label htmlFor="autoResetTeam" className="text-sm font-medium text-[var(--pg-text-muted)]">
                          {t('launchModal:autoResetPage')}
                          <span className="ml-2 text-xs text-[var(--pg-text-dim)] font-normal">{t('launchModal:autoResetPageHint')}</span>
                        </label>
                        <HelpDot topic="launch.auto-reset" />
                      </div>
                      {config.autoResetTeam && (
                        <div className="ml-8 space-y-2">
                          <label htmlFor="delayBeforeReset" className="pg-label">
                            {t('launchModal:delayBeforeReset')}
                          </label>
                          <input
                            type="number"
                            id="delayBeforeReset"
                            min="0"
                            value={config.delayBeforeReset}
                            onChange={(e) => setConfig({ ...config, delayBeforeReset: parseInt(e.target.value) || 0 })}
                            className="pg-input"
                            required
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Autres - Mystery groups colourblind + malus under a heading;
                      other game types keep these flat. */}
                  {isMystery ? (
                    <div className="space-y-3 pt-3 border-t border-[var(--pg-line)]">
                      <div className="text-sm font-semibold text-[var(--pg-text)]">{t('launchModal:advOther')}</div>
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          id="colorblindMode"
                          checked={config.colorblindMode}
                          onChange={(e) => setConfig({ ...config, colorblindMode: e.target.checked })}
                          className="w-5 h-5 accent-[var(--pg-accent)]"
                        />
                        <label htmlFor="colorblindMode" className="text-sm font-medium text-[var(--pg-text-muted)]">
                          {t('launchModal:colorblindMode')}
                        </label>
                      </div>
                      <div className="space-y-2">
                        <label htmlFor="mysteryMalusPerMinute" className="pg-label">
                          {t('launchModal:malusPerMinute')}
                        </label>
                        <input
                          type="number"
                          id="mysteryMalusPerMinute"
                          min={0}
                          value={config.malusPerMinute ?? 0}
                          onChange={(e) =>
                            setConfig({ ...config, malusPerMinute: Math.max(0, parseInt(e.target.value) || 0) })
                          }
                          className="pg-input"
                        />
                        <p className="text-xs text-[var(--pg-text-dim)]">
                          {t('launchModal:malusPerMinuteHint')}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* Clash has no colourblind rendering - option hidden there. */}
                      {!isClash && (
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            id="colorblindMode"
                            checked={config.colorblindMode}
                            onChange={(e) => setConfig({ ...config, colorblindMode: e.target.checked })}
                            className="w-5 h-5 accent-[var(--pg-accent)]"
                          />
                          <label htmlFor="colorblindMode" className="text-sm font-medium text-[var(--pg-text-muted)]">
                            {t('launchModal:colorblindMode')}
                          </label>
                        </div>
                      )}

                      {isTagQuest && (
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            id="tagquestShowQuestPreview"
                            checked={config.tagquestShowQuestPreview ?? true}
                            onChange={(e) => setConfig({ ...config, tagquestShowQuestPreview: e.target.checked })}
                            className="w-5 h-5 shrink-0 accent-[var(--pg-accent)]"
                          />
                          <label htmlFor="tagquestShowQuestPreview" className="text-sm font-medium text-[var(--pg-text-muted)]">
                            {t('launchModal:showQuestPreview')}
                            <span className="ml-2 text-xs text-[var(--pg-text-dim)] font-normal">{t('launchModal:showQuestPreviewHint')}</span>
                          </label>
                        </div>
                      )}

                      {isTagQuest && (
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            id="tagquestShowMissingStations"
                            checked={config.tagquestShowMissingStations ?? true}
                            onChange={(e) => setConfig({ ...config, tagquestShowMissingStations: e.target.checked })}
                            className="w-5 h-5 shrink-0 accent-[var(--pg-accent)]"
                          />
                          <label htmlFor="tagquestShowMissingStations" className="text-sm font-medium text-[var(--pg-text-muted)]">
                            {t('launchModal:showMissingStations')}
                            <span className="ml-2 text-xs text-[var(--pg-text-dim)] font-normal">{t('launchModal:showMissingStationsHint')}</span>
                          </label>
                        </div>
                      )}

                      {/* Effectif weighting only changes anything with a score
                          victory in team mode (speed ranks by time; solo teams
                          all weigh 1), so it's hidden elsewhere. */}
                      {isTagQuest && config.victoryType === 'score' && config.playMode === 'team' && (
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            id="tagquestScoreWeighting"
                            checked={config.tagquestScoreWeighting ?? true}
                            onChange={(e) => setConfig({ ...config, tagquestScoreWeighting: e.target.checked })}
                            className="w-5 h-5 shrink-0 accent-[var(--pg-accent)]"
                          />
                          <label htmlFor="tagquestScoreWeighting" className="text-sm font-medium text-[var(--pg-text-muted)]">
                            {t('launchModal:scoreWeighting')}
                            <span className="ml-2 text-xs text-[var(--pg-text-dim)] font-normal">{t('launchModal:scoreWeightingHint')}</span>
                          </label>
                        </div>
                      )}

                      {isTagQuest && (
                        <div className="space-y-2">
                          <label className="pg-label">
                            {t('launchModal:keepResultOnScreen')}
                          </label>
                          <div className="flex items-center gap-2 text-sm text-[var(--pg-text-muted)]">
                            <input
                              type="number"
                              min={0}
                              max={60}
                              value={config.visibilityHideDelaySec ?? 10}
                              onChange={(e) =>
                                setConfig({
                                  ...config,
                                  visibilityHideDelaySec: Math.max(0, parseInt(e.target.value) || 0),
                                })
                              }
                              className="pg-input !w-16 !px-2 !py-0.5 text-sm"
                            />
                            {t('launchModal:seconds')}
                          </div>
                          <p className="text-xs text-[var(--pg-text-dim)]">
                            {t('launchModal:keepResultOnScreenHint')}
                          </p>
                        </div>
                      )}

                      {isTracks && (
                        <div className="space-y-2">
                          <label htmlFor="malusPerMinute" className="pg-label">
                            {t('launchModal:malusPerMinute')}
                          </label>
                          <input
                            type="number"
                            id="malusPerMinute"
                            min={0}
                            value={config.malusPerMinute ?? tracksOptions.defaultMalus}
                            onChange={(e) =>
                              setConfig({ ...config, malusPerMinute: Math.max(0, parseInt(e.target.value) || 0) })
                            }
                            className="pg-input"
                          />
                          <p className="text-xs text-[var(--pg-text-dim)]">
                            {t('launchModal:malusPerMinuteHint')}
                          </p>
                        </div>
                      )}
                    </>
                  )}

                  <div className="flex items-center gap-3 pt-1 border-t border-[var(--pg-line)]">
                    <input
                      type="checkbox"
                      id="testMode"
                      checked={config.testMode ?? false}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        setConfig(prev => ({
                          ...prev,
                          testMode: enabled,
                          numberOfTeams: enabled ? Math.min(prev.numberOfTeams, 5) : prev.numberOfTeams,
                        }));
                      }}
                      className="w-5 h-5 accent-amber-500"
                    />
                    <label htmlFor="testMode" className="text-sm font-medium text-amber-400">
                      {t('launchModal:testMode')}
                      <span className="ml-2 text-xs text-[var(--pg-text-dim)] font-normal">{t('launchModal:testModeHint')}</span>
                    </label>
                  </div>
                </div>
              )}
            </div>

          {/* Import a fixed team list for a dynamic-team game. Mystery (and
              auto/self-register Tracks) normally skip the roster step, so this
              lets the operator switch to a fixed roster and import it. */}
          {!isClash && (config.autoRegisterTeam || config.selfRegisterTeam) && (
            <button
              type="button"
              onClick={goToManualRosterStep}
              className="pg-btn pg-btn--ghost text-sm flex items-center gap-1.5 self-start"
            >
              <Upload size={16} />
              {t('launchModal:importRoster')}
            </button>
          )}

          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pt-4 border-t border-[var(--pg-line)]">
            {/* Save-configuration control - persists step-1 settings as a named,
                scenario-assigned preset. Does NOT launch or advance. */}
            <div className="flex items-center gap-2 flex-wrap">
              {!showSaveField ? (
                <button
                  type="button"
                  onClick={() => setShowSaveField(true)}
                  className="pg-btn pg-btn--ghost pg-btn--sm flex items-center gap-2"
                >
                  <Save size={16} />
                  {t('launchModal:saveConfiguration')}
                </button>
              ) : (
                <>
                  <input
                    type="text"
                    value={configName}
                    onChange={(e) => setConfigName(e.target.value)}
                    placeholder={t('launchModal:configurationName')}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleSaveConfigClick();
                      }
                    }}
                    className="pg-input !w-auto text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSaveConfigClick()}
                    disabled={!configName.trim() || savePending}
                    className="pg-btn pg-btn--sm flex items-center gap-2"
                  >
                    <Save size={16} />
                    {savePending ? t('launchModal:saving') : t('launchModal:save')}
                  </button>
                  {savedFlash && (
                    <span className="text-sm text-green-400">{t('launchModal:savedFlash', { name: savedFlash })}</span>
                  )}
                </>
              )}
            </div>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={onClose}
                className="pg-btn pg-btn--ghost"
              >
                {t('launchModal:cancel')}
              </button>
              <button
                type="submit"
                className="pg-btn pg-btn--primary flex items-center gap-2"
              >
                {t('launchModal:next')}
                <ChevronRight size={20} />
              </button>
            </div>
          </div>
          </>
          )}

          {step === 2 && (
            <>
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3 border-b border-[var(--pg-line)] pb-2">
                  <h3 className="text-xl font-semibold text-[var(--pg-text)]">
                    {isClash ? t('launchModal:clashConfigureClans') : t('launchModal:configureTeams')}
                  </h3>
                  {/* Clash deals clan blocks numerically - the roster importer
                      here builds team rows Clash never reads (its own chip→clan
                      import lives on step 1), so it's hidden for Clash. */}
                  {!isClash && (
                    <div className="flex items-center gap-2">
                      {poolNames.length > 0 && teams.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setTeams(prev => applyPoolNames(prev))}
                          className="pg-btn pg-btn--ghost text-sm"
                        >
                          🎲 {t('launchModal:fillFromNamePool')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => rosterFileInputRef.current?.click()}
                        className="pg-btn pg-btn--ghost text-sm flex items-center gap-1.5"
                      >
                        <Upload size={16} />
                        {t('launchModal:importRoster')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void downloadImportTemplate(teamImportMode)}
                        className="pg-btn pg-btn--ghost text-sm flex items-center gap-1.5"
                        title={t('launchModal:downloadTemplate')}
                      >
                        <FileDown size={16} />
                      </button>
                    </div>
                  )}
                </div>
                <input
                  ref={rosterFileInputRef}
                  type="file"
                  accept=".csv,.xls,.xlsx"
                  onChange={handleRosterFileChange}
                  className="hidden"
                />
                {importError && (
                  <div className="px-4 py-3 rounded-[var(--pg-radius-md)] text-sm bg-[var(--pg-danger-soft,#3d1620)] text-[var(--pg-danger,#f87171)]">
                    {importError}
                  </div>
                )}

                {/* Roster counts live on this step for the launches that build
                    their teams here: mass-start Mystery/Tracks and predetermined
                    TagQuest. Each change rebuilds the roster below in place. */}
                {(((isMystery || isTracks) && config.massStart) || (isTagQuest && !config.tagquestSelfRegister)) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
                    <div className="space-y-2">
                      <label htmlFor="rosterNumberOfTeams" className="pg-label">
                        {t('launchModal:numberOfTeams')}
                        {totalMaxTeams !== undefined && (
                          <span className="ml-2 text-xs text-[var(--pg-text-dim)]">
                            {t('launchModal:maxCount', { max: totalMaxTeams })}
                          </span>
                        )}
                      </label>
                      <input
                        type="number"
                        id="rosterNumberOfTeams"
                        min="1"
                        max={config.testMode ? Math.min(maxTeams ?? 5, 5) : maxTeams}
                        value={config.numberOfTeams}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 1;
                          const effectiveMax = config.testMode ? Math.min(maxTeams ?? 5, 5) : maxTeams;
                          const clampedTeams = effectiveMax !== undefined ? Math.min(val, effectiveMax) : val;
                          const clampedFirst = maxTeams !== undefined
                            ? Math.max(1, Math.min(config.firstChipIndex, maxTeams - clampedTeams + 1))
                            : config.firstChipIndex;
                          rebuildRosterFromCounts({ numberOfTeams: clampedTeams, firstChipIndex: clampedFirst });
                        }}
                        className="pg-input"
                        required
                      />
                      {maxTeams !== undefined && config.numberOfTeams > maxTeams && (
                        <p className="text-xs text-red-400">{t('launchModal:exceedsAvailableCards', { max: maxTeams })}</p>
                      )}
                      {/* TagQuest team mode: chips per team shapes the roster too,
                          so it moved here with the counts. */}
                      {isTeamMode && (
                        <div className="mt-3 space-y-2">
                          <label htmlFor="rosterTeammatesPerTeam" className="pg-label">
                            {t('launchModal:teammatesPerTeam')}
                            {allChips.length > 0 && (
                              <span className="ml-2 text-xs text-[var(--pg-text-dim)]">
                                {t('launchModal:chipsNeededAvailable', { needed: totalChipsNeeded, available: allChips.length })}
                              </span>
                            )}
                          </label>
                          <input
                            type="number"
                            id="rosterTeammatesPerTeam"
                            min="2"
                            value={config.teammatesPerTeam ?? 2}
                            onChange={(e) => {
                              const val = Math.max(2, parseInt(e.target.value) || 2);
                              const newMax = allChips.length > 0 ? Math.floor(allChips.length / val) : undefined;
                              const clampedTeams = newMax !== undefined ? Math.min(config.numberOfTeams, newMax) : config.numberOfTeams;
                              rebuildRosterFromCounts({ teammatesPerTeam: val, numberOfTeams: clampedTeams });
                            }}
                            className="pg-input"
                          />
                        </div>
                      )}
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="rosterFirstChipIndex" className="pg-label">
                        {t('launchModal:indexOfFirstChip')}
                      </label>
                      <input
                        type="number"
                        id="rosterFirstChipIndex"
                        min="1"
                        {...(maxFirstChipIndex !== undefined ? { max: maxFirstChipIndex } : {})}
                        value={config.firstChipIndex}
                        onChange={(e) => {
                          let val = Math.max(1, parseInt(e.target.value) || 1);
                          if (maxFirstChipIndex !== undefined) val = Math.min(val, maxFirstChipIndex);
                          rebuildRosterFromCounts({ firstChipIndex: val });
                        }}
                        className="pg-input"
                        required
                      />
                    </div>
                  </div>
                )}

                {/* Clash "Équipes prédéfinies": no roster to edit - the block
                    numbers, then the resulting allocation, chip by chip and
                    editable. The numbers re-deal (dropping hand edits); the
                    chip rows below let the operator add / swap / remove. */}
                {isClashBulk && clashBulkAllocation && (
                  <div className="space-y-4 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
                    {clashBulkAllocation.isImported ? (
                      // An Excel chip→clan import governs the allocation: the
                      // block numbers would say nothing about it, so they hide
                      // until the operator drops back to the automatic deal.
                      <div className="flex items-center gap-3 flex-wrap text-xs text-[var(--pg-text-dim)]">
                        <span>{t('launchModal:clashBulkFromImport', { count: config.clashChipAssignments!.length })}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setClashManualAssignments(null);
                            setConfig({ ...config, clashChipAssignments: undefined });
                          }}
                          className="text-[var(--pg-accent-bright)] hover:underline"
                        >
                          {t('launchModal:clashBulkUseAutomatic')}
                        </button>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label htmlFor="clashChipsPerClan" className="pg-label">{t('launchModal:clashChipsPerClan')}</label>
                          <input
                            type="number"
                            id="clashChipsPerClan"
                            min="0"
                            value={config.clashChipsPerClan ?? 10}
                            onChange={(e) => {
                              // Re-dealing discards hand edits - same rule the
                              // roster counts follow: numbers first, then details.
                              setClashManualAssignments(null);
                              setConfig({ ...config, clashChipsPerClan: Math.max(0, parseInt(e.target.value) || 0) });
                            }}
                            className="pg-input"
                          />
                          <p className="text-xs text-[var(--pg-text-dim)]">
                            {t('launchModal:chipsNeededAvailable', {
                              needed: clashBulkAllocation.needed,
                              available: clashBulkAllocation.freeCount,
                            })}
                          </p>
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="clashFirstChipIndex" className="pg-label">{t('launchModal:indexOfFirstChip')}</label>
                          <input
                            type="number"
                            id="clashFirstChipIndex"
                            min="1"
                            value={config.firstChipIndex}
                            onChange={(e) => {
                              setClashManualAssignments(null);
                              setConfig({ ...config, firstChipIndex: Math.max(1, parseInt(e.target.value) || 1) });
                            }}
                            className="pg-input"
                          />
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="pg-label !mb-0">{t('launchModal:clashBulkPreviewHeading')}</div>
                        {clashBulkAllocation.isManual && (
                          <div className="flex items-center gap-2 text-xs">
                            <span className="text-[var(--pg-text-dim)]">{t('launchModal:clashBulkManualNote')}</span>
                            <button
                              type="button"
                              onClick={() => setClashManualAssignments(null)}
                              className="text-[var(--pg-accent-bright)] hover:underline"
                            >
                              {t('launchModal:clashBulkResetAllocation')}
                            </button>
                          </div>
                        )}
                      </div>

                      {clashBulkAllocation.clans.map((clan) => {
                        const short =
                          !clashBulkAllocation.isManual &&
                          !clashBulkAllocation.isImported &&
                          clan.chipIds.length < Math.max(0, config.clashChipsPerClan ?? 10);
                        const noChipLeft =
                          !clashBulkAllocation.free.some((c) => !clashBulkAllocation.assignedIds.has(c.id));
                        return (
                          <div
                            key={clan.index}
                            className="rounded-[var(--pg-radius-md)] bg-[var(--pg-surface-3)] overflow-hidden"
                          >
                            <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--pg-line)]">
                              <div className="w-7 h-7 rounded-full bg-[var(--pg-accent)] text-white text-xs font-bold flex items-center justify-center flex-shrink-0">
                                {clan.index}
                              </div>
                              <div className="font-medium text-sm text-[var(--pg-text)] flex-1 min-w-0 truncate">
                                {clan.name}
                              </div>
                              <div className={`text-xs ${short ? 'text-red-400' : 'text-[var(--pg-text-dim)]'}`}>
                                {t('launchModal:clashBulkChipCount', { count: clan.chipIds.length })}
                              </div>
                              <button
                                type="button"
                                onClick={() => addClashChip(clan.index)}
                                disabled={noChipLeft}
                                className="pg-btn pg-btn--ghost pg-btn--sm disabled:opacity-40 disabled:cursor-not-allowed"
                                title={noChipLeft ? t('launchModal:clashBulkNoChipLeft') : undefined}
                              >
                                + {t('launchModal:clashBulkAddChip')}
                              </button>
                            </div>
                            {clan.chipIds.length === 0 ? (
                              <p className="px-3 py-2 text-xs text-red-400">{t('launchModal:clashBulkNoChips')}</p>
                            ) : (
                              <div className="p-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                                {clan.chipIds.map((chipId, pos) => (
                                  <div key={`${chipId}-${pos}`} className="flex items-center gap-2">
                                    <select
                                      value={chipId}
                                      onChange={(e) => {
                                        const nextId = parseInt(e.target.value);
                                        editClashClan(clan.index, (ids) =>
                                          ids.map((id, i) => (i === pos ? nextId : id)),
                                        );
                                      }}
                                      className="pg-select !py-1.5 text-xs flex-1 min-w-0"
                                    >
                                      {/* The current chip may be gone from the
                                          free list (imported / now in another
                                          game) - keep it selectable so the row
                                          shows what it holds. */}
                                      {!availableChips.some((c) => c.id === chipId) && (
                                        <option value={chipId}>
                                          {t('launchModal:chipOption', {
                                            number: clashChipById.get(chipId)?.key_number ?? chipId,
                                            name: clashChipById.get(chipId)?.key_name ?? '?',
                                          })}
                                        </option>
                                      )}
                                      {availableChips.map((chip) => {
                                        const takenHere =
                                          clashBulkAllocation.assignedIds.has(chip.id) && chip.id !== chipId;
                                        const takenElsewhere = usedChipIds.has(chip.id);
                                        const isDisabled = takenHere || takenElsewhere;
                                        return (
                                          <option key={chip.id} value={chip.id} disabled={isDisabled}>
                                            {t('launchModal:chipOption', { number: chip.key_number, name: chip.key_name })}
                                            {isDisabled ? t('launchModal:chipInUseSuffix') : ''}
                                          </option>
                                        );
                                      })}
                                    </select>
                                    <button
                                      type="button"
                                      onClick={() => editClashClan(clan.index, (ids) => ids.filter((_, i) => i !== pos))}
                                      className="pg-btn pg-btn--ghost pg-btn--sm !px-2 flex-shrink-0"
                                      title={t('launchModal:clashBulkRemoveChip')}
                                    >
                                      <X size={14} />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {!clashBulkAllocation.isManual &&
                        !clashBulkAllocation.isImported &&
                        clashBulkAllocation.needed > clashBulkAllocation.freeCount && (
                          <p className="text-xs text-red-400">
                            {t('launchModal:clashBulkShortfall', {
                              needed: clashBulkAllocation.needed,
                              available: clashBulkAllocation.freeCount,
                            })}
                          </p>
                        )}
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  {teams.map((team, teamIndex) => {
                    const usedInGame = allUsedTeammateChipIds();

                    if (isTeamMode && team.teammates && team.teammates.length > 0) {
                      return (
                        <div key={teamIndex} className="bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-lg)] border border-[var(--pg-line)] overflow-hidden">
                          <div className="flex items-center gap-3 px-4 py-3 bg-[var(--pg-surface-3)] border-b border-[var(--pg-line)]">
                            <div className="w-8 h-8 bg-[var(--pg-accent)] rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                              {teamIndex + 1}
                            </div>
                            <input
                              type="text"
                              value={team.name}
                              onChange={(e) => updateTeamName(teamIndex, e.target.value)}
                              className="pg-input flex-1 !py-1.5 text-sm font-semibold"
                              placeholder={t('launchModal:teamNamePlaceholder')}
                              required
                            />
                          </div>
                          <div className="divide-y divide-[var(--pg-line)]">
                            {team.teammates.map((mate, mateIndex) => {
                              return (
                                <div key={mateIndex} className="flex items-center gap-3 px-4 py-3">
                                  <div className="w-6 h-6 rounded-full bg-[var(--pg-surface-3)] flex items-center justify-center text-[var(--pg-text-muted)] text-xs font-medium flex-shrink-0">
                                    {mateIndex + 1}
                                  </div>
                                  <div className="flex-shrink-0 min-w-[180px]">
                                    <select
                                      value={mate.chipId}
                                      onChange={(e) => updateTeammateChip(teamIndex, mateIndex, parseInt(e.target.value))}
                                      className="pg-select !py-1.5 text-xs"
                                      required
                                    >
                                      {allChips.map(chip => {
                                        const isUsedHere = usedInGame.has(chip.id) && chip.id !== mate.chipId;
                                        const isUsedInOtherGame = usedChipIds.has(chip.id);
                                        const isDisabled = isUsedHere || isUsedInOtherGame;
                                        return (
                                          <option key={chip.id} value={chip.id} disabled={isDisabled}>
                                            {t('launchModal:chipOption', { number: chip.key_number, name: chip.key_name })}{isDisabled ? t('launchModal:chipInUseSuffix') : ''}
                                          </option>
                                        );
                                      })}
                                    </select>
                                  </div>
                                  <div className="flex-1">
                                    <input
                                      type="text"
                                      value={mate.name}
                                      onChange={(e) => updateTeammateName(teamIndex, mateIndex, e.target.value)}
                                      className="pg-input !py-1.5 text-sm"
                                      placeholder={t('launchModal:teammateNamePlaceholder', { index: mateIndex + 1 })}
                                      required
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={teamIndex} className="flex items-center gap-4 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
                        <div className="flex-shrink-0">
                          <div className="w-10 h-10 bg-[var(--pg-accent)] rounded-full flex items-center justify-center text-white font-bold">
                            {teamIndex + 1}
                          </div>
                        </div>
                        <div className="flex-shrink-0 min-w-[200px]">
                          <select
                            value={team.chipId}
                            onChange={(e) => updateTeamChip(teamIndex, parseInt(e.target.value))}
                            className="pg-select text-sm"
                            required
                          >
                            {allChips.map(chip => {
                              const isUsedInCurrentGame = teams.some((t, i) => i !== teamIndex && t.chipId === chip.id);
                              const isUsedInOtherGame = usedChipIds.has(chip.id);
                              const isDisabled = isUsedInCurrentGame || isUsedInOtherGame;
                              return (
                                <option key={chip.id} value={chip.id} disabled={isDisabled}>
                                  {t('launchModal:chipOption', { number: chip.key_number, name: chip.key_name })}{isDisabled ? t('launchModal:chipInUseSuffix') : ''}
                                </option>
                              );
                            })}
                          </select>
                        </div>
                        <div className="flex-1">
                          <input
                            type="text"
                            value={team.name}
                            onChange={(e) => updateTeamName(teamIndex, e.target.value)}
                            className="pg-input"
                            placeholder={t('launchModal:teamNamePlaceholder')}
                            required
                          />
                        </div>
                        {/* Per-team route - tracks multi-route launch only. Defaults
                            to the in-order assignment (cycling), operator-overridable. */}
                        {multipleRoutes && (
                          <div className="flex-shrink-0 min-w-[160px]">
                            <select
                              value={team.route ?? (config.routes ?? [])[teamIndex % (config.routes?.length || 1)] ?? ''}
                              onChange={(e) => updateTeamRoute(teamIndex, e.target.value)}
                              className="pg-select text-sm"
                              title={t('launchModal:teamRoute')}
                            >
                              {(config.routes ?? []).map((k) => (
                                <option key={k} value={k}>
                                  {TRACKS_ROUTE_LABELS[k] ? t(TRACKS_ROUTE_LABELS[k]) : k}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {/* Per-team display language - only when the scenario ships
                            2+ languages (mystery/tracks). Defaults to the launch language. */}
                        {supportsDynamicTeams && scenarioLanguages.length >= 2 && (
                          <div className="flex-shrink-0 min-w-[140px]">
                            <select
                              value={team.language ?? config.language ?? scenarioDefaultLang}
                              onChange={(e) => updateTeamLanguage(teamIndex, e.target.value)}
                              className="pg-select text-sm"
                              title={t('launchModal:teamLanguage')}
                            >
                              {scenarioLanguages.map((lng) => (
                                <option key={lng} value={lng}>{LANG_NAMES[lng] || lng}</option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 pt-4 border-t border-[var(--pg-line)]">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="pg-btn pg-btn--ghost flex items-center gap-2"
                >
                  <ChevronLeft size={20} />
                  {t('launchModal:back')}
                </button>
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={onClose}
                    className="pg-btn pg-btn--ghost"
                  >
                    {t('launchModal:cancel')}
                  </button>
                  <button
                    type="submit"
                    className="pg-btn pg-btn--primary flex items-center gap-2"
                  >
                    {t('launchModal:next')}
                    <ChevronRight size={20} />
                  </button>
                </div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div>
                <h3 className="text-lg font-semibold text-[var(--pg-text)] mb-1">
                  {t('launchModal:devicesToLaunchOn')}
                </h3>
                <p className="text-sm text-[var(--pg-text-dim)] mb-4">
                  {t('launchModal:devicesToLaunchOnHint')}
                </p>
                {regAssignEnabled && regTeamDefs.length > 0 && (
                  <div className="mb-4 p-3 rounded-[var(--pg-radius-md)] bg-[var(--pg-surface-2)] border border-[var(--pg-line)]">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="font-medium text-[var(--pg-text)]">
                          {t('launchModal:regAssignToggleLabel')}
                        </div>
                        <div className="text-sm text-[var(--pg-text-dim)]">
                          {t('launchModal:regAssignToggleDesc')}
                        </div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={regAssignActive}
                        onClick={() => setRegAssignActive((v) => !v)}
                        className={`relative inline-flex h-7 w-14 shrink-0 items-center rounded-full transition-colors ${
                          regAssignActive ? 'bg-[var(--pg-accent)]' : 'bg-[var(--pg-surface-3)]'
                        }`}
                      >
                        <span
                          className={`inline-block h-5 w-5 shrink-0 transform rounded-full bg-white transition-transform ${
                            regAssignActive ? 'translate-x-8' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                    {regAssignOn && (
                      <p className="mt-2 text-sm text-[var(--pg-text-muted)]">
                        {t('launchModal:regAssignHint')}
                      </p>
                    )}
                  </div>
                )}
                {pairedLoading ? (
                  <p className="text-[var(--pg-text-dim)] text-sm">{t('launchModal:loadingPairedDevices')}</p>
                ) : (
                  <div className="space-y-2">
                    {motherOutdated && (
                      <p className="text-sm text-amber-400 px-1">{t('launchModal:motherOutdatedHint')}</p>
                    )}
                    {(() => {
                      const selfRow = pairedDevices.find((r) => r.id === selfDeviceId);
                      const selfBusy = !!(selfRow && busyDeviceIds.has(selfRow.id));
                      return (
                    /* Mother row - defaults checked so this device participates,
                       but unchecking is allowed (launch a "server-only" mother).
                       When this device is already running a game it can't also
                       run this one, so participation is forced off + disabled -
                       the operator can still launch it onto free devices. */
                    <div className={`bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] ${selfBusy || operatorOnly ? 'opacity-70' : ''}`}>
                    <label className={`flex items-center gap-3 p-3 ${selfBusy || operatorOnly ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--pg-surface-3)]'}`}>
                      <input
                        type="checkbox"
                        checked={motherChecked && !selfBusy && !operatorOnly}
                        disabled={selfBusy || operatorOnly}
                        onChange={(e) => setMotherChecked(e.target.checked)}
                        className="w-4 h-4 accent-[var(--pg-accent)] disabled:opacity-50"
                      />
                      <span className="flex-1 text-[var(--pg-text)] font-medium">
                        {(selfRow && displayDeviceLabel(selfRow.device_label)) || t('launchModal:thisDevice')}{' '}
                        <span className="text-xs text-[var(--pg-text-dim)]">
                          {selfRow?.is_self ? t('launchModal:motherTag') : t('launchModal:thisDeviceTag')}
                        </span>
                      </span>
                      {operatorOnly ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-blue-500/10 text-blue-300">
                          {t('launchModal:operatorOnlyTag')}
                        </span>
                      ) : selfBusy ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-amber-500/10 text-amber-400">
                          {t('launchModal:deviceBusy')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-green-500/10 text-green-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                          {t('launchModal:online')}
                        </span>
                      )}
                      {operatorOnly ? (
                        <span className="text-xs text-blue-300 italic">
                          {t('launchModal:operatorOnlyHostHint')}
                        </span>
                      ) : !motherChecked && !selfBusy && (
                        <span className="text-xs text-amber-400 italic">
                          {t('launchModal:motherHostOnly')}
                        </span>
                      )}
                    </label>
                    {motherChecked && !selfBusy && !operatorOnly && selfRow &&
                      renderRegAssignRow(selfRow.id)}
                    </div>
                      );
                    })()}

                    {/* Paired (non-self) devices */}
                    {pairedDevices.filter(d => d.id !== selfDeviceId).length === 0 ? (
                      <p className="text-sm text-[var(--pg-text-dim)] italic px-1 mt-2">
                        {t('launchModal:noOtherPairedDevices')}
                      </p>
                    ) : (
                      pairedDevices
                        .filter(d => d.id !== selfDeviceId)
                        .map(device => {
                          const busy = busyDeviceIds.has(device.id);
                          const outdated = motherOutdated && device.is_self;
                          const checked = selectedDeviceIds.has(device.id) && !busy && !outdated;
                          return (
                            <div
                              key={device.id}
                              className={`bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] ${
                                busy || outdated || !device.online ? 'opacity-70' : ''
                              }`}
                            >
                            <label
                              className={`flex items-center gap-3 p-3 ${
                                busy || outdated ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--pg-surface-3)]'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={busy || outdated}
                                onChange={(e) => {
                                  setSelectedDeviceIds(prev => {
                                    const next = new Set(prev);
                                    if (e.target.checked) next.add(device.id);
                                    else next.delete(device.id);
                                    return next;
                                  });
                                }}
                                className="w-4 h-4 accent-[var(--pg-accent)] disabled:opacity-50"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="text-[var(--pg-text)] font-medium truncate">
                                  {displayDeviceLabel(device.device_label) || t('devicesModal:unknownDevice')}
                                  {/* Only reachable on a child: the mother's row is
                                      a regular launch target there. */}
                                  {device.is_self && (
                                    <span className="ml-1.5 text-xs font-normal text-[var(--pg-text-dim)]">{t('launchModal:motherTag')}</span>
                                  )}
                                </div>
                                {device.peer_os && (
                                  <div className="text-xs text-[var(--pg-text-dim)] truncate">{device.peer_os}</div>
                                )}
                              </div>
                              {busy && (
                                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-amber-500/10 text-amber-400">
                                  {t('launchModal:deviceBusy')}
                                </span>
                              )}
                              {outdated && (
                                <span
                                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-amber-500/10 text-amber-400"
                                  title={t('launchModal:motherOutdatedHint')}
                                >
                                  {t('launchModal:motherOutdated')}
                                </span>
                              )}
                              {/* Reader state is only knowable while the device
                                  is online (it self-reports on ping) - an
                                  offline row's flag is stale, so show nothing. */}
                              {device.online && (
                                <span
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                                    device.has_reader
                                      ? 'bg-green-500/10 text-green-400'
                                      : 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)]'
                                  }`}
                                >
                                  <Usb size={12} />
                                  {device.has_reader ? t('launchModal:reader') : t('launchModal:noReader')}
                                </span>
                              )}
                              <span
                                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs ${
                                  device.online
                                    ? 'bg-green-500/10 text-green-400'
                                    : 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)]'
                                }`}
                              >
                                <span
                                  className={`w-1.5 h-1.5 rounded-full ${
                                    device.online ? 'bg-green-500' : 'bg-[var(--pg-text-dim)]'
                                  }`}
                                />
                                {device.online ? t('launchModal:online') : t('launchModal:offline')}
                              </span>
                            </label>
                            {checked && renderRegAssignRow(device.id)}
                            </div>
                          );
                        })
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-4 pt-4 border-t border-[var(--pg-line)]">
                <button
                  type="button"
                  onClick={() => setStep(skipsRosterStep ? 1 : 2)}
                  className="pg-btn pg-btn--ghost flex items-center gap-2"
                >
                  <ChevronLeft size={20} />
                  {t('launchModal:back')}
                </button>
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={onClose}
                    className="pg-btn pg-btn--ghost"
                  >
                    {t('launchModal:cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={launching || (!motherChecked && selectedDeviceIds.size === 0)}
                    aria-busy={launching}
                    className="inline-flex items-center gap-2 px-6 py-2 bg-green-600 hover:bg-green-500 disabled:bg-[var(--pg-surface-3)] disabled:text-[var(--pg-text-dim)] disabled:cursor-not-allowed text-white rounded-[var(--pg-radius-md)] transition font-medium"
                  >
                    {launching && <Loader2 size={16} className="animate-spin" />}
                    {t('launchModal:launchOnDevices', { count: (motherChecked ? 1 : 0) + selectedDeviceIds.size })}
                  </button>
                </div>
              </div>
            </>
          )}
        </form>
      </div>

      <ConfirmDialog
        isOpen={overwriteConfirm !== null}
        onConfirm={() => overwriteConfirm && void performSaveConfig(overwriteConfirm)}
        onCancel={() => setOverwriteConfirm(null)}
        title={t('launchModal:replaceConfigTitle')}
        message={t('launchModal:replaceConfigMessage', { name: overwriteConfirm })}
        confirmText={t('launchModal:replace')}
        cancelText={t('launchModal:cancel')}
        variant="warning"
      />

      <RosterImportModal
        isOpen={importResult !== null}
        result={importResult}
        capacityWarnings={clashCapacityWarnings}
        onApply={applyRosterImport}
        onCancel={() => setImportResult(null)}
      />
    </div>
  );
}
