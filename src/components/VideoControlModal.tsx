// In-game "Play Video" quick-access modal - plays on THIS device (the
// operator's own screen), not satellites. Satellite-targeted playback lives
// in the Devices modal's action bar.
//
// Resolve a video kind locally via `resolveVideosByKind` (same helper the
// first-bip flow uses), then push onto `localVideoStore` so the App-root
// <OperatorVideoOverlay> picks it up and mounts the FirstBipVideoOverlay
// presentation on top of whatever's currently showing.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function play(kinds: Array<'intro' | 'tutorial'>) {
    setBusy(true);
    setError(null);
    try {
      const videos = await resolveVideosByKind(kinds, gameUniqid, gameType, gameLanguage);
      if (videos.length === 0) {
        setError(t('videoControl:noVideoAvailable', { kinds: kinds.join(' / ') }));
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
      className="pg-overlay z-[130]"
      onClick={onClose}
    >
      <div
        className="pg-modal max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pg-modal-head">
          <h3 className="pg-modal-title flex items-center gap-2">
            <Film size={22} className="text-purple-400" />
            {t('videoControl:playVideo')}
          </h3>
          <button
            onClick={onClose}
            className="pg-modal-close"
            aria-label={t('videoControl:close')}
          >
            <X size={22} />
          </button>
        </div>

        <div className="pg-modal-body">
        <p className="text-sm text-[var(--pg-text-dim)] mb-4">
          {t('videoControl:pickVideoPrefix')} <span className="text-[var(--pg-text-muted)] font-medium">{t('videoControl:thisDevice')}</span>{t('videoControl:pickVideoSuffix')}
        </p>

        <div className="grid grid-cols-1 gap-2">
          <ActionButton
            label={t('videoControl:intro')}
            color="blue"
            disabled={!hasIntro || busy}
            onClick={() => play(['intro'])}
            icon={<Play size={16} />}
          />
          <ActionButton
            label={t('videoControl:tutorial')}
            color="blue"
            disabled={!hasTutorial || busy}
            onClick={() => play(['tutorial'])}
            icon={<Play size={16} />}
          />
          <ActionButton
            label={t('videoControl:introTutorial')}
            color="blue"
            disabled={!hasIntro || !hasTutorial || busy}
            onClick={() => play(['intro', 'tutorial'])}
            icon={<Play size={16} />}
          />
          <ActionButton
            label={t('videoControl:stopVideo')}
            color="orange"
            disabled={busy}
            onClick={stop}
            icon={<StopCircle size={16} />}
          />
        </div>

        {busy && (
          <div className="text-xs text-[var(--pg-text-dim)] flex items-center gap-1.5 justify-center mt-3">
            <Loader2 size={12} className="animate-spin" />
            {t('videoControl:resolving')}
          </div>
        )}
        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 rounded px-3 py-2 mt-3">
            {error}
          </p>
        )}
        </div>
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
      ? 'bg-[var(--pg-accent)] hover:bg-[var(--pg-accent-hover)]'
      : 'bg-orange-600 hover:bg-orange-500';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center justify-center gap-2 px-4 py-3 ${base} disabled:bg-[var(--pg-surface-3)] disabled:text-[var(--pg-text-dim)] text-[var(--pg-text)] rounded-lg text-sm font-medium`}
    >
      {icon}
      {label}
    </button>
  );
}
