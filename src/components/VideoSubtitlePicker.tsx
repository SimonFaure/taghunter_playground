// Subtitle-language picker shared by every "play a video" surface: the
// launched-card <GameVideoModal>, the in-game Devices modal's video bar and the
// in-game <VideoControlModal>. The pick rides along with the play command (or
// the local play) and overrides each device's own subtitle default.

import { useTranslation } from 'react-i18next';
import { Subtitles } from 'lucide-react';
import { LANG_NAMES } from '../services/langFlags';
import { SUBTITLE_AUTO } from '../services/videoResolution';

export function VideoSubtitlePicker({
  langs,
  value,
  onChange,
  singleDevice = false,
  perDevice = false,
  label,
  className = '',
}: {
  // Languages the game's videos declare. Nothing renders when there are none.
  langs: string[];
  value: string;
  onChange: (next: string) => void;
  // The video only plays on this device (wording of the "default" option).
  singleDevice?: boolean;
  // Compact variant sitting on one device's row of a roster: icon + select,
  // the label only as a tooltip.
  perDevice?: boolean;
  // Overrides the "Subtitles" label.
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  if (langs.length === 0) return null;
  const text = label ?? t('devicesModal:subtitlesLabel');
  return (
    <label
      className={`flex items-center gap-2 text-sm text-[var(--pg-text-muted)] ${className}`}
      title={perDevice ? t('devicesModal:subtitlesDeviceTitle') : undefined}
    >
      <Subtitles size={16} className="shrink-0" />
      {!perDevice && text}
      <select
        className="pg-select"
        value={value}
        aria-label={perDevice ? t('devicesModal:subtitlesDeviceTitle') : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value={SUBTITLE_AUTO}>
          {perDevice
            ? t('devicesModal:subtitlesAutoShort')
            : singleDevice
              ? t('devicesModal:subtitlesAutoThisDevice')
              : t('devicesModal:subtitlesAuto')}
        </option>
        <option value="off">{t('devicesModal:subtitlesOff')}</option>
        {langs.map((lang) => (
          <option key={lang} value={lang}>{LANG_NAMES[lang] || lang}</option>
        ))}
      </select>
    </label>
  );
}
