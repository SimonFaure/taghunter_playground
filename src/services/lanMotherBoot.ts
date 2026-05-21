// Production boot path for the mother's local axum server.
//
// Until this module was added, the in-process LAN server only ever ran inside
// `lanSmokeTest.ts` — every production `launched_games` request went straight
// to studio.taghunter.fr. That made the new Devices-modal endpoints
// (`list_paired_with_status`, push commands, etc.) unreachable, since they
// only exist in the local axum.
//
// `ensureMotherServer` is idempotent: at first call after app boot it starts
// the server and installs a permanent LAN override for the `launched_games`
// endpoint so all launched-game traffic goes local. On subsequent calls (e.g.
// a React re-mount), it picks the running server up via `mother_get_server_info`
// without restarting it.
//
// Tradeoff to be explicit about: once the LAN override is installed, launched
// games created via the new flow live in the mother's SQLite, NOT in studio's
// MySQL. Cross-device persistence + studio dashboard visibility is a follow-up
// (cloud-sync, slice E of the LAN-mode roadmap).

import { invoke } from '@tauri-apps/api/core';
import { setLanOverride, getLanOverride } from './api';

interface MotherServerInfo {
  port: number;
  bound_addr: string;
  mother_device_uuid: string;
  mother_peer_secret: string;
  mother_peer_id: number;
}

let bootPromise: Promise<MotherServerInfo | null> | null = null;

export async function ensureMotherServer(
  clientId: number,
  mdnsLabel?: string
): Promise<MotherServerInfo | null> {
  // Coalesce concurrent callers onto one in-flight boot — React Strict-Mode
  // double-mounts and the AuthProvider's auth-resolution effect can both
  // hit this within a few ms of each other.
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    try {
      // Server may already be running (e.g. smoke test left it up, or this
      // is a React re-mount). Pick it up rather than restarting.
      const existing = await invoke<MotherServerInfo | null>('mother_get_server_info');
      const info = existing
        ?? (await invoke<MotherServerInfo>('mother_start_local_server', {
          clientId,
          port: 0, // 0 = OS picks; the command returns the actual port
          mdnsLabel: mdnsLabel ?? null,
        }));

      // Install the LAN override unless someone else (the smoke test) set one
      // we shouldn't stomp. The smoke test always restores `null` in its
      // finally block, so a non-null override here is almost certainly ours.
      const current = getLanOverride();
      if (!current || current.baseUrl.includes(`:${info.port}`) === false) {
        setLanOverride({
          baseUrl: `http://127.0.0.1:${info.port}`,
          token: info.mother_peer_secret,
          // Only launched_games is routed locally. Scenarios, patterns,
          // auth, etc. still go to studio.
          endpoints: new Set(['launched_games']),
        });
      }
      return info;
    } catch (err) {
      console.error('[lanMotherBoot] failed to start/locate mother server:', err);
      bootPromise = null; // allow retry on next caller
      return null;
    }
  })();

  return bootPromise;
}
