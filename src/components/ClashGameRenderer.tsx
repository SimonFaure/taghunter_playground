// Clash live dashboard - the "spectacular" shared screen (identical on every
// station). Full-bleed territory map: each controlled territory flies the
// controlling clan's banner and shows a name + relative-share gauge cluster;
// the ranking panel (right) tracks the weighted score + rate; the event feed
// (bottom) narrates conquests / attacks / neutralizations. Timer top-centre.
//
// Design: project_clash_game_type_design (V2).

import { useCallback, useState } from 'react';
import type { ClashStandings, ClashTerritoryStanding, ClashEvent, ClashPurgeState } from '../services/clash';

// Per-clan visuals resolved from the scenario by team_number.
export interface ClashClanVisual {
  team_id: number;
  team_number: number;
  name: string;
  color: string;
  banner: string; // filename ('' ⇒ none) - flown over a controlled territory
  logo: string; // filename ('' ⇒ none) - ranking row + event feed emblem
  scoreCard: string; // filename ('' ⇒ none) - ranking row frame
}

// Map anchors (percent of the map box) for a territory: the banner plants at
// one point, the name+gauge cluster at another. From the scenario layout when
// available; otherwise a fallback grid is used.
export interface ClashTerritoryAnchor {
  index: number;
  bannerLeftPct: number;
  bannerTopPct: number;
  labelLeftPct: number;
  labelTopPct: number;
  /** Purge-image anchor (absent ⇒ derived just below the label cluster). */
  purgeLeftPct?: number;
  purgeTopPct?: number;
}

// A placed, translatable text label on the map (authored in the LayoutEditor).
export interface ClashTextElementRuntime {
  id: string;
  text: string;
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
  fontFamily?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right';
  shadow?: boolean;
  background?: boolean;
}

// Optional dashboard chrome frame images (resolved URLs; '' ⇒ default styling).
export interface ClashFrames {
  ranking?: string;
  timer?: string;
  event?: string;
  gauge?: string;
  territoryName?: string;
  separator?: string;
}

interface ClashGameRendererProps {
  standings: ClashStandings | null;
  /** territory_index -> display name (from the scenario). */
  territoryNames: Record<number, string>;
  clanByTeamId: Record<number, ClashClanVisual>;
  /** filename -> resolved URL. */
  resolveMedia: (filename: string) => string;
  mapImage: string;
  anchors: Record<number, ClashTerritoryAnchor>;
  textElements?: ClashTextElementRuntime[];
  frames?: ClashFrames;
  fontFamily?: string;
  /** Seconds left in the match; null while priming. */
  remainingSec?: number | null;
  /** Authored timer anchor (percent of map). Defaults to top-centre. */
  timerPos?: { leftPct: number; topPct: number } | null;
  /** The Purge live state (standings.purge); null/disabled ⇒ nothing renders. */
  purge?: ClashPurgeState | null;
  /** Resolved purge image URL ('' ⇒ purge visuals are skipped entirely). */
  purgeImageUrl?: string;
  /** Client wall-clock (ms) for event relative-age; defaults to Date.now(). */
  nowMs?: number;
}

function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function relativeAge(atMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (s < 60) return "à l'instant";
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  return `il y a ${h} h`;
}

// The sentence minus the clan name - the name is rendered separately in the
// clan's colour, the rest in the default (white) text colour.
function eventPredicate(kind: ClashEvent['kind'], terr: string): string {
  switch (kind) {
    case 'conquest':
      return `a conquis ${terr} !`;
    case 'attack':
      return `attaque ${terr} !`;
    case 'neutralized':
      return `a neutralisé ${terr} !`;
    case 'purge':
      return `a purgé ${terr} !`;
    default:
      return `- ${terr}`;
  }
}

// Fallback cluster positions (label anchors) for up to 8 territories; the banner
// plants slightly above its label. Used when the scenario has no layout yet.
const FALLBACK_LABELS: Array<{ l: number; t: number }> = [
  { l: 20, t: 26 }, { l: 50, t: 20 }, { l: 79, t: 28 },
  { l: 22, t: 55 }, { l: 50, t: 53 }, { l: 80, t: 58 },
  { l: 35, t: 82 }, { l: 66, t: 82 },
];

