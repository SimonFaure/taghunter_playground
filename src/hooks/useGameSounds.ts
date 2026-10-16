import { useCallback, useEffect, useRef } from 'react';

// Sound playback owned by an in-game page. Every sound the page starts is
// tracked, and leaving the page (quit, or the game switching to the rankings)
// pauses them all. Plays requested AFTER the page is gone are dropped: the
// reveal walks (Mystery enigmas, Tracks checkpoints) are async loops that keep
// running to their end once unmounted, and used to keep the room hearing
// sounds for a screen nobody sees any more.

export function useGameSounds() {
  const mountedRef = useRef(true);
  const playingRef = useRef<Set<HTMLAudioElement>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    const playing = playingRef.current;
    return () => {
      mountedRef.current = false;
      for (const audio of playing) audio.pause();
      playing.clear();
    };
  }, []);

  /** Play `audio` from its start. No-op once the page has unmounted. */
  const playAudio = useCallback((audio: HTMLAudioElement | null | undefined): Promise<void> => {
    if (!audio || !mountedRef.current) return Promise.resolve();
    const playing = playingRef.current;
    playing.add(audio);
    audio.addEventListener('ended', () => playing.delete(audio), { once: true });
    audio.currentTime = 0;
    return audio.play();
  }, []);

  return playAudio;
}
