// Clash live dashboard - the "spectacular" shared screen (identical on every
// station). Full-bleed territory map: each controlled territory flies the
// controlling clan's banner and shows a name + relative-share gauge cluster;
// the ranking panel (right) tracks the weighted score + rate; the event feed
// (bottom) narrates conquests / attacks / neutralizations. Timer top-centre.
//
// Design: project_clash_game_type_design (V2).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClashStandings, ClashTerritoryStanding, ClashPurgeState } from '../services/clash';
import { tIngame } from '../i18n/ingame';
import {
  eventKey,
  eventRuns,
  relativeAge,
  type ClashEventTexts,
  type ClashT,
} from './clashEventFeed';

export type { ClashEventTexts };

/**
 * Design reference for the map-anchored chrome, in px on a 1920-wide map. The
 * runtime scales every size off the MEASURED map box against these, so the
 * dashboard reads the same on a 14" and a 15" screen (retours #52) and the
 * authored size fields (retours #57) are a plain multiplier over them.
 */
const REF_MAP_WIDTH = 1920;
/** Ranking-panel design width in px - the panel's inner layout scales off it. */
const REF_RANKING_WIDTH = 340;
const REF_TERRITORY_NAME_PX = 14; // was `text-sm`
const REF_TIMER_PX = 30; // was `text-3xl`

/** Authored on-map sizes (retours #57). Percent of map width, or % scale. */
export interface ClashSizes {
  /** Clan banner width, % of map width. */
  bannerPct: number;
  /** Purge marker width, % of map width. */
  purgePct: number;
  /** Territory gauge width, % of map width. */
  gaugePct: number;
  /** Territory-name font scale, % (100 = default). */
  territoryNameScale: number;
  /** Timer font scale, % (100 = default). */
  timerScale: number;
}

const CLASH_DEFAULT_SIZES: ClashSizes = {
  bannerPct: 5,
  purgePct: 4,
  gaugePct: 5,
  territoryNameScale: 100,
  timerScale: 100,
};

/** Per-element text colours (retours #53). '' ⇒ the historic white. */
export interface ClashColors {
  timer?: string;
  ranking?: string;
  territoryName?: string;
  event?: string;
}

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
  /** Authored timer plate (percent of map): centre anchor + optional box.
   *  Defaults to top-centre at the plate's natural size. */
  timerPos?: { leftPct: number; topPct: number; widthPct?: number; heightPct?: number } | null;
  /** Nudge of the clock inside its plate, percent of the plate box (#54). */
  timerTextOffset?: { x: number; y: number } | null;
  /** Authored clan-ranking panel box (percent of map). null ⇒ legacy top-right
   *  strip sized off the map, never the old fixed 340px (#52). */
  rankingPos?: { leftPct: number; topPct: number; widthPct: number; heightPct: number } | null;
  /** On-map element sizes (#57). Omitted fields fall back to the defaults. */
  sizes?: Partial<ClashSizes>;
  /** Per-element text colours (#53). */
  colors?: ClashColors;
  /** Scenario-authored event-banner sentences (#56). */
  eventTexts?: ClashEventTexts;
  /** The Purge live state (standings.purge); null/disabled ⇒ nothing renders. */
  purge?: ClashPurgeState | null;
  /** Resolved purge image URL ('' ⇒ purge visuals are skipped entirely). */
  purgeImageUrl?: string;
  /** Client wall-clock (ms) for event relative-age; defaults to Date.now(). */
  nowMs?: number;
  /** Language chosen at launch - the event feed + purge tooltips resolve
   *  against it, not against the operator's chrome language. */
  lang: string;
}

function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Fallback cluster positions (label anchors) for up to 8 territories; the banner
// plants slightly above its label. Used when the scenario has no layout yet.
const FALLBACK_LABELS: Array<{ l: number; t: number }> = [
  { l: 20, t: 26 }, { l: 50, t: 20 }, { l: 79, t: 28 },
  { l: 22, t: 55 }, { l: 50, t: 53 }, { l: 80, t: 58 },
  { l: 35, t: 82 }, { l: 66, t: 82 },
];

/**
 * Ranking-panel box used when the scenario has none (percent of the map box).
 * Mirrors the historic top-right strip, but in map percentages so it scales -
 * the old `top-4 right-4 w-[340px] / 70vh` never did (retours #52).
 */
