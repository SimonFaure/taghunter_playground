import { QRCodeSVG } from 'qrcode.react';
import { wifiQrPayload } from '../../services/lanCredentials';

/**
 * Renders a scannable Wi-Fi QR (standard `WIFI:` payload) for an SSID/password so a
 * team device's camera can join the network. Returns nothing until both fields are
 * present. Light card on purpose - phone cameras read black-on-white most reliably.
 */
export function WifiQr({
  ssid, password, caption,
}: {
  ssid: string; password: string; caption?: string;
}): JSX.Element | null {
  if (!ssid.trim() || !password.trim()) return null;
  return (
    <div className="inline-flex flex-col items-center gap-2 bg-white rounded-xl p-3">
      <QRCodeSVG value={wifiQrPayload(ssid, password)} size={148} level="M" />
      {caption && <span className="text-[11px] text-slate-600 max-w-[160px] text-center">{caption}</span>}
    </div>
  );
}
