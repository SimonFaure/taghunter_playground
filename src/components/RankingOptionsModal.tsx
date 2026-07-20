import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trophy, X, MonitorUp, Tablet, ChevronRight, ArrowLeft, ListOrdered } from 'lucide-react';
import type { GameConfig } from './LaunchGameModal';
import type { TimeRange } from './RankingsModal';
import type { RankingTarget } from '../services/rankingTarget';

export type RankingAction = 'show' | 'second_screen' | 'device';

interface RankingOptionsModalProps {
  launchedGameId: number;
  gameName: string;
  config: GameConfig;
  scenarioUniqid: string;
  scenarioTitle: string;
  onClose: () => void;
  /** Fired once the operator confirms the config step. The caller performs the
   *  action (open page / projector / device picker) with the resolved target. */
  onAction: (action: RankingAction, target: RankingTarget) => void;
}

const TIME_RANGES: { value: TimeRange; key: string }[] = [
  { value: 'day', key: 'rankTimeToday' },
  { value: 'week', key: 'rankTimeWeek' },
  { value: 'month', key: 'rankTimeMonth' },
  { value: 'trimester', key: 'rankTimeQuarter' },
  { value: 'year', key: 'rankTimeYear' },
  { value: 'all', key: 'rankTimeAll' },
];

export function RankingOptionsModal({
  launchedGameId,
  gameName,
  config,
  scenarioUniqid,
  scenarioTitle,
  onClose,
  onAction,
}: RankingOptionsModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<'choose' | 'config'>('choose');
  const [action, setAction] = useState<RankingAction>('show');
  const [onlyThisGame, setOnlyThisGame] = useState(true);
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [autoScroll, setAutoScroll] = useState(true);

  const pick = (a: RankingAction) => {
    setAction(a);
    setStep('config');
  };

  const confirm = () => {
    const target: RankingTarget = onlyThisGame
      ? { mode: 'game', launchedGameId, gameName, config, autoScroll }
      : { mode: 'scenario', scenarioUniqid, scenarioTitle, timeRange, autoScroll };
    onAction(action, target);
  };

  const OPTIONS: { action: RankingAction; icon: typeof Trophy; titleKey: string; descKey: string }[] = [
    { action: 'show', icon: ListOrdered, titleKey: 'rankOptShow', descKey: 'rankOptShowDesc' },
    { action: 'second_screen', icon: MonitorUp, titleKey: 'rankOptSecondScreen', descKey: 'rankOptSecondScreenDesc' },
    { action: 'device', icon: Tablet, titleKey: 'rankOptDevice', descKey: 'rankOptDeviceDesc' },
  ];

  const confirmLabel =
    action === 'show'
      ? t('launched:rankConfirmShow')
      : action === 'second_screen'
        ? t('launched:rankConfirmSecondScreen')
        : t('launched:rankConfirmDevice');

  return (
    <div className="pg-overlay p-4" onClick={onClose}>
      <div className="pg-modal max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="pg-modal-head">
          <div className="flex items-center gap-2.5">
            {step === 'config' && (
              <button onClick={() => setStep('choose')} className="pg-modal-close" title={t('launched:rankBack')}>
                <ArrowLeft size={16} />
              </button>
            )}
            <div className="w-8 h-8 rounded-lg bg-yellow-400/15 flex items-center justify-center">
              <Trophy size={16} className="text-yellow-400" />
            </div>
            <h2 className="pg-modal-title">{t('launched:gameRankings')}</h2>
          </div>
          <button onClick={onClose} className="pg-modal-close" title={t('launched:close')}>
            <X size={16} />
          </button>
        </div>

        <div className="p-6">
          {step === 'choose' ? (
            <div className="space-y-3">
              <p className="text-sm text-[var(--pg-text-dim)] mb-1 truncate">{gameName}</p>
              {OPTIONS.map((opt) => {
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.action}
                    onClick={() => pick(opt.action)}
                    className="w-full flex items-center gap-3 p-4 rounded-xl border border-[var(--pg-line)] bg-[var(--pg-surface-2)] hover:border-[var(--pg-line-strong)] hover:bg-[var(--pg-surface-3)] text-left transition-all"
                  >
                    <div className="w-9 h-9 rounded-lg bg-[var(--pg-accent-tint)] flex items-center justify-center shrink-0">
                      <Icon size={18} className="text-[var(--pg-accent-bright)]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[var(--pg-text)] font-semibold text-sm">{t(`launched:${opt.titleKey}`)}</div>
                      <div className="text-[var(--pg-text-dim)] text-xs mt-0.5">{t(`launched:${opt.descKey}`)}</div>
                    </div>
                    <ChevronRight size={16} className="text-[var(--pg-text-dim)] shrink-0" />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="space-y-5">
              <label className="flex items-center justify-between gap-4 p-3 rounded-[var(--pg-radius-md)] border border-[var(--pg-line)] bg-[var(--pg-surface-2)] cursor-pointer transition-all hover:border-[var(--pg-line-strong)]">
                <span className="text-sm text-[var(--pg-text)]">{t('launched:rankOnlyThisGame')}</span>
                <input
                  type="checkbox"
                  checked={onlyThisGame}
                  onChange={(e) => setOnlyThisGame(e.target.checked)}
                  className="w-5 h-5 accent-[var(--pg-accent)] shrink-0"
                />
              </label>

              <div className={onlyThisGame ? 'opacity-40 pointer-events-none' : ''}>
                <label className="block text-xs font-semibold text-[var(--pg-text-dim)] uppercase tracking-wider mb-2">
                  {t('launched:rankTimeRange')}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {TIME_RANGES.map((range) => (
                    <button
                      key={range.value}
                      disabled={onlyThisGame}
                      onClick={() => setTimeRange(range.value)}
                      className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                        timeRange === range.value
                          ? 'bg-[var(--pg-accent)] text-[var(--pg-text)]'
                          : 'bg-[var(--pg-surface-2)] text-[var(--pg-text-dim)] hover:bg-[var(--pg-surface-3)] hover:text-[var(--pg-text)] border border-[var(--pg-line)]'
                      }`}
                    >
                      {t(`launched:${range.key}`)}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-[var(--pg-text-dim)] mt-2">{t('launched:rankScenarioNote', { scenario: scenarioTitle })}</p>
              </div>

              <label className="flex items-start justify-between gap-4 p-3 rounded-[var(--pg-radius-md)] border border-[var(--pg-line)] bg-[var(--pg-surface-2)] cursor-pointer transition-all hover:border-[var(--pg-line-strong)]">
                <span className="min-w-0">
                  <span className="block text-sm text-[var(--pg-text)]">{t('launched:rankAutoScroll')}</span>
                  <span className="block text-xs text-[var(--pg-text-dim)] mt-0.5">{t('launched:rankAutoScrollDesc')}</span>
                </span>
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="w-5 h-5 accent-[var(--pg-accent)] shrink-0 mt-0.5"
                />
              </label>

              <button onClick={confirm} className="pg-btn pg-btn--primary w-full justify-center">
                {confirmLabel}
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