const RANKING_FALLBACK_BOX = { leftPct: 74, topPct: 2, widthPct: 24, heightPct: 72 };

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
  widthPx,
}: {
  t: ClashTerritoryStanding;
  clansOrdered: ClashClanVisual[];
  frameUrl?: string;
  /** Authored gauge width in px (retours #57); the bar stays 1/12 as tall. */
  widthPx: number;
}) {
  const total = clansOrdered.reduce((n, c) => n + (t.counts[String(c.team_id)] ?? 0), 0);
  return (
    <div
      className="flex rounded-full overflow-hidden bg-black/50 border border-white/25 shadow"
      style={{
        width: `${Math.max(8, widthPx)}px`,
        height: `${Math.max(2, widthPx / 12)}px`,
        ...(frameUrl ? { backgroundImage: `url(${frameUrl})`, backgroundSize: '100% 100%' } : {}),
      }}
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
  timerTextOffset,
  rankingPos,
  sizes,
  colors,
  eventTexts,
  purge,
  purgeImageUrl,
  nowMs,
  lang,
}: ClashGameRendererProps) {
  const now = nowMs ?? Date.now();
  const tc = useCallback<ClashT>(
    (key, vars) => tIngame('ingame_clash', key, lang, vars),
    [lang],
  );
  const territories = standings?.territories ?? [];
  const sz: ClashSizes = { ...CLASH_DEFAULT_SIZES, ...(sizes ?? {}) };
  const inkTimer = colors?.timer || '#ffffff';
  const inkRanking = colors?.ranking || '#ffffff';
  const inkTerritory = colors?.territoryName || '#ffffff';
  const inkEvent = colors?.event || '#ffffff';

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

  // Rendered map-box width in px. Font sizes and the ranking panel's inner
  // layout scale off it against REF_MAP_WIDTH, so the dashboard keeps its
  // proportions on any screen instead of the old fixed px chrome (retours #52).
  const mapBoxRef = useRef<HTMLDivElement | null>(null);
  const [mapBoxWidth, setMapBoxWidth] = useState(0);
  useEffect(() => {
    const node = mapBoxRef.current;
    if (!node) return;
    const read = () => setMapBoxWidth(node.getBoundingClientRect().width);
    read();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(node);
    return () => ro.disconnect();
  }, [mapRatio]);
  // Until the box is measured, fall back to the reference so the first paint is
  // sane rather than zero-sized.
  const mapScale = (mapBoxWidth || REF_MAP_WIDTH) / REF_MAP_WIDTH;
  const territoryNamePx = REF_TERRITORY_NAME_PX * mapScale * (sz.territoryNameScale / 100);
  const timerPx = REF_TIMER_PX * mapScale * (sz.timerScale / 100);
  // The gauge lives inside the shrink-to-fit name/gauge cluster, so a CSS `%`
  // there would resolve against the cluster, not the map - size it in px.
  const gaugeWidthPx = (mapBoxWidth || REF_MAP_WIDTH) * (sz.gaugePct / 100);
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
          The ranking panel and the event feed live in here too: everything the
          author sees over the map in the editor must stay over the map here. */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          ref={mapBoxRef}
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

          {/* Timer plate - authored anchor + box if placed, else top-centre at
              its natural size. The plate (frame art or the dark fallback) and
              the clock are drawn separately so the clock can be nudged inside
              a frame whose artwork is not centred (retours #54); the offset is
              a percentage of the plate box, authored in the layout editor. */}
          {remainingSec != null && (() => {
            const boxed = !!(timerPos?.widthPct && timerPos?.heightPct);
            const off = timerTextOffset ?? { x: 0, y: 0 };
            return (
              <div
                className="absolute"
                style={{
                  ...(timerPos
                    ? { left: `${timerPos.leftPct}%`, top: `${timerPos.topPct}%`, transform: 'translate(-50%, -50%)' }
                    : { left: '50%', top: '1rem', transform: 'translateX(-50%)' }),
                  ...(boxed
                    ? { width: `${timerPos!.widthPct}%`, height: `${timerPos!.heightPct}%` }
                    : {}),
                }}
              >
                {/* Plate */}
                <div
                  className={`absolute inset-0 rounded-xl${frames?.timer ? '' : ' bg-black/70 shadow-lg border border-white/15'}`}
                  style={
                    frames?.timer
                      ? { backgroundImage: `url(${frames.timer})`, backgroundSize: '100% 100%' }
                      : undefined
                  }
                />
                {/* Clock - centred in the plate, then nudged by the offset. */}
                <div
                  className="relative flex items-center justify-center font-bold tabular-nums"
                  style={{
                    // An unboxed plate has no height of its own: keep the old
                    // padding so it still hugs the digits.
                    // The digits are cap-trimmed (vcenter-text), so an unboxed
                    // plate pins its old 1em line height back explicitly.
                    ...(boxed
                      ? { width: '100%', height: '100%' }
                      : { padding: '0.375rem 1.25rem', height: 'calc(1em + 0.75rem)' }),
                    transform: `translate(${off.x}%, ${off.y}%)`,
                    fontSize: `${timerPx}px`,
                    lineHeight: 1,
                    color: inkTimer,
                  }}
                >
                  <span className="vcenter-text">{formatClock(remainingSec)}</span>
                </div>
              </div>
            );
          })()}

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
                    className="absolute -translate-x-1/2 -translate-y-1/2 object-contain drop-shadow-2xl pointer-events-none animate-pulse transition-all duration-500"
                    style={{ left: `${purgeLeft}%`, top: `${purgeTop}%`, width: `${sz.purgePct}%` }}
                  />
                )}
                {owner?.banner && (
                  <img
                    src={resolveMedia(owner.banner)}
                    alt=""
                    className="absolute -translate-x-1/2 -translate-y-1/2 object-contain drop-shadow-2xl pointer-events-none transition-all duration-500"
                    style={{
                      left: `${a.bannerLeftPct}%`,
                      top: `${a.bannerTopPct}%`,
                      width: `${sz.bannerPct}%`,
                    }}
                  />
                )}
                <div
                  className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-1"
                  style={{ left: `${a.labelLeftPct}%`, top: `${a.labelTopPct}%` }}
                >
                  <span
                    className={`flex items-center font-bold px-2.5 py-0.5 rounded whitespace-nowrap${
                      frames?.territoryName ? '' : ' bg-black/60 border border-white/15'
                    }`}
                    style={{
                      fontSize: `${territoryNamePx}px`,
                      lineHeight: 1.35,
                      // Border-box: the 1.35em line plus the py-0.5 padding.
                      height: 'calc(1.35em + 0.25rem)',
                      color: inkTerritory,
                      ...(frames?.territoryName
                        ? { backgroundImage: `url(${frames.territoryName})`, backgroundSize: '100% 100%' }
                        : {}),
                    }}
                  >
                    <span className="vcenter-text">
                      {territoryNames[t.index] || tc('territory_fallback', { n: i + 1 })}
                    </span>
                  </span>
                  <TerritoryGauge
                    t={t}
                    clansOrdered={clansOrdered}
                    frameUrl={frames?.gauge}
                    widthPx={gaugeWidthPx}
                  />
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
              <span className="vcenter-text">{te.text}</span>
            </div>
          ))}

          {/* Clan-ranking panel. Anchored to the MAP box (like every other
              placeable element) and sized in percent of it, so it holds its
              proportions on any screen - it used to be pinned top-right at a
              fixed 340px, which read tiny on a 15" and could not be moved at
              all (retours #52). `rankingPos` is authored in the layout editor;
              the fallback keeps the historic top-right placement but in map
              percentages. Everything inside scales off the panel's own width
              against REF_RANKING_WIDTH. */}
          {(() => {
            const box = rankingPos ?? RANKING_FALLBACK_BOX;
            const panelWidthPx = (mapBoxWidth || REF_MAP_WIDTH) * (box.widthPct / 100);
            const rs = panelWidthPx / REF_RANKING_WIDTH;
            const rpx = (n: number) => `${n * rs}px`;
            return (
              <aside
                className="absolute"
                style={{
                  left: `${box.leftPct}%`,
                  top: `${box.topPct}%`,
                  width: `${box.widthPct}%`,
                  height: `${box.heightPct}%`,
                  color: inkRanking,
                }}
              >
                {/* The frame art fills the authored box - the author sizes the
                    box to the artwork in the layout editor, which previews it
                    exactly like this. No frame ⇒ no chrome, as before. */}
                {frames?.ranking && (
                  <div
                    className="absolute inset-0"
                    style={{ backgroundImage: `url(${frames.ranking})`, backgroundSize: '100% 100%' }}
                  />
                )}
                <div
                  className="absolute inset-0 flex flex-col"
                  style={{ padding: `${36 * rs}px ${16 * rs}px ${16 * rs}px` }}
                >
                  <h2
                    className="shrink-0 text-center font-bold uppercase"
                    style={{ fontSize: rpx(14), letterSpacing: '0.12em', marginBottom: rpx(16) }}
                  >
                    {eventTexts?.rankingTitle || tc('ranking_title')}
                  </h2>
                  {/* Four equal slots; each card is the score-card frame at its
                      natural aspect (no stretch), centred in its slot - even
                      spacing for 2–4 clans. */}
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
                          className="font-bold tabular-nums"
                          style={{ position: 'absolute', top: rpx(4), left: rpx(8), fontSize: rpx(24) }}
                        >
                          {i + 1}
                        </span>
                        {/* Purge token - full colour while this clan's one purge
                            is unspent, greyed once used. */}
                        {purgeActive && (
                          <img
                            src={purgeImageUrl}
                            alt=""
                            title={purge!.used_by.includes(s.team_id) ? tc('purge_used') : tc('purge_available')}
                            className={`object-contain${purge!.used_by.includes(s.team_id) ? ' grayscale opacity-40' : ''}`}
                            style={{ position: 'absolute', bottom: rpx(4), left: rpx(8), width: rpx(24), height: rpx(24) }}
                          />
                        )}
                        {/* Name / score / rate, stacked on the right. */}
                        <div
                          className="absolute inset-0 flex items-center"
                          style={{ paddingLeft: '16%', paddingRight: '7%', paddingTop: rpx(16) }}
                        >
                          <div className="flex-1 min-w-0 text-right leading-tight">
                            <div
                              className="font-bold uppercase truncate"
                              style={{ color: v!.color, fontSize: rpx(16) }}
                            >
                              {v!.name}
                            </div>
                            <div className="tabular-nums font-bold">
                              <span style={{ fontSize: rpx(20) }}>{s.points}</span>
                              <span style={{ fontSize: rpx(12), marginLeft: rpx(4) }} className="uppercase">
                                {tc('pts')}
                              </span>
                            </div>
                            <div className="whitespace-nowrap opacity-70" style={{ fontSize: rpx(12) }}>
                              {tc('rate_per_min', { n: s.rate ?? 0 })}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </aside>
            );
          })()}
          {/* Event feed (bottom) - inset from the MAP box, NOT from the screen.
              The map is letterboxed, and the studio LayoutEditor previews the
              feed over the map image; anchoring it to the screen made it spill
              onto the black bars, so the preview and the render disagreed. */}
          <div
            className="absolute bottom-3 left-3 right-3 h-16 rounded-xl bg-black/70 border border-white/15 flex items-stretch overflow-hidden shadow-lg"
            style={frames?.event ? { backgroundImage: `url(${frames.event})`, backgroundSize: '100% 100%' } : undefined}
          >
            {events.map((ev) => {
              const v = ev.team_id != null ? clanByTeamId[ev.team_id] : undefined;
              const terr =
                territoryNames[ev.territory_index] ||
                tc('territory_fallback', { n: ev.territory_index + 1 });
              const clanName = v?.name ?? '?';
              // Scenario-authored sentence wins over the app default (retours #56);
              // `%CLAN%` picks up the clan colour wherever the author put it.
              const runs = eventRuns(ev, clanName, terr, eventTexts, tc);
              // Stable per-event key so React only mounts NEW entries (which then
              // play the entrance animation); existing entries keep their DOM.
              const key = eventKey(ev);
              return (
                <div key={key} className="animate-clash-feed-in flex items-center gap-2 px-3 border-r border-white/15 shrink-0">
                  <div className="w-8 h-8 shrink-0 flex items-center justify-center overflow-hidden">
                    {v?.logo ? (
                      <img src={resolveMedia(v.logo)} alt="" className="w-full h-full object-contain" />
                    ) : (
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: v?.color ?? '#888' }} />
                    )}
                  </div>
                  {/* 300px (was 150): authors reword the sentences to fit
                      singular AND plural clan names ("Le clan %CLAN% a
                      conquis…"), which no longer fit - retours sept. #67.
                      Keep in step with the studio LayoutEditor mock. */}
                  <div className="leading-tight max-w-[300px]">
                    <div className="text-xs font-semibold" style={{ color: inkEvent }}>
                      {runs.map((run, ri) => (
                        <span key={ri} style={run.clan ? { color: v?.color } : undefined}>
                          {run.text}
                        </span>
                      ))}
                    </div>
                    <div className="text-[10px] opacity-50" style={{ color: inkEvent }}>
                      {relativeAge(ev.at, now, tc)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
