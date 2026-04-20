import { AlertCircle, CheckCircle, X } from 'lucide-react';
import { useEffect } from 'react';

interface AlertProps {
  type: 'success' | 'error';
  message: string;
  onClose: () => void;
}

export function Alert({ type, message, onClose }: AlertProps) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, 5000);

    return () => clearTimeout(timer);
  }, [onClose]);

  const isSuccess = type === 'success';

  return (
    <div className="fixed top-4 right-4 z-50 animate-slide-in">
      <div
        className={`rounded-lg shadow-lg border backdrop-blur-sm p-4 pr-12 min-w-[320px] max-w-md ${
          isSuccess
            ? 'bg-green-900/90 border-green-700 text-green-100'
            : 'bg-red-900/90 border-red-700 text-red-100'
        }`}
      >
        <div className="flex items-start gap-3">
          {isSuccess ? (
            <CheckCircle className="flex-shrink-0 mt-0.5" size={20} />
          ) : (
            <AlertCircle className="flex-shrink-0 mt-0.5" size={20} />
          )}
          <div className="flex-1">
            <h4 className="font-semibold mb-1">
              {isSuccess ? 'Success' : 'Error'}
            </h4>
            <p className="text-sm opacity-90">{message}</p>
          </div>
          <button
            onClick={onClose}
            className="absolute top-4 right-4 hover:opacity-70 transition"
          >
            <X size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
