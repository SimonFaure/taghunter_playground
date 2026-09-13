import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Clock,
  BookOpen,
  Tag,
  Languages,
  Download,
  Loader,
  Trash2,
} from 'lucide-react';
import { ScenarioThumbnail } from './ScenarioThumbnail';
import { GameTypeIcon } from './icons/GameTypeIcons';
import { gameTypeLabel } from '../utils/labels';
import { bandLabel, resolveBands, type AudienceBand } from '../utils/audienceBands';
import * as scenarioStore from '../services/scenarioStore';

interface GameType {
  id: string;
  name: string;
  description: string;
}

// Minimal shape the modal needs - kept local so GameList's richer
// `ScenarioWithType` can be passed without exporting its type.
export interface ScenarioDetails {
  id: string;
  title: string;
  description: string;
  difficulty: string | null;
  duration_minutes: number;
  uniqid?: string;
  game_type: GameType;
}

interface ScenarioDetailsModalProps {
  scenario: ScenarioDetails;
  thumbnailUrl: string | null;
  onClose: () => void;
  /** When provided, a delete action is shown (deletion was moved here from the
   *  scenario card). Omitted for scenarios that can't be removed locally. */
  onDelete?: () => void;
}

// Fields pulled out of game-data.json's `game_meta`. Everything is optional -
// older scenarios and the legacy tagquest/mystery shapes don't carry all keys.
interface ParsedMeta {
  description: string;
  scenarioVersion: string | null;
  audience: string | null;
  audienceBands: AudienceBand[];
  questCount: number | null;
  enigmaCount: number | null;
  pointsUnit: string | null;
  defaultTime: number | null;
  font: string | null;
  languages: string[];
}

// Difficulty is an integer 1–5 (stars). Coerce stored values: new int, numeric
// string, or legacy enum slug (easy→1 / medium→3 / hard→5). Unset → 3.
function coerceDifficulty(raw: unknown): number {
  const clamp = (n: number) => (n < 1 ? 1 : n > 5 ? 5 : n);
  if (typeof raw === 'number' && Number.isFinite(raw)) return clamp(Math.round(raw));
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '') return 3;
  if (/^-?\d+(\.\d+)?$/.test(s)) return clamp(Math.round(Number(s)));
  if (s === 'easy' || s === 'simple' || s === 'facile') return 1;
  if (s === 'hard' || s === 'difficult' || s === 'expert' || s === 'difficile') return 5;
  return 3; // medium / normal / moyen / unknown
}

function DifficultyStars({ level }: { level: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: 1, lineHeight: 1 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} style={{ color: '#f59e0b', opacity: i <= level ? 1 : 0.25, fontSize: '1rem' }}>
          ★
        </span>
      ))}
    </span>
  );
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Read a translatable game_meta field at the active language. The cloud
// compat layer (LocalizedCompat::toLegacyShape) flattens `game_meta.<field>`
// to the default-lang string and parks the per-language copies under
// `translations[lang].<field>`; a raw new-shape payload (e.g. served straight
// off a LAN mother) keeps `game_meta.<field>` as a `Localized<string>` map.
// Handle all three: per-lang translation → game_meta string → game_meta map.
function readLocalizedField(
  root: Record<string, unknown>,
  meta: Record<string, unknown>,
  field: string,
  lang: string,
): string {
  const translations = (root.translations ?? {}) as Record<string, Record<string, unknown>>;
  const perLang = translations[lang];
  if (perLang && typeof perLang[field] === 'string' && (perLang[field] as string).trim()) {
    return perLang[field] as string;
  }
  const raw = meta[field];
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const map = raw as Record<string, string>;
    const defaultLang = typeof root.default_language === 'string' ? root.default_language : 'fr';
    return map[lang] || map[defaultLang] || Object.values(map)[0] || '';
  }
  return '';
}

