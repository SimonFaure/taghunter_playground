// React hook that exposes the auto-detected SportIdent reader port.
//
// The actual detection happens in services/sportidentService.detectReaderPort
// (filters available ports by VID 10c4 / PID 800a). This hook just wires
// detection to the React rendering lifecycle:
//
//   - Initial detection on mount.
//   - Re-detection on the 'reader:status' window event that Footer.tsx emits
//     when its 10s isReaderConnected poll flips state. That gives every
//     consumer (game pages, ConfigurationPage, LaunchGameModal) a unified
//     hotplug signal without needing each of them to run its own poll.
//
// Returns:
//   - port: the COM/tty path of the detected reader, or null if not detected
//     yet OR not plugged in.
//   - isPresent: convenience boolean (port !== null).
//   - refresh(): forces an immediate redetection, for the manual Refresh
//     button on the hardware tab.

import { useCallback, useEffect, useState } from 'react';
import { detectReaderPort, USBPort } from './sportidentService';

export interface DetectedReader {
  port: string | null;
  detail: USBPort | null;
  isPresent: boolean;
  refresh: () => void;
}

export function useDetectedReaderPort(): DetectedReader {
  const [detail, setDetail] = useState<USBPort | null>(null);

  const refresh = useCallback(() => {
    void (async () => {
      const found = await detectReaderPort();
      setDetail(found);
    })();
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener('reader:status', handler);
    return () => window.removeEventListener('reader:status', handler);
  }, [refresh]);

  return {
    port: detail?.path ?? null,
    detail,
    isPresent: detail !== null,
    refresh,
  };
}
