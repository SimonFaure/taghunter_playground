import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume2, VolumeX } from 'lucide-react';
import { SOUND_MUTE_EVENT, type SoundMuteEventDetail } from '../utils/soundMute';

const VISIBLE_MS = 1800;

// Mounted once at the app root (main.tsx), like FullscreenHint, so the Ctrl+M
// feedback shows over game pages too, where the top bar is hidden. Only the
// window where the shortcut was pressed shows it.
export function SoundMuteNotice() {
  const { t } = useTranslation('soundMute');
  const [notice, setNotice] = useState<{ muted: boolean; key: number } | null>(null);

  useEffect(() => {
    const onChange = (e: Event) => {
      const { muted, local } = (e as CustomEvent<SoundMuteEventDetail>).detail;
      if (local) setNotice({ muted, key: Date.now() });
    };
    window.addEventListener(SOUND_MUTE_EVENT, onChange);
    return () => window.removeEventListener(SOUND_MUTE_EVENT, onChange);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), VISIBLE_MS);
    return () => window.clearTimeout(id);
  }, [notice]);

  if (!notice) return null;

  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[100] pointer-events-none">
      <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/80 text-white text-sm font-medium shadow-lg border border-white/10">
        {notice.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        {notice.muted ? t('muted') : t('unmuted')}
      </div>
    </div>
  );
}
