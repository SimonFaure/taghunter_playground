import { ArrowLeft, Trophy } from 'lucide-react';
import { LeaderboardPanel } from './LeaderboardPanel';
import type { ActiveGameOption } from './RankingsModal';

interface MultiGameLeaderboardProps {
  games: ActiveGameOption[];
  onBack: () => void;
}

function getGridClass(count: number): string {
  if (count === 1) return 'grid-cols-1 grid-rows-1';
  if (count === 2) return 'grid-cols-2 grid-rows-1';
  if (count === 3) return 'grid-cols-3 grid-rows-1';
  return 'grid-cols-2 grid-rows-2';
}

export function MultiGameLeaderboard({ games, onBack }: MultiGameLeaderboardProps) {
  const count = Math.min(games.length, 4);
  const visibleGames = games.slice(0, count);
  const compact = count > 2;

  return (
    <div className="fixed inset-0 z-[200] bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex flex-col overflow-hidden">
      <header className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-slate-700/60">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-sm font-medium"
        >
          <ArrowLeft size={18} />
          Back
        </button>

        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-yellow-400/15 flex items-center justify-center">
            <Trophy size={14} className="text-yellow-400" />
          </div>
          <span className="text-white font-bold text-sm">Live Rankings</span>
          <span className="px-2 py-0.5 rounded-full bg-slate-700 border border-slate-600 text-slate-400 text-xs font-medium">
            {count} {count === 1 ? 'game' : 'games'}
          </span>
        </div>
      </header>

      <div className={`flex-1 min-h-0 grid gap-px bg-slate-700/40 ${getGridClass(count)}`}>
        {visibleGames.map(game => (
          <div key={game.id} className="bg-slate-900 min-h-0 overflow-hidden">
            <LeaderboardPanel
              launchedGameId={game.id}
              gameName={game.name}
              compact={compact}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