function fallbackAnchor(i: number): ClashTerritoryAnchor {
  const p = FALLBACK_LABELS[i % FALLBACK_LABELS.length];
  return { index: i, labelLeftPct: p.l, labelTopPct: p.t, bannerLeftPct: p.l, bannerTopPct: Math.max(4, p.t - 12) };
}

// Relative-share gauge: one segment per clan in creation order, widths summing
// to 100% of the count total (always-full when any bips exist). Biggest = owner.
function TerritoryGauge({
  t,
  clansOrdered,
  frameUrl,
}: {
  t: ClashTerritoryStanding;
  clansOrdered: ClashClanVisual[];
  frameUrl?: string;
}) {
  const total = clansOrdered.reduce((n, c) => n + (t.counts[String(c.team_id)] ?? 0), 0);
  return (
    <div
      className="flex h-2 w-24 rounded-full overflow-hidden bg-black/50 border border-white/25 shadow"
      style={frameUrl ? { backgroundImage: `url(${frameUrl})`, backgroundSize: '100% 100%' } : undefined}
    >
      {total > 0 &&
        clansOrdered.map((c) => {
          const count = t.counts[String(c.team_id)] ?? 0;
          if (count <= 0) return null;
          return (
            <div
              key={c.team_id}
              className="h-full transition-all duration-500"
              style={{ width: `${(count / total) * 100}%`, backgroundColor: c.color }}
            />
          );
        })}
    </div>
  );
}

