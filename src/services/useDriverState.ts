// React hook that exposes the auto-detected CP210x driver state.
//
// Mirrors useDetectedReaderPort: runs detection on mount, re-runs on the
// 'reader:status' window event that Footer.tsx emits every 10s when its
// isReaderConnected poll flips. This way the USB driver screen and the
// Hardware tab both react to hotplug without each running its own poll.
//
// `recheck()` forces an immediate re-detection — useful after a manual
// driver install attempt completes, where we want the card to flip from
// blocked_by_policy → healthy without waiting for the next polling tick.

import { useCallback, useEffect, useState } from 'react';
import { checkDriverState, DriverState } from './cp210xDriver';

export interface DriverStateResult {
  state: DriverState;
  recheck: () => void;
}

export function useDriverState(): DriverStateResult {
  const [state, setState] = useState<DriverState>({ kind: 'unknown' });

  const recheck = useCallback(() => {
    void (async () => {
      const result = await checkDriverState();
      setState(result);
    })();
  }, []);

  useEffect(() => {
    recheck();
    const handler = () => recheck();
    window.addEventListener('reader:status', handler);
    return () => window.removeEventListener('reader:status', handler);
  }, [recheck]);

  return { state, recheck };
}