// Read the interesting fields from a downloaded scenario's game-data.json.
// Tolerates both the current `game_meta` shape and the older flat/`game`
// shapes; any missing key just yields null.
function parseGameData(gd: unknown, fallbackDescription: string, lang: string): ParsedMeta {
  const root = (gd ?? {}) as Record<string, unknown>;
  const meta = (root.game_meta ?? {}) as Record<string, unknown>;
  const game = (root.game ?? {}) as Record<string, unknown>;

  // The authored description lives in `game_meta.description`. Fall back to the
  // `story` field, then the legacy `scenario`/top-level paths, so older
  // scenarios that only filled one of those still show something.
  const description =
    readLocalizedField(root, meta, 'description', lang) ||
    readLocalizedField(root, meta, 'story', lang) ||
    (typeof meta.scenario === 'string' && meta.scenario) ||
    (typeof root.description === 'string' && root.description) ||
    (typeof game.description === 'string' && game.description) ||
    fallbackDescription ||
    '';

  const questsArr = Array.isArray(meta.quests)
    ? meta.quests
    : Array.isArray(root.quests)
      ? root.quests
      : null;
  const enigmasArr = Array.isArray(meta.enigmas)
    ? meta.enigmas
    : Array.isArray(root.enigmas)
      ? root.enigmas
      : null;

  const languages = Array.isArray(root.available_languages)
    ? (root.available_languages as unknown[]).filter((l): l is string => typeof l === 'string')
    : [];

  return {
    description,
    scenarioVersion: typeof meta.scenario_version === 'string' ? meta.scenario_version : null,
    audience: typeof meta.game_public === 'string' ? meta.game_public : null,
    audienceBands: resolveBands(meta.audience_bands, typeof meta.game_public === 'string' ? meta.game_public : null),
    questCount: questsArr ? questsArr.length : null,
    enigmaCount: toNumber(meta.number_of_enigmas) ?? (enigmasArr ? enigmasArr.length : null),
    pointsUnit: typeof meta.points_units === 'string' ? meta.points_units : null,
    defaultTime: toNumber(meta.default_time),
    font: typeof meta.font === 'string' ? meta.font : null,
    languages,
  };
}

