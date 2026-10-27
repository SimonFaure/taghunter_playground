// Satellite-side overlay that the mother can drive via `play_video` /
// `stop_video` commands. Mounted once at the App root so it can preempt
// any other UI when a command lands. Uses the existing FirstBipVideoOverlay
// for rendering - the only delta is the trigger source (operator vs. local
// first-bip) and the absence of a state-mutating callback when playback ends.

import { useCallback, useEffect, useRef, useState } from 'react';
import { registerLanCommandHandler, type CommandResult } from '../services/lanCommands';
import { FirstBipVideoOverlay } from './FirstBipVideoOverlay';
import { resolveVideosByKind, applySubtitleChoice, type VideoSource } from '../services/videoResolution';
import { getLaunchedGameState } from '../services/launchedGames';
import { pointLaunchedGamesAtMother } from '../services/lanMotherBoot';
import { getPairedMother } from '../services/lanPairing';
import { onLocalVideoCommand } from '../services/localVideoStore';
import { pushOverlay, popOverlay } from '../services/screenState';
import { waitForPresentationIdle } from '../services/presentationGate';

interface LanCommand {
  id: number;
  kind: string;
  payload: {
    launched_game_id?: number;
    kinds?: Array<'intro' | 'tutorial'>;
    language?: string;
    // Subtitle track the operator picked ('off' | '<lang>'). Absent = this
    // device's own default.
    subtitle_lang?: string;
    // Present only on a command this device's OWN mother server dispatched
    // in-process (a satellite operator targeting the mother's screen). The
    // server resolved the scenario identity for us - see queue_command_inner -
    // because we can't fetch it over HTTP: we ARE the mother, and our
    // launched_games route may be pointed at a different one.
    game_uniqid?: string;
    game_type?: string;
  };
  mother_uuid?: string;
  mother_addr?: string;
}

export function OperatorVideoOverlay() {
  const [videos, setVideos] = useState<VideoSource[] | null>(null);
  // Bumped on every play/stop request so a play that is waiting for an in-game
  // animation to finish can detect it was superseded (newer play, or a stop)
  // and abort instead of popping up after the operator changed their mind.
  const playGenRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Start playback, but first wait until any in-game team reveal animation /
  // status message is done. The reveal overlay renders at z-5000 while this
  // video sits at z-100, so mounting it mid-animation would just play audio
  // behind the reveal (looks broken). Resolves immediately when no game page is
  // presenting, so idle / non-in-game devices play with no delay.
  const startVideosDeferred = useCallback(async (resolved: VideoSource[]) => {
    if (resolved.length === 0) return;
    const gen = ++playGenRef.current;
    await waitForPresentationIdle();
    if (!mountedRef.current || playGenRef.current !== gen) return; // superseded
    setVideos(resolved);
  }, []);

  // Stop playback and cancel any play that is still waiting on the gate.
  const stopVideos = useCallback(() => {
    playGenRef.current += 1;
    setVideos(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const offStop = registerLanCommandHandler('stop_video', () => {
      stopVideos();
    });
    const offPlay = registerLanCommandHandler('play_video', async (cmd: LanCommand): Promise<CommandResult> => {
      const gid = cmd.payload.launched_game_id;
      const kinds = cmd.payload.kinds ?? [];
      const language = cmd.payload.language ?? 'fr';
      const subtitleChoice = cmd.payload.subtitle_lang;
      if (!gid || kinds.length === 0) return { ok: false, error: 'bad_payload' };
      // Locally dispatched by our own mother server: the scenario identity
      // rode along in the payload, so there is nothing to repoint or fetch.
      if (cmd.payload.game_uniqid && cmd.payload.game_type) {
        const local = await resolveVideosByKind(
          kinds,
          cmd.payload.game_uniqid,
          cmd.payload.game_type,
          language,
        );
        if (cancelled) return { ok: false, error: 'unmounted' };
        if (local.length === 0) {
          console.warn('[OperatorVideoOverlay] no playable assets for kinds', kinds);
          return { ok: false, error: 'no_videos' };
        }
        void startVideosDeferred(applySubtitleChoice(local, subtitleChoice));
        return { ok: true };
      }
      // The pushed game lives in the PUSHING mother's SQLite. Repoint our
      // launched_games traffic there before the state fetch (same as App's
      // join_game handler): the ambient route may have been restored to
      // this device's own local server, where `gid` either doesn't exist
      // (fetch throws -> silent abort) or collides with a DIFFERENT local
      // game whose scenario resolves no videos.
      if (cmd.mother_uuid && cmd.mother_addr) {
        try {
          const m = await getPairedMother(cmd.mother_uuid);
          if (m) pointLaunchedGamesAtMother(`http://${cmd.mother_addr}`, m.peer_secret);
        } catch (err) {
          console.warn('[OperatorVideoOverlay] mother repoint failed:', err);
        }
      }
      // Look up game_uniqid + game_type from the launched_game so we know
      // which scenario to resolve videos against. One-shot fetch - the
      // game's identity doesn't change after creation.
      let gameUniqid = '';
      let gameType = '';
      try {
        const state = await getLaunchedGameState(gid, 0);
        gameUniqid = state.game_uniqid;
        gameType = state.game_type;
      } catch (err) {
        console.warn('[OperatorVideoOverlay] state fetch failed:', err);
        return { ok: false, error: 'game_unreachable' };
      }
      const resolved = await resolveVideosByKind(kinds, gameUniqid, gameType, language);
      if (cancelled) return { ok: false, error: 'unmounted' };
      if (resolved.length === 0) {
        console.warn('[OperatorVideoOverlay] no playable assets for kinds', kinds);
        return { ok: false, error: 'no_videos' };
      }
      // Preempt any in-progress playback by replacing the source list
      // wholesale once the screen is quiet. FirstBipVideoOverlay's keyed
      // <video> remount on index/source change handles the transition.
      void startVideosDeferred(applySubtitleChoice(resolved, subtitleChoice));
      return { ok: true };
    });

    return () => {
      cancelled = true;
      offStop();
      offPlay();
    };
  }, [startVideosDeferred, stopVideos]);

  // Local-trigger path: the in-game panel's "Play Video" button skips the
  // pending_commands queue and emits directly on `localVideoStore`. Same
  // overlay state machine - preempts and stops work identically.
  useEffect(() => {
    return onLocalVideoCommand({
      onPlay: (resolved) => {
        void startVideosDeferred(resolved);
      },
      onStop: () => stopVideos(),
    });
  }, [startVideosDeferred, stopVideos]);

  // Report "showing a video" to paired mothers while an operator video is
  // actually playing, so the Devices modal pill reflects it (overlay wins over
  // the in_game base beneath it). Cleared when playback stops/completes.
  useEffect(() => {
    if (!videos) return;
    pushOverlay('video');
    return () => popOverlay('video');
  }, [videos]);

  // Escape-to-quit: only active when the overlay is mounted, and only for
  // operator-driven playback. The player-facing first-bip flow keeps its
  // 4-tap admin gesture (rendered by FirstBipVideoOverlay) because the
  // listener below lives on the operator-overlay wrapper, not the renderer.
  useEffect(() => {
    if (!videos) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setVideos(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [videos]);

  if (!videos) return null;

  return (
    <FirstBipVideoOverlay
      videos={videos}
      onComplete={() => setVideos(null)}
    />
  );
}
