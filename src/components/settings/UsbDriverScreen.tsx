// Settings → Developer → USB driver. The SportIdent reader connects as a
// USB-serial device and needs a vendor driver installed. Recent Windows
// builds block outdated/unsigned serial drivers ("This driver has been
// blocked … does not pass the Windows driver policy"), which leaves the
// reader undetected. This screen points operators at the current signed
// SportIdent USB driver package.

import { useState } from 'react';
import { HardDriveDownload, ExternalLink, Loader2 } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';

const DRIVER_URL = 'https://sportident.fr/produit/usb-driver/';

export function UsbDriverScreen() {
  const [opening, setOpening] = useState(false);

  const openDriverPage = async () => {
    setOpening(true);
    try {
      await openUrl(DRIVER_URL);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-slate-800/50 rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <HardDriveDownload className="text-blue-400" size={24} />
          <div>
            <h2 className="text-xl font-semibold">SportIdent USB driver</h2>
            <p className="text-sm text-slate-400">
              Required for the reader to be detected.
            </p>
          </div>
        </div>

        <p className="text-sm text-slate-300 mb-4">
          The SportIdent reader connects as a USB-serial device and needs the
          SportIdent USB driver installed. If the reader isn't detected — or
          Windows reports that the driver was{' '}
          <span className="text-slate-200 font-medium">blocked</span> because it
          "does not pass the Windows driver policy" — install the current
          signed driver from the link below.
        </p>

        <button
          onClick={openDriverPage}
          disabled={opening}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors disabled:opacity-60"
        >
          {opening ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <ExternalLink size={16} />
          )}
          Download SportIdent USB driver
        </button>

        <p className="text-xs text-slate-500 mt-3 font-mono break-all">
          {DRIVER_URL}
        </p>

        <p className="text-xs text-slate-400 mt-4">
          After installing, unplug and replug the reader, then check the{' '}
          <span className="text-slate-300">Hardware</span> tab — the reader
          status should turn green.
        </p>
      </div>
    </div>
  );
}
