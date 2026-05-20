import { useEffect, useState } from 'react';
import {
  X,
  Clock,
  BookOpen,
  Tag,
  Hash,
  Users,
  Layers,
  Languages,
  Type,
  Download,
  Loader,
} from 'lucide-react';
import { ScenarioThumbnail } from './ScenarioThumbnail';
import * as scenarioStore from '../services/scenarioStore';

interface GameType {
  id: string;
  name: string;
  description: string;
}

// Minimal shape the modal needs — kept local so GameList's richer
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
}

// Fields pulled out of game-data.json's `game_meta`. Everything is optional —
// older scenarios and the legacy tagquest/mystery shapes don't carry all keys.
interface ParsedMeta {
  story: string;
  scenarioVersion: string | null;
  audience: string | null;
  questCount: number | null;
  enigmaCount: number | null;
  pointsUnit: string | null;
  defaultTime: number | null;
  font: string | null;
  languages: string[];
}

function getDifficultyColor(difficulty: string | null): string {
  switch (difficulty?.toLowerCase()) {
    case 'easy':
      return 'bg-green-900/30 text-green-400 border-green-700';
    case 'medium':
      return 'bg-yellow-900/30 text-yellow-400 border-yellow-700';
    case 'hard':
      return 'bg-red-900/30 text-red-400 border-red-700';
    default:
      return 'bg-slate-700 text-slate-300 border-slate-600';
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Read the interesting fields from a downloaded scenario's game-data.json.
// Tolerates both the current `game_meta` shape and the older flat/`game`
// shapes; any missing key just yields null.
function parseGameData(gd: unknown, fallbackDescription: string): ParsedMeta {
  const root = (gd ?? {}) as Record<string, unknown>;
  const meta = (root.game_meta ?? {}) as Record<string, unknown>;
  const game = (root.game ?? {}) as Record<string, unknown>;

  const story =
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
    story,
    scenarioVersion: typeof meta.scenario_version === 'string' ? meta.scenario_version : null,
    audience: typeof meta.game_public === 'string' ? meta.game_public : null,
    questCount: questsArr ? questsArr.length : null,
    enigmaCount: toNumber(meta.number_of_enigmas) ?? (enigmasArr ? enigmasArr.length : null),
    pointsUnit: typeof meta.points_units === 'string' ? meta.points_units : null,
    defaultTime: toNumber(meta.default_time),
    font: typeof meta.font === 'string' ? meta.font : null,
    languages,
  };
}

export function ScenarioDetailsModal({ scenario, thumbnailUrl, onClose }: ScenarioDetailsModalProps) {
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
            setMeta(parseGameData(null, scenario.description));
            setRow(null);
          }
          return;
        }
        const [gd, dbRow] = await Promise.all([
          scenarioStore.getGameData(uniqid),
          scenarioStore.get(uniqid),
        ]);
        if (cancelled) return;
        setMeta(parseGameData(gd, scenario.description));
        setRow(dbRow);
      } catch (err) {
        console.error('[ScenarioDetailsModal] failed to load details:', err);
        if (!cancelled) setMeta(parseGameData(null, scenario.description));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scenario.uniqid, scenario.description]);

  // Close on Escape for keyboard parity with the click-away overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isDownloaded = row?.local_version != null;
  const updateAvailable =
    row != null && row.local_version != null && row.local_version !== row.remote_version;

  const story = meta?.story?.trim() ?? '';
  const durationMinutes = meta?.defaultTime ?? scenario.duration_minutes;

  // Metadata tiles — only render the ones we actually have a value for.
  const stats: Array<{ icon: typeof Clock; label: string; value: string }> = [];
  if (meta?.scenarioVersion) {
    stats.push({ icon: Tag, label: 'Version', value: meta.scenarioVersion });
  }
  if (durationMinutes) {
    stats.push({ icon: Clock, label: 'Duration', value: `${durationMinutes} min` });
  }
  if (meta?.questCount != null) {
    stats.push({ icon: Layers, label: 'Quests', value: String(meta.questCount) });
  }
  if (meta?.enigmaCount != null) {
    stats.push({ icon: Hash, label: 'Enigmas', value: String(meta.enigmaCount) });
  }
  if (meta?.audience) {
    stats.push({ icon: Users, label: 'Audience', value: meta.audience });
  }
  if (meta?.font) {
    stats.push({ icon: Type, label: 'Font', value: meta.font });
  }
  if (meta && meta.languages.length > 0) {
    stats.push({
      icon: Languages,
      label: 'Languages',
      value: meta.languages.map((l) => l.toUpperCase()).join(', '),
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl bg-slate-800 rounded-2xl shadow-2xl border border-slate-700 overflow-hidden max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hero image with the title overlaid */}
        <div className="group relative w-full h-52 shrink-0 bg-slate-700">
          <ScenarioThumbnail
            imageUrl={thumbnailUrl}
            gameTypeName={scenario.game_type.name}
            title={scenario.title}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/40 to-transparent" />
          <button
            onClick={onClose}
            className="absolute top-3 right-3 p-2 rounded-full bg-slate-900/70 text-slate-300 hover:text-white hover:bg-slate-900 transition"
            aria-label="Close"
          >
            <X size={20} />
          </button>
          <div className="absolute bottom-3 left-5 right-5">
            <span className="text-blue-400 text-sm font-semibold">
              {scenario.game_type.name}
            </span>
            <h2 className="text-2xl font-bold text-white leading-tight">
              {scenario.title || 'Untitled scenario'}
            </h2>
          </div>
        </div>

        <div className="p-6 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-slate-400">
              <Loader size={18} className="animate-spin" />
              <span className="text-sm">Loading details…</span>
            </div>
          ) : (
            <>
              {/* Badges */}
              <div className="flex flex-wrap items-center gap-2 mb-5">
                <span
                  className={`px-3 py-1 rounded-full text-xs font-medium border ${getDifficultyColor(
                    scenario.difficulty
                  )}`}
                >
                  {scenario.difficulty || 'Medium'}
                </span>
                {!isDownloaded && (
                  <span className="px-3 py-1 rounded-full text-xs font-medium border bg-slate-700 text-slate-300 border-slate-600">
                    Not downloaded
                  </span>
                )}
                {updateAvailable && (
                  <span className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium border bg-amber-900/30 text-amber-400 border-amber-700">
                    <Download size={12} />
                    Update available
                  </span>
                )}
              </div>

              {/* Story */}
              <div className="mb-6">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-300 mb-2">
                  <BookOpen size={16} className="text-blue-400" />
                  Story
                </h3>
                {story ? (
                  <p className="text-slate-300 text-sm leading-relaxed whitespace-pre-line">
                    {story}
                  </p>
                ) : (
                  <p className="text-slate-500 text-sm italic">
                    {isDownloaded
                      ? 'No story provided for this scenario.'
                      : 'Download the scenario to see its story.'}
                  </p>
                )}
              </div>

              {/* Metadata grid */}
              {stats.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {stats.map(({ icon: Icon, label, value }) => (
                    <div
                      key={label}
                      className="bg-slate-900/50 border border-slate-700 rounded-lg px-3 py-2.5"
                    >
                      <div className="flex items-center gap-1.5 text-slate-500 text-xs mb-1">
                        <Icon size={13} />
                        <span>{label}</span>
                      </div>
                      <p className="text-white text-sm font-medium truncate" title={value}>
                        {value}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* Sync footer */}
              {row && (
                <p className="mt-5 text-xs text-slate-500">
                  {isDownloaded
                    ? `Installed version ${row.local_version} · latest ${row.remote_version}`
                    : `Latest version ${row.remote_version} — not yet downloaded`}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
