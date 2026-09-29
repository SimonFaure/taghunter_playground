import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, Save, X, Monitor, Eye, EyeOff } from 'lucide-react';
import {
  getLaunchedGameMeta,
  updateLaunchedGameMeta,
  getLaunchedGameDevices,
  getLaunchedGameState,
} from '../services/launchedGames';
import * as scenarioStore from '../services/scenarioStore';
import {
  extractTracksOptions,
  EMPTY_TRACKS_OPTIONS,
  type TracksLaunchOptions,
} from '../services/launchResolve';
import {
  TracksRadioGroup,
  TracksCheckboxGroup,
  TRACKS_ROUTE_LABELS,
  TRACKS_DISPLAY_LABELS,
  TRACKS_PLAY_MODE_LABELS,
  TRACKS_SCORE_TYPE_LABELS,
} from './LaunchGameModal';
import { HelpDot } from '../help';
import { formatDbDateTime } from '../utils/dbTime';

interface LaunchedGameConfigModalProps {
  gameId: number;
  gameName: string;
  /** Scenario uniqid - needed to read which tracks routes/modes are enabled. */
  gameUniqid?: string;
  /** Launched-game type ('tracks', 'mystery', …). Drives the tracks section. */
  gameType?: string;
  onClose: () => void;
  onSave: () => void;
}

// Tracks meta keys rendered by the dedicated tracks section (mirroring the
// launch modal), so they're excluded from the generic value/toggle grids.
const TRACKS_SECTION_KEYS = new Set([
  'route',
  'tracks_routes',
  'displayMode',
  'trackPlayMode',
  'scoreType',
  'malusPerMinute',
  'cluesPage',
]);

// Internal / derived meta keys that are never user-editable in this modal,
// regardless of game type (roster shape, name-pool plumbing, language sets…).
const INTERNAL_KEYS = new Set([
  'firstChipIndex',
  'teamsConfig',
  'clash_config',
  'clashRegistrationMode',
  'availableLanguages',
  'namePoolAudience',
  'teammatesPerTeam',
  'language',
  'useNamePool',
  'addRandomNameOption',
  'allowPlayerLanguageChoice',
]);

// Editable keys shared by every "playable" game type. Mirrors the launch
// modal's common + advanced (non-type-specific) fields.
const COMMON_KEYS = [
  'pattern',
  'duration',
  'messageDisplayDuration',
  'enigmaImageDisplayDuration',
  'colorblindMode',
  'testMode',
];

// Per-game-type editable meta keys, mirroring the launch modal so the config
// modal never offers a field that doesn't apply to the type. Tracks' own
// route/display/play/score/malus/clues keys live in the dedicated tracks
// section (TRACKS_SECTION_KEYS), so they're intentionally not listed here.
const KEYS_BY_TYPE: Record<string, string[]> = {
  tagquest: [...COMMON_KEYS, 'victoryType', 'playMode', 'visibilityHideDelaySec', 'tagquestShowQuestPreview', 'tagquestShowMissingStations', 'tagquestScoreWeighting'],
  mystery: [
    ...COMMON_KEYS,
    'autoRegisterTeam',
    'selfRegisterTeam',
    'reuseCards',
    'reuseDelayMinutes',
    'enterToReset',
    'autoResetTeam',
    'delayBeforeReset',
    'showIdleLayout',
    'idleSubtitle',
    'malusPerMinute',
  ],
  tracks: [
    ...COMMON_KEYS,
    'autoRegisterTeam',
    'selfRegisterTeam',
    'reuseCards',
    'reuseDelayMinutes',
  ],
  clash: ['pattern', 'duration', 'testMode'],
};

// Keys rendered as bespoke card pickers (not in the generic value/toggle grids).
const PICKER_KEYS = new Set(['victoryType', 'playMode']);

// Per-game-type set of keys that may actually be *changed* mid-game. Keys that
// are allowed (visible) but not in this set are shown read-only/disabled, so the
// operator can see the launched value without being able to alter settings that
// can't safely change once the game is running. A game type absent from this map
// keeps every allowed key editable (legacy behaviour).
const EDITABLE_KEYS_BY_TYPE: Record<string, Set<string>> = {
  tagquest: new Set([
    'enigmaImageDisplayDuration', // Durée d'affichage de l'image
    'messageDisplayDuration',     // Durée d'affichage des messages
    'visibilityHideDelaySec',     // Garder le résultat à l'écran
    'colorblindMode',             // Mode daltonien
    'tagquestShowQuestPreview',   // Aperçu des images de quête
    'tagquestShowMissingStations', // Visuel des balises manquantes
    // Pondération par effectif - live-editable: the punch logic re-reads meta
    // on every bip, so flipping it re-scales scores from the next punch on.
    'tagquestScoreWeighting',
  ]),
};

