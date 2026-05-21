// Satellite-side overlay that the mother can drive via `play_video` /
// `stop_video` commands. Mounted once at the App root so it can preempt
// any other UI when a command lands. Uses the existing FirstBipVideoOverlay
// for rendering — the only delta is the trigger source (operator vs. local
// first-bip) and the absence of a state-mutating callback when playback ends.

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { FirstBipVideoOverlay } from './FirstBipVideoOverlay';
import { resolveVideosByKind, type VideoSource } from '../services/videoResolution';
import { getLaunchedGameState } from '../services/launchedGames';
import { onLocalVideoCommand } from '../services/localVideoStore';

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

  useEffect(() => {
    let cancelled = false;
    let unlistenFn: (() => void) | null = null;

    void (async () => {
      const unlisten = await listen<LanCommand>('taghunter://lan-command', async (event) => {
        if (cancelled) return;
        const cmd = event.payload;
        if (cmd.kind === 'stop_video') {
          setVideos(null);
          return;
        }
        if (cmd.kind === 'play_video') {
          const gid = cmd.payload.launched_game_id;
          const kinds = cmd.payload.kinds ?? [];
          const language = cmd.payload.language ?? 'fr';
          if (!gid || kinds.length === 0) return;
          // Look up game_uniqid + game_type from the launched_game so we know
          // which scenario to resolve videos against. One-shot fetch — the
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
          // wholesale. FirstBipVideoOverlay's keyed <video> remount on
          // index/source change handles the transition cleanly.
          setVideos(resolved);
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
  }, []);

  // Local-trigger path: the in-game panel's "Play Video" button skips the
  // pending_commands queue and emits directly on `localVideoStore`. Same
  // overlay state machine — preempts and stops work identically.
  useEffect(() => {
    return onLocalVideoCommand({
      onPlay: (resolved) => {
        if (resolved.length > 0) setVideos(resolved);
      },
      onStop: () => setVideos(null),
    });
  }, []);

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
