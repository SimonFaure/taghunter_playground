import { useTranslation } from 'react-i18next';
import { DevicePicker } from './DevicePicker';
import { queueOpenRankingPageBulk } from '../services/launchedGames';
import type { RankingTarget } from '../services/rankingTarget';
import { encodeRankingTarget } from '../services/rankingTarget';

interface RankingDevicePickerProps {
  target: RankingTarget;
  onClose: () => void;
  /** Called after the open_ranking command(s) are queued. */
  onSent: (count: number) => void;
}

/** Push a ranking page to paired device(s) - a thin wrapper over the generic
 *  {@link DevicePicker} that sends the `open_ranking` command. */
export function RankingDevicePicker({ target, onClose, onSent }: RankingDevicePickerProps) {
  const { t } = useTranslation();
  return (
    <DevicePicker
      title={t('launched:rankDevicePickTitle')}
      hint={t('launched:rankDevicePickHint')}
      sendLabel={t('launched:rankDeviceSend')}
      emptyLabel={t('launched:rankDeviceNone')}
      onSend={(ids) => queueOpenRankingPageBulk(ids, encodeRankingTarget(target)).then(() => undefined)}
      onClose={onClose}
      onSent={onSent}
    />
  );
}