interface CluesPageConfig {
  enabled?: boolean;
  show_title?: boolean;
  show_text?: boolean;
  show_image?: boolean;
}

interface MetaField {
  meta_name: string;
  meta_value: string | null;
}

interface Device {
  id: number;
  device_id: string;
  connected: boolean;
  last_connexion_attempt: string;
}

interface RawData {
  id: number;
  device_id: string;
  raw_data: any;
  created_at: string;
}


export function LaunchedGameConfigModal({ gameId, gameName, gameUniqid, gameType, onClose, onSave }: LaunchedGameConfigModalProps) {
  const { t } = useTranslation();
  const [metaFields, setMetaFields] = useState<MetaField[]>([]);
  const [editedValues, setEditedValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [rawData, setRawData] = useState<Record<string, RawData[]>>({});
  const [showRawData, setShowRawData] = useState<Record<string, boolean>>({});
  // Tracks: which routes/displays/play-modes/score-types the scenario enables
  // (same source the launch modal uses, so the pickers match exactly).
  const [tracksOptions, setTracksOptions] = useState<TracksLaunchOptions>(EMPTY_TRACKS_OPTIONS);
  const isTracks = (gameType ?? '').toLowerCase() === 'tracks';

  useEffect(() => {
    loadMetaFields();
    loadDevices();
  }, [gameId]);

  useEffect(() => {
    if (!isTracks || !gameUniqid) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await scenarioStore.getGameData(gameUniqid);
        if (!cancelled) setTracksOptions(extractTracksOptions(raw));
      } catch (err) {
        console.error('[LaunchedGameConfigModal] tracks options load failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [isTracks, gameUniqid]);

  const loadMetaFields = async () => {
    setLoading(true);
    try {
      const meta = await getLaunchedGameMeta(gameId);
      const fields: MetaField[] = Object.entries(meta)
        .filter(([k]) => k !== 'firstChipIndex')
        .map(([k, v]) => ({ meta_name: k, meta_value: v ?? null }));
      setMetaFields(fields);

      const initialValues: Record<string, string> = {};
      fields.forEach((f) => { initialValues[f.meta_name] = f.meta_value ?? ''; });
      setEditedValues(initialValues);
    } catch (err) {
      console.error('Error loading meta fields:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadDevices = async () => {
    try {
      const rows = await getLaunchedGameDevices(gameId);
      const mapped: Device[] = rows.map((r) => ({
        id: r.id,
        device_id: r.device_label ?? `device-${r.device_id}`,
        connected: Boolean(r.connected),
        last_connexion_attempt: r.last_connection_attempt,
      }));
      setDevices(mapped);
      // Single combined `state` call returns all raw_data; bucket by device_label.
      const state = await getLaunchedGameState(gameId, 0);
      const rawDataMap: Record<string, RawData[]> = {};
      const labelByDeviceId = new Map<number, string>();
      for (const r of rows) labelByDeviceId.set(r.device_id, r.device_label ?? `device-${r.device_id}`);
      for (const punch of state.new_raw_data) {
        const label = labelByDeviceId.get(punch.device_id) ?? `device-${punch.device_id}`;
        if (!rawDataMap[label]) rawDataMap[label] = [];
        rawDataMap[label].push({
          id: punch.id,
          device_id: label,
          raw_data: punch.raw_data,
          created_at: punch.created_at,
        });
      }
      // Newest first
      for (const k of Object.keys(rawDataMap)) {
        rawDataMap[k].sort((a, b) => b.id - a.id);
      }
      setRawData(rawDataMap);
    } catch (err) {
      console.error('Error loading devices:', err);
    }
  };

  const toggleRawData = (deviceId: string) => {
    setShowRawData({
      ...showRawData,
      [deviceId]: !showRawData[deviceId]
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // The server's update_meta atomically replaces the whole bag, so we
      // need the *full* current set, not just the edited fields. Pull fresh
      // (so we don't clobber firstChipIndex which we filtered out of the UI),
      // overlay our edits, push.
      const current = await getLaunchedGameMeta(gameId);
      const next: Record<string, string> = { ...current };
      // Persist every edited key - including tracks keys that the dedicated
      // section may set even if they weren't present in the original meta
      // (firstChipIndex is filtered out of editedValues, so it's preserved).
      for (const [k, v] of Object.entries(editedValues)) {
        if (v !== undefined) next[k] = v;
      }
      await updateLaunchedGameMeta(gameId, next);
    } catch (err) {
      console.error('Error saving meta:', err);
    } finally {
      setSaving(false);
    }
    onSave();
    onClose();
  };

  const getFieldLabel = (metaName: string): string => {
    const labels: Record<string, string> = {
      pattern: t('launchedGameConfig:fieldPattern'),
      duration: t('launchedGameConfig:fieldDuration'),
      messageDisplayDuration: t('launchedGameConfig:fieldMessageDisplayDuration'),
      enigmaImageDisplayDuration: t('launchedGameConfig:fieldEnigmaImageDisplayDuration'),
      colorblindMode: t('launchedGameConfig:fieldColorblindMode'),
      autoResetTeam: t('launchedGameConfig:fieldAutoResetTeam'),
      delayBeforeReset: t('launchedGameConfig:fieldDelayBeforeReset'),
      enterToReset: t('launchedGameConfig:fieldEnterToReset'),
      showIdleLayout: t('launchedGameConfig:fieldShowIdleLayout'),
      idleSubtitle: t('launchedGameConfig:fieldIdleSubtitle'),
      autoRegisterTeam: t('launchedGameConfig:fieldAutoRegisterTeam'),
      reuseCards: t('launchedGameConfig:fieldReuseCards'),
      selfRegisterTeam: t('launchedGameConfig:fieldSelfRegisterTeam'),
      reuseDelayMinutes: t('launchedGameConfig:fieldReuseDelayMinutes'),
      victoryType: t('launchedGameConfig:fieldVictoryType'),
      playMode: t('launchedGameConfig:fieldPlayMode'),
      visibilityHideDelaySec: t('launchedGameConfig:fieldVisibilityHideDelaySec'),
      tagquestShowQuestPreview: t('launchedGameConfig:fieldTagquestShowQuestPreview'),
      tagquestShowMissingStations: t('launchedGameConfig:fieldTagquestShowMissingStations'),
      tagquestScoreWeighting: t('launchedGameConfig:fieldTagquestScoreWeighting'),
      malusPerMinute: t('launchedGameConfig:fieldMalusPerMinute'),
      testMode: t('launchedGameConfig:fieldTestMode'),
    };
    return labels[metaName] || metaName;
  };

  const getFieldType = (metaName: string): 'text' | 'number' | 'checkbox' => {
    if (metaName === 'colorblindMode' || metaName === 'autoResetTeam' ||
        metaName === 'autoRegisterTeam' || metaName === 'reuseCards' ||
        metaName === 'selfRegisterTeam' || metaName === 'enterToReset' ||
        metaName === 'showIdleLayout' || metaName === 'testMode' ||
        metaName === 'tagquestShowQuestPreview' ||
        metaName === 'tagquestShowMissingStations' ||
        metaName === 'tagquestScoreWeighting') {
      return 'checkbox';
    }
    if (metaName === 'duration' || metaName === 'messageDisplayDuration' ||
        metaName === 'enigmaImageDisplayDuration' || metaName === 'delayBeforeReset' ||
        metaName === 'reuseDelayMinutes' || metaName === 'visibilityHideDelaySec' ||
        metaName === 'malusPerMinute') {
      return 'number';
    }
    return 'text';
  };

  const handleValueChange = (metaName: string, value: string | boolean) => {
    const stringValue = typeof value === 'boolean' ? value.toString() : value;
    setEditedValues({
      ...editedValues,
      [metaName]: stringValue
    });
  };

  // Bucket the dynamic meta fields into the same visual groups the launch
  // modal uses: the card pickers (victory type / play mode), a 2-column grid of
  // value fields (number/text), and a panel of toggle rows (checkboxes).
  //
  // Fields are first filtered to the keys that apply to *this* game type
  // (mirroring the launch modal): internal/derived plumbing is always hidden,
  // tracks' own keys live in the dedicated section, and an unknown game type
  // falls back to showing every non-internal key (legacy behaviour). Dependent
  // sub-fields are then hidden unless their parent toggle is on, so the modal
  // never offers an option that has no effect.
  const typeKey = (gameType ?? '').toLowerCase();
  const allowList = KEYS_BY_TYPE[typeKey];
  const keyAllowed = (name: string): boolean => {
    if (INTERNAL_KEYS.has(name)) return false;
    if (isTracks && TRACKS_SECTION_KEYS.has(name)) return false;
    return allowList ? allowList.includes(name) : true;
  };
  const editableSet = EDITABLE_KEYS_BY_TYPE[typeKey];
  // A field is editable when the type imposes no editable-set (legacy: all
  // allowed keys editable) or the key is explicitly in that set.
  const keyEditable = (name: string): boolean => !editableSet || editableSet.has(name);
  const keyVisible = (name: string): boolean => {
    if (!keyAllowed(name)) return false;
    switch (name) {
      // Mystery: the idle subtitle only applies when the idle layout is shown.
      case 'idleSubtitle':
        return editedValues.showIdleLayout !== 'false';
      // Children that only matter when their parent toggle is on.
      case 'delayBeforeReset':
        return editedValues.autoResetTeam === 'true';
      case 'reuseDelayMinutes':
        return editedValues.reuseCards === 'true';
      case 'selfRegisterTeam':
        return editedValues.autoRegisterTeam === 'true';
      // Effectif weighting only applies with a score victory in team mode.
      case 'tagquestScoreWeighting':
        return editedValues.victoryType === 'score' && editedValues.playMode === 'team';
      default:
        return true;
    }
  };
  const victoryFields = metaFields.filter((f) => f.meta_name === 'victoryType' && keyVisible(f.meta_name));
  const playModeField = metaFields.find((f) => f.meta_name === 'playMode' && keyVisible('playMode'));
  const toggleFields = metaFields.filter((f) => getFieldType(f.meta_name) === 'checkbox' && keyVisible(f.meta_name));
  const valueFields = metaFields.filter((f) => {
    if (!keyVisible(f.meta_name)) return false;
    if (PICKER_KEYS.has(f.meta_name)) return false;
    return getFieldType(f.meta_name) !== 'checkbox';
  });

  // ── Tracks section state derived from editedValues ──
  const tracksRoutesValue = editedValues.tracks_routes
    ? editedValues.tracks_routes.split(',').filter(Boolean)
    : (editedValues.route ? [editedValues.route] : []);
  const handleTracksRoutesChange = (keys: string[]) => {
    setEditedValues((prev) => ({
      ...prev,
      tracks_routes: keys.join(','),
      route: keys[0] ?? prev.route ?? '',
    }));
  };
  const cluesConfig: CluesPageConfig = (() => {
    try {
      return editedValues.cluesPage ? (JSON.parse(editedValues.cluesPage) as CluesPageConfig) : {};
    } catch {
      return {};
    }
  })();
  const setCluesConfig = (next: CluesPageConfig) => handleValueChange('cluesPage', JSON.stringify(next));

  // After per-type filtering the raw meta bag can be non-empty yet have nothing
  // to show - drive the empty state off the visible buckets, not the raw count.
  const hasVisibleFields =
    isTracks || victoryFields.length > 0 || !!playModeField || toggleFields.length > 0 || valueFields.length > 0;

  return (
    <div className="pg-overlay" onClick={onClose}>
      <div
        className="relative w-full h-full max-w-4xl max-h-screen overflow-auto bg-[var(--pg-bg)] shadow-2xl md:rounded-[var(--pg-radius-lg)] md:m-8 md:h-auto md:max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between p-6 bg-[var(--pg-surface)] border-b border-[var(--pg-line)]">
          <div className="min-w-0">
            <h2 className="pg-modal-title text-2xl flex items-center gap-2">
              <Settings size={24} className="text-[var(--pg-accent-bright)] shrink-0" />
              {t('launchedGameConfig:heading')}
            </h2>
            <p className="mt-1 text-sm text-[var(--pg-text-dim)] truncate">
              {t('launchedGameConfig:gameLabel')}{' '}
              <span className="text-[var(--pg-text)] font-semibold">{gameName}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="pg-modal-close shrink-0"
            title={t('launchedGameConfig:close')}
          >
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-6">
        {loading ? (
          <div className="text-center py-12 text-[var(--pg-text-dim)]">{t('launchedGameConfig:loading')}</div>
        ) : !hasVisibleFields ? (
          <div className="text-center py-12 text-[var(--pg-text-dim)]">{t('launchedGameConfig:noFields')}</div>
        ) : (
          <>
            {isTracks && (
              <div className="space-y-4 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
                <div className="text-sm font-semibold text-[var(--pg-text)]">
                  {t('launchedGameConfig:sectionTracks', { defaultValue: 'Tracks options' })}
                </div>
                <TracksCheckboxGroup
                  label={t('launchModal:tracksRoute')}
                  options={tracksOptions.routes.map((k) => ({ key: k, label: TRACKS_ROUTE_LABELS[k] ? t(TRACKS_ROUTE_LABELS[k]) : k }))}
                  value={tracksRoutesValue}
                  onChange={handleTracksRoutesChange}
                  hint={t('launchModal:tracksRoutesHint')}
                />
                <TracksRadioGroup
                  label={t('launchModal:tracksDisplayMode')}
                  name="cfgTracksDisplay"
                  options={tracksOptions.displays.map((k) => ({ key: k, label: TRACKS_DISPLAY_LABELS[k] ? t(TRACKS_DISPLAY_LABELS[k]) : k }))}
                  value={editedValues.displayMode ?? ''}
                  onChange={(k) => handleValueChange('displayMode', k)}
                />
                <TracksRadioGroup
                  label={t('launchModal:tracksPlayMode')}
                  name="cfgTracksPlayMode"
                  options={tracksOptions.playModes.map((k) => ({ key: k, label: TRACKS_PLAY_MODE_LABELS[k] ? t(TRACKS_PLAY_MODE_LABELS[k]) : k }))}
                  value={editedValues.trackPlayMode ?? ''}
                  onChange={(k) => handleValueChange('trackPlayMode', k)}
                />
                <TracksRadioGroup
                  label={t('launchModal:tracksScoreType')}
                  name="cfgTracksScoreType"
                  options={tracksOptions.scoreTypes.map((s) => ({ key: s.key, label: TRACKS_SCORE_TYPE_LABELS[s.key] ? t(TRACKS_SCORE_TYPE_LABELS[s.key]) : s.key }))}
                  value={editedValues.scoreType ?? ''}
                  onChange={(k) => handleValueChange('scoreType', k)}
                  helpDot={<HelpDot topic="launch.score-type" />}
                />
                <div className="space-y-2">
                  <label className="pg-label" htmlFor="cfg-malusPerMinute">
                    {t('launchModal:malusPerMinute')}
                  </label>
                  <input
                    id="cfg-malusPerMinute"
                    type="number"
                    min={0}
                    value={editedValues.malusPerMinute ?? ''}
                    onChange={(e) => handleValueChange('malusPerMinute', e.target.value)}
                    className="pg-input !w-32"
                  />
                  <p className="text-xs text-[var(--pg-text-dim)]">{t('launchModal:malusPerMinuteHint')}</p>
                </div>
                {/* Clues page on team return - toggle + sub-options (mirrors the launch modal). */}
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-[var(--pg-text)]">{t('launchModal:tracksCluesSectionTitle')}</h3>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!!cluesConfig.enabled}
                      onChange={(e) =>
                        setCluesConfig({
                          enabled: e.target.checked,
                          show_title: cluesConfig.show_title ?? true,
                          show_text: cluesConfig.show_text ?? true,
                          show_image: cluesConfig.show_image ?? true,
                        })
                      }
                      className="mt-0.5 w-4 h-4 accent-[var(--pg-accent)]"
                    />
                    <span>
                      <span className="font-medium text-[var(--pg-text)]">{t('launchModal:tracksCluesPage')}</span>
                      <span className="block text-xs text-[var(--pg-text-dim)]">{t('launchModal:tracksCluesPageHint')}</span>
                    </span>
                  </label>
                  {cluesConfig.enabled && (
                    <div className="ml-6 mt-2 space-y-1.5">
                      {(
                        [
                          ['show_title', 'tracksCluesShowTitle'],
                          ['show_text', 'tracksCluesShowText'],
                          ['show_image', 'tracksCluesShowImage'],
                        ] as const
                      ).map(([key, i18nKey]) => (
                        <label key={key} className="flex items-center gap-2 text-sm text-[var(--pg-text-muted)]">
                          <input
                            type="checkbox"
                            checked={cluesConfig[key] !== false}
                            onChange={(e) =>
                              setCluesConfig({
                                enabled: cluesConfig.enabled ?? true,
                                show_title: cluesConfig.show_title ?? true,
                                show_text: cluesConfig.show_text ?? true,
                                show_image: cluesConfig.show_image ?? true,
                                [key]: e.target.checked,
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

            {victoryFields.map((field) => {
              const value = editedValues[field.meta_name] || '';
              const editable = keyEditable(field.meta_name);
              return (
                <div key={field.meta_name} className={`space-y-3 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)] ${editable ? '' : 'opacity-60'}`}>
                  <label className="pg-label">{getFieldLabel(field.meta_name)}</label>
                  <div className="grid grid-cols-2 gap-3">
                    {(['speed', 'score'] as const).map((vt) => (
                      <button
                        key={vt}
                        type="button"
                        disabled={!editable}
                        onClick={() => editable && handleValueChange(field.meta_name, vt)}
                        className={`relative p-4 rounded-[var(--pg-radius-md)] border-2 text-left transition-all ${!editable ? 'cursor-not-allowed' : ''} ${
                          value === vt
                            ? vt === 'speed' ? 'border-orange-500 bg-orange-500/10' : 'border-[var(--pg-accent-line)] bg-[var(--pg-accent-tint)]'
                            : 'border-[var(--pg-line)] bg-[var(--pg-surface-3)] hover:border-[var(--pg-line-strong)]'
                        }`}
                      >
                        <div className={`font-semibold text-sm ${value === vt ? (vt === 'speed' ? 'text-orange-400' : 'text-[var(--pg-accent-bright)]') : 'text-[var(--pg-text-muted)]'}`}>
                          {vt === 'speed' ? t('launchedGameConfig:victorySpeed') : t('launchedGameConfig:victoryScore')}
                        </div>
                        {value === vt && (
                          <div className={`absolute top-2 right-2 w-2 h-2 rounded-full ${vt === 'speed' ? 'bg-orange-500' : 'bg-[var(--pg-accent)]'}`} />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}

            {playModeField && (
              <div className={`space-y-3 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)] ${keyEditable('playMode') ? '' : 'opacity-60'}`}>
                <label className="pg-label">{getFieldLabel('playMode')}</label>
                <div className="grid grid-cols-2 gap-3">
                  {(['team', 'solo'] as const).map((pm) => {
                    const value = editedValues.playMode || '';
                    const editable = keyEditable('playMode');
                    return (
                      <button
                        key={pm}
                        type="button"
                        disabled={!editable}
                        onClick={() => editable && handleValueChange('playMode', pm)}
                        className={`relative p-4 rounded-[var(--pg-radius-md)] border-2 text-left transition-all ${!editable ? 'cursor-not-allowed' : ''} ${
                          value === pm
                            ? 'border-teal-500 bg-teal-500/10'
                            : 'border-[var(--pg-line)] bg-[var(--pg-surface-3)] hover:border-[var(--pg-line-strong)]'
                        }`}
                      >
                        <div className={`font-semibold text-sm ${value === pm ? 'text-teal-400' : 'text-[var(--pg-text-muted)]'}`}>
                          {pm === 'team' ? t('launchedGameConfig:playModeTeam') : t('launchedGameConfig:playModeSolo')}
                        </div>
                        {value === pm && (
                          <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-teal-500" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {valueFields.length > 0 && (
              <div className="space-y-4 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
                <div className="text-sm font-semibold text-[var(--pg-text)]">{t('launchedGameConfig:sectionSettings')}</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                  {valueFields.map((field) => {
                    const fieldType = getFieldType(field.meta_name);
                    const value = editedValues[field.meta_name] || '';
                    const editable = keyEditable(field.meta_name);
                    return (
                      <div key={field.meta_name} className={`space-y-2 ${editable ? '' : 'opacity-60'}`}>
                        <label htmlFor={`cfg-${field.meta_name}`} className="pg-label">
                          {getFieldLabel(field.meta_name)}
                        </label>
                        <input
                          id={`cfg-${field.meta_name}`}
                          type={fieldType}
                          value={value}
                          disabled={!editable}
                          onChange={(e) => handleValueChange(field.meta_name, e.target.value)}
                          className={`pg-input ${!editable ? 'cursor-not-allowed' : ''}`}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {toggleFields.length > 0 && (
              <div className="space-y-4 p-4 bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)]">
                <div className="text-sm font-semibold text-[var(--pg-text)]">{t('launchedGameConfig:sectionOptions')}</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {toggleFields.map((field) => {
                    const value = editedValues[field.meta_name] || '';
                    const editable = keyEditable(field.meta_name);
                    return (
                      <label
                        key={field.meta_name}
                        className={`flex items-center justify-between gap-4 p-3 rounded-[var(--pg-radius-md)] border border-[var(--pg-line)] bg-[var(--pg-surface-3)] transition-all ${editable ? 'cursor-pointer hover:border-[var(--pg-line-strong)]' : 'opacity-60 cursor-not-allowed'}`}
                      >
                        <span className="text-sm text-[var(--pg-text)]">{getFieldLabel(field.meta_name)}</span>
                        <input
                          type="checkbox"
                          checked={value === 'true'}
                          disabled={!editable}
                          onChange={(e) => handleValueChange(field.meta_name, e.target.checked)}
                          className="w-5 h-5 accent-[var(--pg-accent)] shrink-0"
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {devices.length > 0 && (
          <div className="pt-2 border-t border-[var(--pg-line)]">
            <h4 className="text-lg font-semibold text-[var(--pg-text)] mb-4 mt-4 flex items-center gap-2">
              <Monitor size={20} className="text-green-500" />
              {t('launchedGameConfig:connectedDevices')}
            </h4>
            <div className="space-y-4">
              {devices.map((device) => (
                <div key={device.id} className="bg-[var(--pg-surface-2)] rounded-[var(--pg-radius-md)] p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-full ${device.connected ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span className="text-[var(--pg-text)] font-medium">{device.device_id}</span>
                    </div>
                    {rawData[device.device_id] && rawData[device.device_id].length > 0 && (
                      <button
                        onClick={() => toggleRawData(device.device_id)}
                        className="pg-btn pg-btn--ghost pg-btn--sm flex items-center gap-2"
                      >
                        {showRawData[device.device_id] ? <EyeOff size={16} /> : <Eye size={16} />}
                        {showRawData[device.device_id]
                          ? t('launchedGameConfig:hideRawData', { count: rawData[device.device_id].length })
                          : t('launchedGameConfig:showRawData', { count: rawData[device.device_id].length })}
                      </button>
                    )}
                  </div>
                  <p className="text-[var(--pg-text-dim)] text-xs">
                    {t('launchedGameConfig:lastConnection', {
                      date: formatDbDateTime(device.last_connexion_attempt),
                    })}
                  </p>

                  {showRawData[device.device_id] && rawData[device.device_id] && (
                    <div className="mt-4 space-y-3">
                      <h5 className="text-sm font-semibold text-[var(--pg-text-muted)]">{t('launchedGameConfig:cardPunchData')}</h5>
                      {rawData[device.device_id].map((data) => (
                        <div key={data.id} className="bg-[var(--pg-surface-3)] rounded p-3">
                          <div className="flex justify-between items-start mb-2">
                            <span className="text-xs text-[var(--pg-text-dim)]">
                              {formatDbDateTime(data.created_at)}
                            </span>
                          </div>
                          <pre className="text-xs text-[var(--pg-text-muted)] overflow-x-auto whitespace-pre-wrap">
                            {JSON.stringify(data.raw_data, null, 2)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        </div>

        <div className="sticky bottom-0 z-10 flex gap-3 p-6 bg-[var(--pg-surface)] border-t border-[var(--pg-line)]">
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="pg-btn pg-btn--primary flex-1 flex items-center justify-center gap-2"
          >
            <Save size={18} />
            {saving ? t('launchedGameConfig:saving') : t('launchedGameConfig:saveConfiguration')}
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="pg-btn"
          >
            {t('launchedGameConfig:cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
