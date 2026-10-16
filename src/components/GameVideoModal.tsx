// Video playback modal - opened from a launched-game card. Lets the mother
// queue intro / tutorial video playback (or stop it) on the satellites that
// have joined this game. Extracted from the in-game Devices modal so the two
// concerns (device roster vs. video control) live in separate modals.
//
// Targets are ALL the "in this game" devices - the operator's own screen
// included, whichever device this modal is open on. Two channels get us there:
//  - our OWN row can't ride the pending_commands queue (a device never polls
//    its own queue), so it's dispatched in-process through `localVideoStore`,
//    the same path the in-game VideoControlModal uses;
//  - every other row goes over the bulk queue, INCLUDING the mother's row when
//    a satellite operator drives the room's main screen: `queue_command_inner`
//    detects a self-targeted play_video/stop_video and emits it straight to the
//    mother's renderer instead of enqueueing it.
// Either way the App-root <OperatorVideoOverlay> is what mounts the playback.
//
// The modal polls list_paired_with_status every 2s while open so the
// selectable roster stays in sync as devices join / leave.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Video, X, Play, StopCircle, Loader2, Usb, AlertTriangle } from 'lucide-react';
import {
  listPairedWithStatus,
  queuePlayVideoBulk,
  queueStopVideoBulk,
  getLaunchedGameState,
  type PairedDeviceStatusRow,
} from '../services/launchedGames';
import {
  resolveVideosByKind,
  declaredVideoKinds,
  applySubtitleChoice,
  SUBTITLE_AUTO,
  subtitlePickOf,
  type VideoSource,
} from '../services/videoResolution';
import { VideoSubtitlePicker } from './VideoSubtitlePicker';
import { emitLocalPlayVideo, emitLocalStopVideo } from '../services/localVideoStore';
import { HelpDot } from '../help';

interface GameVideoModalProps {
  launchedGameId: number;
  // Used to render the language label on play_video commands. Empty string is
  // accepted; the satellite resolves to its default if absent.
  gameLanguage: string;
  onClose: () => void;
}

const POLL_MS = 2000;

// Availability of each video kind for the launched game's scenario + game
// type. `null` = still resolving. Read from the synced METADATA (does the
// scenario declare an intro, does the game type have a tutorial), not from the
// files on this device: the operator's device may hold none of them (an
// operator-only tablet skips every video) while the targets do. A game that
// declares nothing has nothing to push - and the operator sees that instead of
// a silent no-op.
interface VideoAvail {
  intro: boolean;
  tutorial: boolean;
}