export function ScenarioDetailsModal({ scenario, thumbnailUrl, onClose, onDelete }: ScenarioDetailsModalProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState<ParsedMeta | null>(null);
  const [row, setRow] = useState<scenarioStore.ScenarioRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const uniqid = scenario.uniqid;
        if (!uniqid) {
          if (!cancelled) {
            setMeta(parseGameData(null, scenario.description, lang));
            setRow(null);
          }
          return;
        }
        const [gd, dbRow] = await Promise.all([
          scenarioStore.getGameData(uniqid),
          scenarioStore.get(uniqid),
        ]);
        if (cancelled) return;
        setMeta(parseGameData(gd, scenario.description, lang));
        setRow(dbRow);
      } catch (err) {
        console.error('[ScenarioDetailsModal] failed to load details:', err);
        if (!cancelled) setMeta(parseGameData(null, scenario.description, lang));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scenario.uniqid, scenario.description, lang]);

  // Close on Escape for keyboard parity with the click-away overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isDownloaded = row?.local_version != null;
  // "Update available" tracks the content hash, not the scalar version - a
  // studio edit (data or media) bumps the content hash even when the display
  // version string is unchanged. Fall back to the version compare for rows that
  // predate the hash columns.
  const updateAvailable =
    row != null &&
    isDownloaded &&
    (row.remote_content_hash != null && row.local_content_hash != null
      ? row.local_content_hash !== row.remote_content_hash
      : row.local_version !== row.remote_version);

  const description = meta?.description?.trim() ?? '';
  const durationMinutes = meta?.defaultTime ?? scenario.duration_minutes;

  // The actual scenario version is the number sync tracks - the installed
  // (local) version when downloaded, otherwise the latest available (remote).
  const actualVersion =
    row != null
      ? isDownloaded
        ? row.local_version
        : row.remote_version
      : null;

  // Age ranges the scenario targets (game_meta.audience_bands) - the same six
  // bands the studio catalog shows, not the coarse name-pool tier.
  const audienceLabel = (() => {
    const bands = meta?.audienceBands ?? [];
    return bands.length > 0 ? bands.map((b) => bandLabel(b, t)).join(' · ') : null;
  })();

  // Metadata tiles - only render the ones we actually have a value for.
  const stats: Array<{ icon: typeof Clock; label: string; value: string }> = [];
  if (actualVersion != null) {
    stats.push({ icon: Tag, label: t('scenarioDetails:version'), value: String(actualVersion) });
  }
  if (durationMinutes) {
    stats.push({ icon: Clock, label: t('scenarioDetails:duration'), value: t('scenarioDetails:durationValue', { count: durationMinutes }) });
  }
  if (meta && meta.languages.length > 0) {
    stats.push({
      icon: Languages,
      label: t('scenarioDetails:languages'),
      value: meta.languages.map((l) => l.toUpperCase()).join(', '),
    });
  }

  return (
    <div className="pg-overlay" onClick={onClose}>
      <div
        className="pg-modal max-w-2xl !max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hero image with the title overlaid. `overflow-hidden` keeps the
            hover-zoom (group-hover:scale-110 on the image) clipped to the hero
            instead of spilling past the modal's rounded corners. */}
        <div className="group relative w-full h-52 shrink-0 bg-[var(--pg-surface-2)] overflow-hidden">
          <ScenarioThumbnail
            imageUrl={thumbnailUrl}
            gameTypeName={scenario.game_type.name}
            title={scenario.title}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[var(--pg-bg)] via-[var(--pg-bg)]/40 to-transparent" />
          <button
            onClick={onClose}
            className="absolute top-3 right-3 p-2 rounded-full bg-black/55 text-[var(--pg-text-muted)] hover:text-[var(--pg-text)] hover:bg-black/75 transition"
            aria-label={t('scenarioDetails:close')}
          >
            <X size={20} />
          </button>
          <div className="absolute bottom-3 left-5 right-5">
            <span className="flex items-center gap-1.5 text-[var(--pg-accent-bright)] text-sm font-semibold">
              <GameTypeIcon type={scenario.game_type.name} size={16} />
              {gameTypeLabel(scenario.game_type.name)}
            </span>
            <h2 className="text-2xl font-bold text-[var(--pg-text)] leading-tight">
              {scenario.title || t('scenarioDetails:untitledScenario')}
            </h2>
          </div>
        </div>

        <div className="pg-modal-body">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[var(--pg-text-dim)]">
              <Loader size={18} className="animate-spin" />
              <span className="text-sm">{t('scenarioDetails:loadingDetails')}</span>
            </div>
          ) : (
            <>
              {/* Badges - difficulty and audience sit side by side. */}
              <div className="flex flex-wrap items-center gap-2 mb-5">
                <span
                  className="pg-badge"
                  title={t('scenarioDetails:difficulty', { defaultValue: 'Difficulty' })}
                >
                  <DifficultyStars level={coerceDifficulty(scenario.difficulty)} />
                </span>
                {audienceLabel && (
                  <span className="pg-badge">{audienceLabel}</span>
                )}
                {!isDownloaded && (
                  <span className="pg-badge">{t('scenarioDetails:notDownloaded')}</span>
                )}
                {updateAvailable && (
                  <span className="pg-badge pg-badge--warn">
                    <Download size={12} />
                    {t('scenarioDetails:updateAvailable')}
                  </span>
                )}
              </div>

              {/* Description */}
              <div className="mb-6">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--pg-text-muted)] mb-2">
                  <BookOpen size={16} className="text-[var(--pg-accent-bright)]" />
                  {t('scenarioDetails:description')}
                </h3>
                {description ? (
                  <p className="text-[var(--pg-text-muted)] text-sm leading-relaxed whitespace-pre-line">
                    {description}
                  </p>
                ) : (
                  <p className="text-[var(--pg-text-dim)] text-sm italic">
                    {isDownloaded
                      ? t('scenarioDetails:noDescription')
                      : t('scenarioDetails:downloadForDescription')}
                  </p>
                )}
              </div>

              {/* Metadata grid */}
              {stats.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {stats.map(({ icon: Icon, label, value }) => (
                    <div key={label} className="pg-stat !text-left">
                      <div className="flex items-center gap-1.5 text-[var(--pg-text-dim)] text-xs mb-1">
                        <Icon size={13} />
                        <span>{label}</span>
                      </div>
                      <p className="text-[var(--pg-text)] text-sm font-medium truncate" title={value}>
                        {value}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* Delete action - moved here from the scenario card. */}
              {onDelete && (
                <div className="mt-6 pt-4 border-t border-[var(--pg-line)] flex justify-end">
                  <button onClick={onDelete} className="pg-btn pg-btn--danger pg-btn--sm">
                    <Trash2 size={16} />
                    {t('home:deleteScenario')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
