// In-game "Play Video" quick-access modal — plays on THIS device (the
// operator's own screen), not satellites. Satellite-targeted playback lives
// in the Devices modal's action bar.
//
// Resolve a video kind locally via `resolveVideosByKind` (same helper the
// first-bip flow uses), then push onto `localVideoStore` so the App-root
// <OperatorVideoOverlay> picks it up and mounts the FirstBipVideoOverlay
// presentation on top of whatever's currently showing.

import { useState } from 'react';
import { Film, Play, StopCircle, Loader2, X } from 'lucide-react';
import { resolveVideosByKind } from '../services/videoResolution';
import { emitLocalPlayVideo, emitLocalStopVideo } from '../services/localVideoStore';

interface VideoControlModalProps {
  gameUniqid: string;
  gameType: string;
  gameLanguage: string;
  hasIntro?: boolean;
  hasTutorial?: boolean;
  onClose: () => void;
}

export function VideoControlModal({
  gameUniqid,
  gameType,
  gameLanguage,
  hasIntro = true,
  hasTutorial = true,
  onClose,
}: VideoControlModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function play(kinds: Array<'intro' | 'tutorial'>) {
    setBusy(true);
    setError(null);
    try {
      const videos = await resolveVideosByKind(kinds, gameUniqid, gameType, gameLanguage);
      if (videos.length === 0) {
        setError(`No ${kinds.join(' / ')} video available for this scenario.`);
        return;
      }
      emitLocalPlayVideo(videos);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function stop() {
    emitLocalStopVideo();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[130] p-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-800 border-2 border-slate-700 rounded-lg p-6 max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <Film size={22} className="text-purple-400" />
            Play video
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1"
            aria-label="Close"
          >
            <X size={22} />
          </button>
        </div>

        <p className="text-sm text-slate-400 mb-4">
          Pick a video to play on <span className="text-slate-200 font-medium">this device</span>.
          (To send to satellites, use the Devices modal.)
        </p>

        <div className="grid grid-cols-1 gap-2">
          <ActionButton
            label="Intro"
            color="blue"
            disabled={!hasIntro || busy}
            onClick={() => play(['intro'])}
            icon={<Play size={16} />}
          />
          <ActionButton
            label="Tutorial"
            color="blue"
            disabled={!hasTutorial || busy}
            onClick={() => play(['tutorial'])}
            icon={<Play size={16} />}
          />
          <ActionButton
            label="Intro + Tutorial"
            color="blue"
            disabled={!hasIntro || !hasTutorial || busy}
            onClick={() => play(['intro', 'tutorial'])}
            icon={<Play size={16} />}
          />
          <ActionButton
            label="Stop video"
            color="orange"
            disabled={busy}
            onClick={stop}
            icon={<StopCircle size={16} />}
          />
        </div>

        {busy && (
          <div className="text-xs text-slate-400 flex items-center gap-1.5 justify-center mt-3">
            <Loader2 size={12} className="animate-spin" />
            Resolving…
          </div>
        )}
        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 rounded px-3 py-2 mt-3">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  color,
  disabled,
  onClick,
  icon,
}: {
  label: string;
  color: 'blue' | 'orange';
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  const base =
    color === 'blue'
      ? 'bg-blue-600 hover:bg-blue-500'
      : 'bg-orange-600 hover:bg-orange-500';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center justify-center gap-2 px-4 py-3 ${base} disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg text-sm font-medium`}
    >
      {icon}
      {label}
    </button>
  );
}