export function ClashGameRenderer({
  standings,
  territoryNames,
  clanByTeamId,
  resolveMedia,
  mapImage,
  anchors,
  textElements,
  frames,
  fontFamily,
  remainingSec,
  timerPos,
  purge,
  purgeImageUrl,
  nowMs,
}: ClashGameRendererProps) {
  const now = nowMs ?? Date.now();
  const territories = standings?.territories ?? [];

  // Natural aspect of the map image, learned on load. Used to size the map box
  // (below) to the contain-fit rect of the screen - including scaling UP a map
  // smaller than the screen, which is what the studio LayoutEditor canvas does
  // (width/height 100% + object-fit: contain). Without it a small map rendered
  // at natural size in a corner of the screen and every authored anchor landed
  // on that shrunken box instead of the full-bleed map.
  const [mapRatio, setMapRatio] = useState<number | null>(null);
  const readMapRatio = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth && img.naturalHeight) {
      setMapRatio(img.naturalWidth / img.naturalHeight);
    }
  }, []);
  // The Purge visuals only exist with an enabled purge AND a scenario image.
  const purgeActive = !!(purge?.enabled && purgeImageUrl);
  const purgeTarget = purgeActive ? purge!.target_territory_index : null;

  // Clans in creation order (gauge segment order never changes).
  const clansOrdered = [...(standings?.clans ?? [])]
    .map((s) => clanByTeamId[s.team_id])
    .filter(Boolean)
    .sort((a, b) => a.team_number - b.team_number) as ClashClanVisual[];

  // Ranking rows sorted by weighted score (this is the only place order moves).
  const ranking = [...(standings?.clans ?? [])]
    .map((s) => ({ s, v: clanByTeamId[s.team_id] }))
    .filter((x) => x.v)
    .sort((a, b) => b.s.points - a.s.points);

  const events = standings?.events ?? [];

  return (
    <div className="fixed inset-0 overflow-hidden bg-slate-950 text-white" style={{ fontFamily }}>
      {/* Map + map-anchored overlays, centred and letterboxed so the map fits
          without distortion AND the territory / timer / text anchors stay
          aligned to the map bounds (they're percentages of THIS box, not the
          screen). The wrapper is sized to the contain-fit rect of the map, so
          it IS the rendered image box - percentages below resolve against the
          map exactly as they were authored over it in the studio LayoutEditor.
          Ranking + event feed below are screen chrome. */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className="relative"
          style={
            mapRatio
              ? { width: `min(100vw, ${100 * mapRatio}vh)`, height: `min(100vh, ${100 / mapRatio}vw)` }
              : undefined
          }
        >
          {mapImage ? (
            <img
              ref={readMapRatio}
              src={resolveMedia(mapImage)}
              alt=""
              // Until the natural size is known the image sizes itself (contained,
              // never upscaled); once known the wrapper owns the box and the image
              // fills it. Same rect either way - only the scale changes.
              className={mapRatio ? 'block w-full h-full' : 'block max-w-[100vw] max-h-[100vh] object-contain'}
              onLoad={(e) => readMapRatio(e.currentTarget)}
            />
          ) : (
            <div className="w-screen h-screen bg-gradient-to-br from-slate-800 to-slate-900" />
          )}

          {/* Timer - authored anchor if placed, else top-centre of the map */}
          {remainingSec != null && (
            <div
              className="absolute px-5 py-1.5 rounded-xl bg-black/70 text-3xl font-bold tabular-nums shadow-lg border border-white/15"
              style={{
                ...(timerPos
                  ? { left: `${timerPos.leftPct}%`, top: `${timerPos.topPct}%`, transform: 'translate(-50%, -50%)' }
                  : { left: '50%', top: '1rem', transform: 'translateX(-50%)' }),
                ...(frames?.timer ? { backgroundImage: `url(${frames.timer})`, backgroundSize: '100% 100%' } : {}),
              }}
            >
              {formatClock(remainingSec)}
            </div>
          )}

          {/* Territories - banners + name/gauge clusters (+ the purge marker on
              the ONE current target: exactly what a purge punch would hit now;
              it simply hops when the live target math moves it) */}
          {territories.map((t, i) => {
            const a = anchors[t.index] ?? fallbackAnchor(i);
            const isPurgeTarget = purgeTarget != null && t.index === purgeTarget;
            const purgeLeft = a.purgeLeftPct ?? a.labelLeftPct;
            const purgeTop = a.purgeTopPct ?? Math.min(96, a.labelTopPct + 12);
            const owner = t.owner_team_id != null ? clanByTeamId[t.owner_team_id] : undefined;
            return (
              <div key={t.index}>
                {isPurgeTarget && (
                  <img
                    src={purgeImageUrl}
                    alt=""
                    className="absolute -translate-x-1/2 -translate-y-1/2 h-20 object-contain drop-shadow-2xl pointer-events-none animate-pulse transition-all duration-500"
                    style={{ left: `${purgeLeft}%`, top: `${purgeTop}%` }}
                  />
                )}
                {owner?.banner && (
                  <img
                    src={resolveMedia(owner.banner)}
                    alt=""
                    className="absolute -translate-x-1/2 -translate-y-1/2 h-24 object-contain drop-shadow-2xl pointer-events-none transition-all duration-500"
                    style={{ left: `${a.bannerLeftPct}%`, top: `${a.bannerTopPct}%` }}
                  />
                )}
                <div
                  className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-1"
                  style={{ left: `${a.labelLeftPct}%`, top: `${a.labelTopPct}%` }}
                >
                  <span
                    className="text-sm font-bold px-2.5 py-0.5 rounded bg-black/60 border border-white/15 whitespace-nowrap"
                    style={
                      frames?.territoryName
                        ? { backgroundImage: `url(${frames.territoryName})`, backgroundSize: '100% 100%' }
                        : undefined
                    }
                  >
                    {territoryNames[t.index] || `Territory ${i + 1}`}
                  </span>
                  <TerritoryGauge t={t} clansOrdered={clansOrdered} frameUrl={frames?.gauge} />
                </div>
              </div>
            );
          })}

          {/* Authored map text labels (percent of the map box) */}
          {(textElements ?? []).map((te) => (
            <div
              key={te.id}
              className="absolute flex"
              style={{
                left: `${te.leftPct}%`,
                top: `${te.topPct}%`,
                width: `${te.widthPct}%`,
                height: `${te.heightPct}%`,
                color: te.color,
                fontFamily: te.fontFamily,
                fontWeight: te.bold ? 'bold' : undefined,
                fontStyle: te.italic ? 'italic' : undefined,
                textDecoration: te.underline ? 'underline' : undefined,
                textAlign: te.align ?? 'center',
                textShadow: te.shadow ? '0 2px 4px rgba(0,0,0,0.7)' : undefined,
                background: te.background ? 'rgba(0,0,0,0.45)' : undefined,
                alignItems: 'center',
                justifyContent: te.align === 'left' ? 'flex-start' : te.align === 'right' ? 'flex-end' : 'center',
                padding: te.background ? '0 0.4em' : undefined,
                borderRadius: te.background ? 4 : undefined,
                overflow: 'hidden',
              }}
            >
              {te.text}
            </div>
          ))}
        </div>
      </div>

      {/* Ranking panel (right) - full height down to just above the event feed.
          No box chrome: the ranking frame image (if any) is the only background. */}
      <aside className="absolute top-4 right-4 w-[340px]">
        {/* Frame image drives the panel's aspect ratio (no stretch/distortion);
            content is overlaid. Fallback spacer keeps height when no frame. */}
        {frames?.ranking ? (
          <img src={frames.ranking} alt="" className="block w-full h-auto" />
        ) : (
          <div className="w-full" style={{ height: '70vh' }} />
        )}
        <div className="absolute inset-0 flex flex-col px-4 pt-9 pb-4">
        <h2 className="shrink-0 text-center text-sm font-bold uppercase tracking-widest text-white/80 mb-4">
          Classement des clans
        </h2>
        {/* Four equal slots; each card is the score-card frame at its natural
            aspect (no stretch), centred in its slot - even spacing for 2–4 clans. */}
        <div className="flex-1 grid grid-rows-4 min-h-0">
          {ranking.map(({ s, v }, i) => (
            <div key={s.team_id} className="relative self-center w-full">
              {v!.scoreCard ? (
                <img src={resolveMedia(v!.scoreCard)} alt="" className="block w-full h-auto" />
              ) : (
                <div className="w-full aspect-[16/5]" />
              )}
              {/* Rank number over the frame's hexagon (top-left). */}
              <span
                className="text-2xl font-bold text-white/90 tabular-nums"
                style={{ position: 'absolute', top: '4px', left: '8px' }}
              >
                {i + 1}
              </span>
              {/* Purge token - full colour while this clan's one purge is
                  unspent, greyed once used. */}
              {purgeActive && (
                <img
                  src={purgeImageUrl}
                  alt=""
                  title={purge!.used_by.includes(s.team_id) ? 'Purge utilisée' : 'Purge disponible'}
                  className={`w-6 h-6 object-contain${purge!.used_by.includes(s.team_id) ? ' grayscale opacity-40' : ''}`}
                  style={{ position: 'absolute', bottom: '4px', left: '8px' }}
                />
              )}
              {/* Name / score / rate, stacked on the right. */}
              <div className="absolute inset-0 flex items-center pl-[16%] pr-[7%] pt-4">
                <div className="flex-1 min-w-0 text-right leading-tight">
                  <div className="font-bold uppercase truncate" style={{ color: v!.color }}>
                    {v!.name}
                  </div>
                  <div className="tabular-nums font-bold">
                    <span className="text-xl">{s.points}</span>
                    <span className="text-xs ml-1">PTS</span>
                  </div>
                  <div className="text-xs text-white/70 whitespace-nowrap">+{s.rate ?? 0} pts/min</div>
                </div>
              </div>
            </div>
          ))}
        </div>
        </div>
      </aside>

      {/* Event feed (bottom) - inset from the screen edges */}
      <div
        className="absolute bottom-3 left-3 right-3 h-16 rounded-xl bg-black/70 border border-white/15 flex items-stretch overflow-hidden shadow-lg"
        style={frames?.event ? { backgroundImage: `url(${frames.event})`, backgroundSize: '100% 100%' } : undefined}
      >
        {events.map((ev) => {
          const v = ev.team_id != null ? clanByTeamId[ev.team_id] : undefined;
          const terr = territoryNames[ev.territory_index] || `Territory ${ev.territory_index + 1}`;
          // Stable per-event key so React only mounts NEW entries (which then
          // play the entrance animation); existing entries keep their DOM.
          const key = `${ev.kind}-${ev.team_id}-${ev.territory_index}-${ev.at}`;
          return (
            <div key={key} className="animate-clash-feed-in flex items-center gap-2 px-3 border-r border-white/15 shrink-0">
              <div className="w-8 h-8 shrink-0 flex items-center justify-center overflow-hidden">
                {v?.logo ? (
                  <img src={resolveMedia(v.logo)} alt="" className="w-full h-full object-contain" />
                ) : (
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: v?.color ?? '#888' }} />
                )}
              </div>
              <div className="leading-tight max-w-[150px]">
                <div className="text-xs font-semibold text-white/90">
                  <span style={{ color: v?.color }}>{v?.name ?? '?'}</span> {eventPredicate(ev.kind, terr)}
                </div>
                <div className="text-[10px] text-white/50">{relativeAge(ev.at, now)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
