import { useEffect, useState, type RefObject } from 'react';

// Draws subtitles OURSELVES instead of letting the webview render <track>s.
// Native rendering could show two tracks at once (a `default` track the
// browser auto-enables + the one we switched on, or the native CC menu), so
// every track is kept at 'hidden' (cues load, nothing is painted) or
// 'disabled', and the active cue text of the chosen language is returned for
// the caller to paint. Exactly one subtitle line can ever be on screen.
//
// `trackKey` must change whenever the <video> remounts or its <track>s change
// (new video, blob URLs resolved), so the listeners re-attach.
//
// `onNativeSelect` (players with native controls): the CC menu flips a track
// to 'showing' / 'disabled'; we report that pick and take rendering back.

function cueText(track: TextTrack | null): string {
  const cues = track?.activeCues;
  if (!cues) return '';
  const lines: string[] = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i] as VTTCue;
    // Strip VTT inline tags (<i>, <b>, <v Speaker>, <00:01.000>...).
    lines.push((c.text ?? '').replace(/<[^>]*>/g, ''));
  }
  return lines.join('\n');
}

export function useSubtitleCue(
  videoRef: RefObject<HTMLVideoElement | null>,
  lang: string | null,
  trackKey: string,
  onNativeSelect?: (lang: string | null) => void,
): string {
  const [text, setText] = useState('');

  useEffect(() => {
    setText('');
    const el = videoRef.current;
    if (!el) return;
    const tracks = el.textTracks;
    let selected: TextTrack | null = null;

    const update = () => setText(cueText(selected));

    const apply = () => {
      selected?.removeEventListener('cuechange', update);
      selected = null;
      for (let i = 0; i < tracks.length; i++) {
        const tr = tracks[i];
        const want = lang && tr.language === lang && !selected;
        if (want) selected = tr;
        const mode: TextTrackMode = want ? 'hidden' : 'disabled';
        if (tr.mode !== mode) tr.mode = mode;
      }
      selected?.addEventListener('cuechange', update);
      update();
    };

    const onChange = () => {
      for (let i = 0; i < tracks.length; i++) {
        const tr = tracks[i];
        if (tr.mode === 'showing') {
          tr.mode = 'hidden';
          if (onNativeSelect && tr.language !== lang) onNativeSelect(tr.language || null);
          else apply();
          return;
        }
      }
      if (selected && selected.mode === 'disabled') {
        if (onNativeSelect) onNativeSelect(null);
        else apply();
      }
    };

    apply();
    tracks.addEventListener('addtrack', apply);
    tracks.addEventListener('change', onChange);
    return () => {
      selected?.removeEventListener('cuechange', update);
      tracks.removeEventListener('addtrack', apply);
      tracks.removeEventListener('change', onChange);
    };
    // onNativeSelect is a setter-style callback; re-binding on its identity
    // would only churn listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef, lang, trackKey]);

  return text;
}