export function GameVideoModal({
  launchedGameId,
  gameLanguage,
  onClose,
}: GameVideoModalProps) {
  const { t } = useTranslation();
  const [inGame, setInGame] = useState<PairedDeviceStatusRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [errorFor, setErrorFor] = useState<Map<number, string>>(new Map());
  const [playMenuOpen, setPlayMenuOpen] = useState(false);
  const [avail, setAvail] = useState<VideoAvail | null>(null);
  // The resolved sources behind `avail`, kept so a local (this-device) play can
  // hand them straight to <OperatorVideoOverlay> without re-resolving.
  const [videos, setVideos] = useState<VideoSource[]>([]);
  // Subtitle languages the game's videos declare (intro + tutorial merged), and
  // the operator's pick: 'auto' leaves each device on its own default, 'off'
  // forces none, a language code forces that track on every target.
  const [subtitleLangs, setSubtitleLangs] = useState<string[]>([]);
  const [subtitleChoice, setSubtitleChoice] = useState<string>(SUBTITLE_AUTO);
  // Per-device picks (paired_devices.id -> picker value), each overriding
  // `subtitleChoice` for that one device - a room where the screens face
  // audiences of different languages. Changing the all-devices pick resets them.
  const [deviceSubtitle, setDeviceSubtitle] = useState<Map<number, string>>(new Map());
  // paired_devices.id of THIS device, server-resolved from our bearer secret.
  // is_self can't answer "which row am I?" here: the roster comes from the
  // mother's DB, so is_self marks the MOTHER's row even when this modal is
  // open on a satellite. Null with an older mother build -> fall back to is_self.
  const [callerId, setCallerId] = useState<number | null>(null);

  // Resolve which video kinds actually exist for this game, once. A missing
  // asset (no scenario intro video, or a game type whose tutorial video isn't
  // downloaded / has no path) drops out of the resolved list, so we mark that
  // kind unavailable and grey out its menu item.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const state = await getLaunchedGameState(launchedGameId, 0);
        const [vids, declared] = await Promise.all([
          resolveVideosByKind(
            ['tutorial', 'intro'],
            state.game_uniqid,
            state.game_type,
            gameLanguage || 'fr',
          ),
          declaredVideoKinds(state.game_uniqid, state.game_type),
        ]);
        if (cancelled) return;
        setVideos(vids);
        setSubtitleLangs(
          Array.from(
            new Set([
              ...declared.subtitleLangs.tutorial,
              ...declared.subtitleLangs.intro,
              // Tracks found on this device but not declared (older data shapes).
              ...vids.flatMap((v) => Object.keys(v.subtitles)),
            ]),
          ).sort(),
        );
        // A kind is offered when the game DECLARES it, even with no file on
        // this device: an operator-only tablet syncs no video at all yet must
        // still drive the playing devices, which resolve their own copy. The
        // local hit is OR-ed in for the operator-imported tutorial (Settings >
        // Videos), which exists on disk without any synced metadata.
        setAvail({
          intro: declared.intro || vids.some((v) => v.kind === 'intro'),
          tutorial: declared.tutorial || vids.some((v) => v.kind === 'tutorial'),
        });
      } catch {
        // Couldn't resolve (game state fetch failed / scenario not downloaded)
        // - treat as nothing available rather than pretending both exist.
        if (!cancelled) {
          setVideos([]);
          setAvail({ intro: false, tutorial: false });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [launchedGameId, gameLanguage]);

  const resolving = avail === null;
  const hasIntro = avail?.intro ?? false;
  const hasTutorial = avail?.tutorial ?? false;
  const noneAvailable = !resolving && !hasIntro && !hasTutorial;

  // Poll loop - keep the in-game roster fresh; prune selection / busy state for
  // devices that have left the game so stale spinners don't linger.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const next = await listPairedWithStatus(launchedGameId).catch(() => null);
      if (cancelled || !next) return;
      setInGame(next.in_game);
      setCallerId(next.caller_device_id ?? null);
      const ids = new Set(next.in_game.map((r) => r.id));
      setSelected((prev) => {
        if (prev.size === 0) return prev;
        const out = new Set<number>();
        for (const id of prev) if (ids.has(id)) out.add(id);
        return out;
      });
      setBusy((prev) => {
        if (prev.size === 0) return prev;
        const out = new Set<number>();
        for (const id of prev) if (ids.has(id)) out.add(id);
        return out;
      });
    };
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [launchedGameId]);

  // Every in-game device is a valid target, including this one. Two channels
  // get us there: our OWN row (id === callerId) plays through localVideoStore
  // in this renderer, everything else rides the bulk queue - and the mother's
  // row is fine there too, since `queue_command_inner` now executes a
  // self-targeted play_video/stop_video in-process rather than enqueueing it.
  const selectable = inGame;

  // Picker value in force for one device: its own pick, else the all-devices one.
  function subtitleChoiceFor(deviceId: number): string {
    return deviceSubtitle.get(deviceId) ?? subtitleChoice;
  }

  function setAllSubtitles(next: string) {
    setSubtitleChoice(next);
    setDeviceSubtitle(new Map());
  }

  function setOneSubtitle(deviceId: number, next: string) {
    setDeviceSubtitle((m) => new Map(m).set(deviceId, next));
  }

  // Dispatch on THIS device via localVideoStore. Returns false when this
  // device holds no file for the requested kinds (nothing to show here).
  function playHere(kinds: Array<'intro' | 'tutorial'>, deviceId: number): boolean {
    const sources = kinds
      .map((k) => videos.find((v) => v.kind === k))
      .filter((v): v is VideoSource => v != null);
    if (sources.length === 0) return false;
    // Nothing rides along for 'auto' (device default).
    emitLocalPlayVideo(applySubtitleChoice(sources, subtitlePickOf(subtitleChoiceFor(deviceId))));
    return true;
  }

  // Split the selection into "me" (in-process) and the rest (bulk queue).
  function splitTargets(): { localTarget: number | null; remote: number[] } {
    const targets = Array.from(selected);
    const localTarget = callerId != null && selected.has(callerId) ? callerId : null;
    return { localTarget, remote: targets.filter((id) => id !== localTarget) };
  }

  function clearBusySoon(ids: number[]) {
    // No per-target ack short of the satellite mounting the overlay (which we
    // don't track on the mother). Clear the in-flight spinner after a beat.
    window.setTimeout(() => {
      setBusy((s) => {
        if (s.size === 0) return s;
        const n = new Set(s);
        for (const id of ids) n.delete(id);
        return n;
      });
    }, 1500);
  }

  async function onPlayVideo(kinds: Array<'intro' | 'tutorial'>) {
    setPlayMenuOpen(false);
    const targets = Array.from(selected);
    if (targets.length === 0) return;
    const { localTarget, remote } = splitTargets();
    setBusy((s) => {
      const n = new Set(s);
      for (const id of targets) n.add(id);
      return n;
    });
    let remoteFailed = false;
    // A bulk command carries ONE payload for all its targets, so the remote
    // devices go out as one bulk per subtitle pick.
    const bySubtitle = new Map<string, number[]>();
    for (const id of remote) {
      const choice = subtitleChoiceFor(id);
      bySubtitle.set(choice, [...(bySubtitle.get(choice) ?? []), id]);
    }
    await Promise.all(
      Array.from(bySubtitle, async ([choice, ids]) => {
        try {
          const res = await queuePlayVideoBulk(ids, launchedGameId, kinds, gameLanguage, subtitlePickOf(choice));
          // The bulk endpoint reports per-target failures (target_not_in_game,
          // targeting self, ...) inside a 200 response - surface them, otherwise
          // a rejected queue looks identical to a successful push.
          setErrorFor((m) => {
            const n = new Map(m);
            for (const r of res.results) {
              if (r.error) n.set(r.target_device_id, r.error);
              else n.delete(r.target_device_id);
            }
            return n;
          });
          if (res.results.some((r) => r.error)) remoteFailed = true;
        } catch (e) {
          const msg = (e as Error).message;
          setErrorFor((m) => {
            const n = new Map(m);
            for (const id of ids) n.set(id, msg);
            return n;
          });
          remoteFailed = true;
        }
      }),
    );
    clearBusySoon(targets);
    if (localTarget == null) return;
    if (!playHere(kinds, localTarget)) {
      setErrorFor((m) => new Map(m).set(localTarget, t('devicesModal:videoNotOnThisDevice')));
      return;
    }
    setErrorFor((m) => {
      if (!m.has(localTarget)) return m;
      const n = new Map(m);
      n.delete(localTarget);
      return n;
    });
    // The overlay takes over this screen, so get the modal out of the way -
    // unless a satellite push failed, in which case keep it up so the operator
    // still sees the error once playback ends.
    if (!remoteFailed) onClose();
  }

  async function onStopVideo() {
    const targets = Array.from(selected);
    if (targets.length === 0) return;
    const { localTarget, remote } = splitTargets();
    setBusy((s) => {
      const n = new Set(s);
      for (const id of targets) n.add(id);
      return n;
    });
    if (localTarget != null) {
      emitLocalStopVideo();
      setErrorFor((m) => {
        if (!m.has(localTarget)) return m;
        const n = new Map(m);
        n.delete(localTarget);
        return n;
      });
    }
    if (remote.length > 0) {
      try {
        const res = await queueStopVideoBulk(remote, launchedGameId);
        setErrorFor((m) => {
          const n = new Map(m);
          for (const r of res.results) {
            if (r.error) n.set(r.target_device_id, r.error);
            else n.delete(r.target_device_id);
          }
          return n;
        });
      } catch (e) {
        const msg = (e as Error).message;
        setErrorFor((m) => {
          const n = new Map(m);
          for (const id of remote) n.set(id, msg);
          return n;
        });
      }
    }
    clearBusySoon(targets);
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const eligible = selectable.map((r) => r.id);
      const allSelected = eligible.length > 0 && eligible.every((id) => prev.has(id));
      if (allSelected) return new Set();
      return new Set(eligible);
    });
  }

  function toggleOne(deviceId: number) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(deviceId)) n.delete(deviceId);
      else n.add(deviceId);
      return n;
    });
  }

  return (
    <div className="pg-overlay" onClick={onClose}>
      <div className="pg-modal max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="pg-modal-head">
          <h3 className="pg-modal-title flex items-center gap-2">
            <Video size={20} className="text-purple-500" />
            {t('devicesModal:videoTitle')}
          </h3>
          <button onClick={onClose} className="pg-modal-close" aria-label={t('devicesModal:close')}>
            <X size={20} />
          </button>
        </div>

        <div className="pg-modal-body">
          {/* Action bar */}
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            {selectable.length > 0 ? (
              <label className="flex items-center gap-2 text-sm text-[var(--pg-text-muted)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-[var(--pg-accent)]"
                  checked={selected.size > 0 && selectable.every((r) => selected.has(r.id))}
                  onChange={toggleSelectAll}
                />
                {t('devicesModal:selectAll')}
              </label>
            ) : (
              <span className="text-xs text-[var(--pg-text-dim)] italic">
                {t('devicesModal:addSatelliteHint')}
              </span>
            )}
            <div className="flex-1" />
            <span className="text-xs text-[var(--pg-text-dim)]">
              {t('devicesModal:selectedCount', { count: selected.size })}
            </span>
            <div className="relative">
              <button
                className="px-3 py-1.5 bg-[var(--pg-accent)] hover:bg-[var(--pg-accent-hover)] disabled:bg-[var(--pg-surface-3)] disabled:text-[var(--pg-text-dim)] text-white rounded-[var(--pg-radius-md)] text-sm flex items-center gap-1.5"
                disabled={selected.size === 0 || resolving || noneAvailable}
                title={
                  resolving
                    ? t('devicesModal:videoChecking')
                    : noneAvailable
                      ? t('devicesModal:videoNoneAvailable')
                      : selectable.length === 0
                        ? t('devicesModal:playTitleNoSatellites')
                        : selected.size === 0
                          ? t('devicesModal:playTitleTickOne')
                          : t('devicesModal:playTitlePick')
                }
                onClick={() => setPlayMenuOpen((v) => !v)}
              >
                <Play size={14} />
                {t('devicesModal:play')}
                <span className="text-xs opacity-70">▾</span>
              </button>
              {playMenuOpen && (
                <div className="absolute right-0 top-full mt-1 bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)] shadow-xl z-10 min-w-[160px]">
                  <PlayMenuItem
                    label={t('devicesModal:videoTutorial')}
                    disabled={!hasTutorial}
                    title={!hasTutorial ? t('devicesModal:videoTutorialUnavailable') : undefined}
                    onClick={() => onPlayVideo(['tutorial'])}
                  />
                  <PlayMenuItem
                    label={t('devicesModal:videoIntro')}
                    disabled={!hasIntro}
                    title={!hasIntro ? t('devicesModal:videoIntroUnavailable') : undefined}
                    onClick={() => onPlayVideo(['intro'])}
                  />
                  {/* Tutorial FIRST, then the scenario intro (retour 2026-09-16). */}
                  <PlayMenuItem
                    label={t('devicesModal:videoIntroTutorial')}
                    disabled={!hasIntro || !hasTutorial}
                    title={
                      !hasTutorial
                        ? t('devicesModal:videoTutorialUnavailable')
                        : !hasIntro
                          ? t('devicesModal:videoIntroUnavailable')
                          : undefined
                    }
                    onClick={() => onPlayVideo(['tutorial', 'intro'])}
                  />
                </div>
              )}
            </div>
            <HelpDot topic="devices.play" />
            <button
              className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 disabled:bg-[var(--pg-surface-3)] disabled:text-[var(--pg-text-dim)] text-white rounded-[var(--pg-radius-md)] text-sm flex items-center gap-1.5"
              disabled={selected.size === 0}
              title={selected.size === 0 ? t('devicesModal:playTitleTickOne') : t('devicesModal:stopTitle')}
              onClick={onStopVideo}
            >
              <StopCircle size={14} />
              {t('devicesModal:stop')}
            </button>
            <HelpDot topic="devices.stop" />
          </div>

          {/* Subtitle language pushed with the next "Play": this one sets every
              device at once, each row below can then differ. Only shown when
              the game's videos declare at least one track. */}
          <VideoSubtitlePicker
            langs={subtitleLangs}
            value={subtitleChoice}
            onChange={setAllSubtitles}
            label={t('devicesModal:subtitlesAllLabel')}
            className="mb-4"
          />

          {/* Availability notice: resolving spinner, or a warning when this
              game has no intro/tutorial video at all (the usual reason a push
              looks like it "does nothing" - there's simply nothing to play). */}
          {resolving ? (
            <div className="flex items-center gap-2 text-xs text-[var(--pg-text-dim)] mb-4">
              <Loader2 size={14} className="animate-spin" />
              {t('devicesModal:videoChecking')}
            </div>
          ) : noneAvailable ? (
            <div className="flex items-start gap-2 text-sm text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-[var(--pg-radius-md)] px-3 py-2 mb-4">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{t('devicesModal:videoNoneAvailable')}</span>
            </div>
          ) : null}

          {/* Device list */}
          {inGame.length === 0 ? (
            <p className="text-sm text-[var(--pg-text-dim)] italic px-1">
              {t('devicesModal:emptyInGame')}
            </p>
          ) : (
            <ul className="space-y-2">
              {inGame.map((row) => (
                <li key={row.id}>
                  <VideoDeviceRow
                    row={row}
                    selected={selected.has(row.id)}
                    onToggle={() => toggleOne(row.id)}
                    thisDevice={callerId != null ? row.id === callerId : row.is_self}
                    subtitleLangs={subtitleLangs}
                    subtitleChoice={subtitleChoiceFor(row.id)}
                    onSubtitleChange={(next) => setOneSubtitle(row.id, next)}
                    busy={busy.has(row.id)}
                    error={errorFor.get(row.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function PlayMenuItem({
  label,
  disabled,
  title,
  onClick,
}: {
  label: string;
  disabled: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      className="block w-full text-left px-3 py-2 text-sm text-[var(--pg-text)] hover:bg-[var(--pg-surface-3)] disabled:text-[var(--pg-text-dim)] disabled:hover:bg-transparent disabled:cursor-not-allowed"
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function VideoDeviceRow({
  row,
  selected,
  onToggle,
  thisDevice,
  subtitleLangs,
  subtitleChoice,
  onSubtitleChange,
  busy,
  error,
}: {
  row: PairedDeviceStatusRow;
  selected: boolean;
  onToggle: () => void;
  thisDevice: boolean;
  subtitleLangs: string[];
  subtitleChoice: string;
  onSubtitleChange: (next: string) => void;
  busy: boolean;
  error: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 p-3 bg-[var(--pg-bg)] border border-[var(--pg-line)] rounded-[var(--pg-radius-md)]">
      <input
        type="checkbox"
        className="w-4 h-4 accent-[var(--pg-accent)]"
        checked={selected}
        onChange={onToggle}
      />
      <div className="min-w-0">
        <div className="text-sm font-medium text-[var(--pg-text)] truncate">
          {row.device_label}
          {thisDevice && (
            <span className="ml-2 text-xs text-[var(--pg-text-dim)]">{t('devicesModal:thisDevice')}</span>
          )}
        </div>
        {row.peer_os && (
          <div className="text-xs text-[var(--pg-text-dim)] truncate">{row.peer_os}</div>
        )}
      </div>
      <div className="flex-1" />
      <VideoSubtitlePicker
        langs={subtitleLangs}
        value={subtitleChoice}
        onChange={onSubtitleChange}
        perDevice
        className="shrink-0"
      />
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
          row.has_reader
            ? 'bg-green-500/10 text-green-400'
            : 'bg-[var(--pg-surface-3)] text-[var(--pg-text-dim)]'
        }`}
        title={row.has_reader ? t('devicesModal:readerAttached') : t('devicesModal:noReaderTitle')}
      >
        <Usb size={12} />
        {row.has_reader ? t('devicesModal:reader') : t('devicesModal:noReader')}
      </span>
      {busy && <Loader2 size={16} className="animate-spin text-[var(--pg-accent-bright)]" />}
      {error && (
        <span className="text-xs text-red-400 px-2 py-0.5 bg-red-500/10 rounded">{error}</span>
      )}
    </div>
  );
}
