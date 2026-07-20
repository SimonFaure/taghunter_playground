import { CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CardData } from '../services/sportidentService';

interface CardDetectionAlertProps {
  cardData: CardData | null;
  show: boolean;
}

export function CardDetectionAlert({ cardData, show }: CardDetectionAlertProps) {
  const { t } = useTranslation();
  if (!show || !cardData) return null;

  return (
    <div className="fixed top-20 right-4 z-50 bg-green-600 text-white px-6 py-4 rounded-lg shadow-2xl animate-slide-in-right flex items-center gap-3">
      <CheckCircle2 size={24} className="flex-shrink-0" />
      <div>
        <div className="font-bold">{t('operatorControls:cardDetection.detected')}</div>
        <div className="text-sm">{t('operatorControls:cardDetection.id', { id: cardData.id })}</div>
        <div className="text-sm">{t('operatorControls:cardDetection.punches', { count: cardData.nbPunch })}</div>
      </div>
    </div>
  );
}
