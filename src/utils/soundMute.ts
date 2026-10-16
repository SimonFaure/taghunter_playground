import { useSyncExternalStore } from 'react';

// App-wide sound mute, toggled with Ctrl+M (or the top-bar icon while muted).
//
// Sound comes from many places (Mystery/Tracks/Quest/Clash `new Audio()`
// objects that are never in the DOM, intro/tutorial/bip videos, operator
// videos...), so instead of threading a flag through each of them this mutes
// at the HTMLMediaElement level:
//   - `play()` is patched, which catches detached `new Audio()` objects;
//   - a capture-phase `play` listener on the document catches in-DOM media
//     started by the `autoplay` attribute (no `play()` call);
//   - a per-element `volumechange` listener re-mutes media the app unmutes
//     while the global mute is on (e.g. a React `muted` prop update).
// Only media WE muted are unmuted again, so a video the app muted on purpose
// (FirstBipVideoOverlay's muted-autoplay fallback) stays muted.
//
// The state lives in localStorage so every window (projector, rankings...)
// follows it through the `storage` event. It is NOT kept across app restarts:
// the main window resets it at boot, so a device never starts a later event
// silently without anyone knowing why.

const STORAGE_KEY = 'taghunter_sound_muted';
export const SOUND_MUTE_EVENT = 'sound-mute:changed';

export interface SoundMuteEventDetail {
  muted: boolean;
  /** True when toggled in THIS window (shows the notice here only). */
  local: boolean;
}

let muted = false;
const mutedByUs = new WeakSet<HTMLMediaElement>();
const watched = new WeakSet<HTMLMediaElement>();
// Media currently playing, including detached `new Audio()` objects that a
// DOM query can't find when the mute is toggled mid-playback.
const playing = new Set<HTMLMediaElement>();

function sync(el: HTMLMediaElement): void {
  if (muted) {
    if (!el.muted) {
      mutedByUs.add(el);
      el.muted = true;
    }
  } else if (mutedByUs.has(el)) {
    mutedByUs.delete(el);
    el.muted = false;
  }
}

function watch(el: HTMLMediaElement): void {
  if (watched.has(el)) return;
  watched.add(el);
  el.addEventListener('volumechange', () => sync(el));
  el.addEventListener('play', () => playing.add(el));
  const stop = () => playing.delete(el);
  el.addEventListener('pause', stop);
  el.addEventListener('ended', stop);
  el.addEventListener('emptied', stop);
}

function syncAll(): void {
  for (const el of playing) sync(el);
  document.querySelectorAll<HTMLMediaElement>('audio, video').forEach(sync);
}

const listeners = new Set<() => void>();

function apply(next: boolean, local: boolean): void {
  if (next === muted) return;
  muted = next;
  syncAll();
  listeners.forEach((l) => l());
  window.dispatchEvent(
    new CustomEvent<SoundMuteEventDetail>(SOUND_MUTE_EVENT, { detail: { muted, local } }),
  );
}

export function isSoundMuted(): boolean {
  return muted;
}

export function setSoundMuted(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    /* localStorage unavailable - this window still mutes */
  }
  apply(next, true);
}

export function toggleSoundMuted(): void {
  setSoundMuted(!muted);
}

export function useSoundMuted(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    isSoundMuted,
  );
}

let installed = false;

/** Install once per window, before the app renders. `resetOnBoot`: main window only. */
export function installSoundMute({ resetOnBoot }: { resetOnBoot: boolean }): void {
  if (installed) return;
  installed = true;

  try {
    if (resetOnBoot) localStorage.setItem(STORAGE_KEY, '0');
    else muted = localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    /* ignore */
  }

  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    watch(this);
    // Before play(): muting first also keeps autoplay allowed.
    sync(this);
    return nativePlay.call(this);
  };

  document.addEventListener(
    'play',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLMediaElement)) return;
      watch(el);
      playing.add(el);
      sync(el);
    },
    true,
  );

  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) apply(e.newValue === '1', false);
  });

  // Ctrl+M. `e.key` follows the keyboard layout, so it is the key labelled M
  // on AZERTY too.
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || e.repeat) return;
    if (e.key?.toLowerCase() !== 'm') return;
    e.preventDefault();
    toggleSoundMuted();
  });
}
