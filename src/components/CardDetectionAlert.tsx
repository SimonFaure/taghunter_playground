import { CheckCircle2 } from 'lucide-react';
import { CardData } from '../services/usbReader';

interface CardDetectionAlertProps {
  cardData: CardData | null;
  show: boolean;
}

export function CardDetectionAlert({ cardData, show }: CardDetectionAlertProps) {
  if (!show || !cardData) return null;

  return (
    <div className="fixed top-20 right-4 z-50 bg-green-600 text-white px-6 py-4 rounded-lg shadow-2xl animate-slide-in-right flex items-center gap-3">
      <CheckCircle2 size={24} className="flex-shrink-0" />
      <div>
        <div className="font-bold">Card Detected</div>
        <div className="text-sm">ID: {cardData.id}</div>
        <div className="text-sm">Punches: {cardData.nbPunch}</div>
      </div>
    </div>
  );
}
