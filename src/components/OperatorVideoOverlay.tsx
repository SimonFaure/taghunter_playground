// Satellite-side overlay that the mother can drive via `play_video` /
// `stop_video` commands. Mounted once at the App root so it can preempt
// any other UI when a command lands. Uses the existing FirstBipVideoOverlay
// for rendering - the only delta is the trigger source (operator vs. local
// first-bip) and the absence of a state-mutating callback when playback ends.

import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { FirstBipVideoOverlay } from './FirstBipVideoOverlay';
import { resolveVideosByKind, type VideoSource } from '../services/videoResolution';
import { getLaunchedGameState } from '../services/launchedGames';
import { onLocalVideoCommand } from '../services/localVideoStore';
import { pushOverlay, popOverlay } from '../services/screenState';
import { waitForPresentationIdle } from '../services/presentationGate';

interface LanCommand {
  id: number;
  kind: 'join_game' | 'play_video' | 'stop_video';
  payload: {
    launched_game_id?: number;
    kinds?: Array<'intro' | 'tutorial'>;
    language?: string;
  };
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
    let unlistenFn: (() => void) | null = null;

    void (async () => {
      const unlisten = await listen<LanCommand>('taghunter://lan-command', async (event) => {
        if (cancelled) return;
        const cmd = event.payload;
        if (cmd.kind === 'stop_video') {
          stopVideos();
          return;
        }
        if (cmd.kind === 'play_video') {
          const gid = cmd.payload.launched_game_id;
          const kinds = cmd.payload.kinds ?? [];
          const language = cmd.payload.language ?? 'fr';
          if (!gid || kinds.length === 0) return;
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
            return;
          }
          const resolved = await resolveVideosByKind(kinds, gameUniqid, gameType, language);
          if (cancelled) return;
          if (resolved.length === 0) {
            console.warn('[OperatorVideoOverlay] no playable assets for kinds', kinds);
            return;
          }
          // Preempt any in-progress playback by replacing the source list
          // wholesale once the screen is quiet. FirstBipVideoOverlay's keyed
          // <video> remount on index/source change handles the transition.
          void startVideosDeferred(resolved);
        }
      });
      if (cancelled) {
        unlisten();
      } else {
        unlistenFn = unlisten;
      }
    })();

    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
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
