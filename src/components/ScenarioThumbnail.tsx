import { useEffect, useState } from 'react';
import { Map as MapIcon } from 'lucide-react';

interface ScenarioThumbnailProps {
  // A `scenario://` URL resolved from the downloaded scenario's media, or null
  // when the scenario isn't downloaded yet / has no cover art.
  imageUrl: string | null;
  gameTypeName: string;
  title: string;
}

// Scenario card cover image with a graceful fallback. When `imageUrl` is absent
// — the scenario hasn't finished syncing, or simply has no cover art — or the
// image fails to load (a downloaded file went missing/corrupt), a gradient +
// icon placeholder is shown so the card never renders a broken-image icon.
//
// Must be rendered inside an element with the `group` class for the
// hover-zoom transition to fire.
export function ScenarioThumbnail({ imageUrl, gameTypeName, title }: ScenarioThumbnailProps) {
  const [errored, setErrored] = useState(false);

  // Clear the error flag whenever the URL changes — e.g. a sync cycle just
  // downloaded the scenario and a real cover URL replaced the previous null.
  useEffect(() => {
    setErrored(false);
  }, [imageUrl]);

  if (imageUrl && !errored) {
    return (
      <img
        src={imageUrl}
        alt={title}
        onError={() => setErrored(true)}
        className="w-full h-full object-cover group-hover:scale-110 transition duration-300"
      />
    );
  }

  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-slate-700 via-slate-800 to-slate-900">
      <MapIcon size={40} className="text-slate-500" />
      <span className="text-slate-500 text-sm font-medium">{gameTypeName}</span>
    </div>
  );
}
