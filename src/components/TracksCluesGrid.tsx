import { readLocalized } from './TracksGameRenderer';

type Localizedish = Record<string, string> | string | null | undefined;

export interface TracksCluesCell {
  id: string;
  title: Localizedish;
  description: Localizedish;
  /** Already-resolved image URL (found → checkpoint image, missing → "not
   *  found" image); '' renders no image. */
  imageUrl: string;
}

interface TracksCluesGridProps {
  cells: TracksCluesCell[];
  showImage: boolean;
  showTitle: boolean;
  showText: boolean;
  showScore: boolean;
  teamName: string;
  scoreText: string;
  timerText: string;
  language: string;
}

/**
 * The tracks "clues page" grid - every route checkpoint laid out edge-to-edge
 * with no overflow (kiosk display has no scroll), a top strip with team name /
 * score / time. Lifted from the inline grid in TracksGameRenderer so the live
 * reveal and the pushed team-summary overlay render it identically.
 */
export function TracksCluesGrid({
  cells,
  showImage,
  showTitle,
  showText,
  showScore,
  teamName,
  scoreText,
  timerText,
  language,
}: TracksCluesGridProps) {
  const n = cells.length || 1;
  // Bias toward more columns than rows for landscape kiosks.
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.7)));
  const rows = Math.max(1, Math.ceil(n / cols));
  return (
    <div className="absolute inset-0 bg-black/70 flex flex-col overflow-hidden text-white">
      {/* Top HUD: team name, score, time */}
      <div className="shrink-0 flex items-center justify-between gap-4 px-8 py-3 border-b border-white/15">
        <div className="text-2xl font-bold truncate">{teamName}</div>
        <div className="flex items-center gap-6">
          {showScore && (
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider opacity-60">Score</div>
              <div className="text-2xl font-bold leading-none">{scoreText}</div>
            </div>
          )}
          {timerText && (
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider opacity-60">Time</div>
              <div className="text-2xl font-bold leading-none">{timerText}</div>
            </div>
          )}
        </div>
      </div>
      {/* Checkpoint grid - fills the remaining height, no overflow */}
      <div className="flex-1 min-h-0 p-4">
        <div
          className="h-full w-full"
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
            gap: '0.6rem',
          }}
        >
          {cells.map((cp, i) => (
            <div
              key={cp.id}
              className="min-h-0 min-w-0 bg-black/50 rounded-lg p-2 flex flex-col items-center justify-center text-center overflow-hidden"
            >
              {showImage && cp.imageUrl && (
                <img src={cp.imageUrl} alt="" className="flex-1 min-h-0 max-w-full object-contain" />
              )}
              {showTitle && (
                <div className="shrink-0 mt-1 font-bold text-sm leading-tight truncate w-full">
                  {readLocalized(cp.title, language) || `#${i + 1}`}
                </div>
              )}
              {showText && (
                <div className="shrink-0 text-xs opacity-80 leading-tight line-clamp-2 w-full">
                  {readLocalized(cp.description, language)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
