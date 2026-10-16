import { useEffect, useState } from 'react';

// Subtitle tracks live on disk and reach the webview through Tauri's asset
// protocol (`http(s)://asset.localhost/...`), which is a DIFFERENT origin from
// the app page. A <track> is CORS-gated: without `crossorigin` on the <video>
// the browser refuses a cross-origin track silently - the language shows up in
// the picker (the <track> element exists) but no cue is ever rendered. Scenario
// tracks are also stored as content-hash blobs with no `.vtt` extension, so the
// served MIME type is not `text/vtt` either.
//
// So: fetch each track's text ourselves and hand the <video> a same-origin
// `blob:` URL typed `text/vtt`. SRT files uploaded by mistake are converted on
// the way (header + `,` → `.` in timestamps). A track that can't be fetched
// keeps its original URL (no worse than before).

function toWebVtt(raw: string): string {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (/^WEBVTT/.test(text)) return text;
  // SRT → VTT: timestamps use a comma before the milliseconds.
  const body = text.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
    '$1.$2',
  );
  return `WEBVTT\n\n${body}`;
}

export function useSubtitleBlobUrls(subtitles: Record<string, string>): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  // Stable dependency: the map's content, not its identity.
  const key = JSON.stringify(Object.entries(subtitles).sort(([a], [b]) => a.localeCompare(b)));

  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    setUrls({});

    void (async () => {
      const out: Record<string, string> = {};
      for (const [lang, src] of Object.entries(subtitles)) {
        try {
          const res = await fetch(src);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blobUrl = URL.createObjectURL(
            new Blob([toWebVtt(await res.text())], { type: 'text/vtt' }),
          );
          created.push(blobUrl);
          out[lang] = blobUrl;
        } catch (err) {
          console.warn(`[subtitles] could not load ${lang} track, using raw URL:`, err);
          out[lang] = src;
        }
      }
      // Unmounted / tracks changed mid-fetch: the cleanup already ran, so
      // release what was created after it.
      if (cancelled) created.forEach((u) => URL.revokeObjectURL(u));
      else setUrls(out);
    })();

    return () => {
      cancelled = true;
      for (const u of created) URL.revokeObjectURL(u);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return urls;
}
