// Module-level pub/sub for local operator-triggered video playback. Used by
// the in-game panel's "Play Video" button to drive <OperatorVideoOverlay>
// directly on the device the operator is on, without going through the
// pending_commands queue (which is for cross-device targeting).
//
// Symmetric design with the mother-driven taghunter://lan-command path:
// OperatorVideoOverlay listens to BOTH the Tauri event (satellite case) and
// this in-process store (local case), so there's a single overlay state
// machine no matter how the play was triggered.

import type { VideoSource } from './videoResolution';

interface LocalVideoListener {
  onPlay: (videos: VideoSource[]) => void;
  onStop: () => void;
}

const listeners = new Set<LocalVideoListener>();

export function onLocalVideoCommand(l: LocalVideoListener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function emitLocalPlayVideo(videos: VideoSource[]): void {
  for (const l of listeners) {
    try {
      l.onPlay(videos);
    } catch (err) {
      console.error('[localVideoStore] onPlay listener threw:', err);
    }
  }
}

export function emitLocalStopVideo(): void {
  for (const l of listeners) {
    try {
      l.onStop();
    } catch (err) {
      console.error('[localVideoStore] onStop listener threw:', err);
    }
  }
}
