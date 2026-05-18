// SportIdent service — sole entrypoint to the SI card reader. Delegates
// the protocol entirely to the Rust side (src-tauri/src/sportident).
//
// Replaces the legacy ./usbReader.ts (deleted at step 7 of the rewrite —
// see plans/let-s-work-on-the-flickering-leaf.md). The type definitions
// below are deliberately structurally identical to the legacy
// CardData/StationData/USBPort interfaces so consumers' typed callbacks
// kept working through the cutover with only an import-line change.
//
// Public surface:
//   - isAvailable() / getAvailablePorts() / closePort() / initializePort(path)
//   - setCardDetectedCallback / setCardRemovedCallback / setStationsDetectedCallback
//   - start() / stop()
//   - isReaderConnected() — fast "is a SI dongle plugged in?" probe
//
// Key behavioural notes (all improvements over the legacy path):
//   - No more `console.log` monkey-patching to extract card data. The
//     Rust reader publishes typed `si://card-read` events; we just
//     listen.
//   - `setCardRemovedCallback` is an explicit no-op. The SI extended
//     protocol has no "card removed" frame — the legacy code's removal
//     detection was a buggy heuristic that consumed the *next* card's
//     bytes (root cause #4 in the rewrite plan). UI code that needs
//     auto-dismissal uses its own setTimeout.
//   - `start()` is a no-op. The legacy split between `initializePort`
//     (open) and `start` (begin reading) collapses into a single
//     `si_start` Tauri command. We keep both methods so consumers
//     don't have to branch.

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

// ─── Public types (single source of truth post-step-7) ──────────────

export interface USBPort {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
}

export type SICardType = 'SI8' | 'SI9' | 'SI10' | 'SI11';

export interface CardData {
  id: number;
  /**
   * Numeric series byte from the SI manual (SI9=1, SI8=2, SI10/11=4,
   * SIAC=8). Mapped from the Rust-side `cardType` string for
   * backwards-compat with consumers that switch on numeric values.
   * New code should prefer `cardType` which disambiguates SI10 vs SI11.
   */
  series: number;
  /**
   * Precise card family from the Rust side. Use this in new code; the
   * legacy `series` number lumps SI10 and SI11 together.
   */
  cardType: SICardType;
  start?: { code: number; time: string };
  /** Legacy name for "finish" punch — kept to avoid touching consumers. */
  end?: { code: number; time: string };
  check?: { code: number; time: string };
  nbPunch: number;
  punches: Array<{ code: number; time: string }>;
}

export interface StationData {
  stationNumber: number;
  stationMode: number;
  extended: boolean;
  handShake: boolean;
  autoSend: boolean;
  /** `false` for USB dongles; numeric for radio-relay setups (not yet supported). */
  radioChannel: boolean | number;
}

// ─── Tauri event payload shapes (camelCase, from Rust serde) ────────

interface PortPayload {
  deviceId: string;
  label: string;
  vendorId?: string; // already hex-encoded by the Rust side
  productId?: string;
  manufacturer?: string;
}

interface PunchPayload {
  code: number;
  time: string; // "HH:MM:SS"
}

interface CardPayload {
  cardId: number;
  cardType: 'SI8' | 'SI9' | 'SI10' | 'SI11';
  start?: PunchPayload;
  finish?: PunchPayload;
  check?: PunchPayload;
  punches: PunchPayload[];
}

interface StationPayload {
  stationNumber: number;
  mode: number;
  extended: boolean;
  autoSend: boolean;
  handshake: boolean;
}

interface ErrorPayload {
  message: string;
}

// Same window the legacy reader uses, kept TS-side so we can tune it
// per consumer without restarting the Rust task. Lock-in for now.
const CARD_DEBOUNCE_MS = 5000;

/**
 * Card-type string → numeric `series` byte. Legacy callers (e.g.
 * MysteryGamePage) compare against numeric values from the SI manual
 * (SI9=1, SI8=2, SI10/11=4, SIAC=8). Mapping it here keeps the
 * existing TS untouched.
 */
const SERIES_BY_TYPE: Record<CardPayload['cardType'], number> = {
  SI9: 1,
  SI8: 2,
  SI10: 4,
  SI11: 4,
};

class SportIdentService {
  private unlisteners: UnlistenFn[] = [];
  private isStarted = false;
  private currentPort: string | null = null;
  private onCardDetected?: (card: CardData) => void;
  private onStationsDetected?: (stations: StationData[]) => void;
  /**
   * Per-card-id last-seen-at timestamps. Same card scanned within
   * `CARD_DEBOUNCE_MS` is silently coalesced — matches the legacy
   * behaviour where a child tapping their card three times in a row
   * was treated as one read.
   */
  private lastCardTimestamps = new Map<number, number>();
  /**
   * Accumulated station info. We keep one entry per station_number so
   * a multi-station setup eventually populates them all. The legacy
   * callback expected a `StationData[]` and replaced the whole list
   * each fire, so we publish `Array.from(map.values())`.
   */
  private stations = new Map<number, StationData>();

  /** True when running inside the Tauri shell (desktop or mobile). */
  isAvailable(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  async getAvailablePorts(): Promise<USBPort[]> {
    if (!this.isAvailable()) return [];
    try {
      const ports = await invoke<PortPayload[]>('si_list_ports');
      return ports.map(p => ({
        path: p.deviceId,
        manufacturer: p.manufacturer,
        vendorId: p.vendorId,
        productId: p.productId,
      }));
    } catch (err) {
      console.error('[si] si_list_ports failed:', err);
      return [];
    }
  }

  /** Alias for stop(); legacy API parity. */
  async closePort(): Promise<void> {
    return this.stop();
  }

  /**
   * Opens the port AND starts the reader in one shot — the Rust
   * `si_start` command does both. Returns true on success, false on
   * any failure (port not openable, reader already running, transport
   * error). On failure, listeners are detached and state is reset so
   * the next call can re-attempt cleanly.
   */
  async initializePort(portPath: string): Promise<boolean> {
    if (!this.isAvailable()) {
      console.warn('[si] not running in Tauri shell');
      return false;
    }
    if (this.isStarted && this.currentPort === portPath) return true;
    if (this.isStarted) await this.stop();

    try {
      await this.attachListeners();
      await invoke('si_start', { deviceId: portPath });
      this.isStarted = true;
      this.currentPort = portPath;
      return true;
    } catch (err) {
      console.error('[si] si_start failed:', err);
      await this.detachListeners();
      this.isStarted = false;
      this.currentPort = null;
      return false;
    }
  }

  setCardDetectedCallback(callback: (card: CardData) => void) {
    this.onCardDetected = callback;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setCardRemovedCallback(_callback: () => void) {
    // Intentional no-op. See file-top docstring: the SI extended
    // protocol has no "card removed" frame, so there's no signal to
    // fire on. Consumers that need a dismiss timer should use their
    // own setTimeout (as MysteryGamePage already does).
  }

  setStationsDetectedCallback(callback: (stations: StationData[]) => void) {
    this.onStationsDetected = callback;
  }

  /**
   * No-op. The legacy `start()` was where the reader actually began
   * its read loop after `initializePort` set up the serial state. Our
   * Rust path collapses both into `si_start`. We keep the method so
   * callers don't have to branch.
   */
  async start(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    if (!this.isAvailable()) return;
    await this.detachListeners();
    // Reset JS-side state BEFORE awaiting si_stop. Game-page cleanup
    // calls stop() fire-and-forget; if the user immediately navigates
    // to settings and clicks "Start test", `initializePort` peeks at
    // `isStarted`/`currentPort` to decide whether to no-op. Resetting
    // optimistically means the concurrent caller sees the "stopped"
    // world right away and proceeds to a fresh si_start, which Tauri
    // serializes after our pending si_stop via the SportIdentState
    // mutex on the Rust side (see si_stop in sportident/mod.rs).
    const wasStarted = this.isStarted;
    this.isStarted = false;
    this.currentPort = null;
    this.lastCardTimestamps.clear();
    this.stations.clear();
    if (wasStarted) {
      try {
        await invoke('si_stop');
      } catch (err) {
        console.warn('[si] si_stop warn:', err);
      }
    }
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async attachListeners() {
    // Defensive — in normal flow the listener list is already empty.
    await this.detachListeners();

    this.unlisteners.push(
      await listen<CardPayload>('si://card-read', e => {
        const card = this.toLegacyCard(e.payload);
        const now = Date.now();
        const last = this.lastCardTimestamps.get(card.id) ?? 0;
        if (now - last < CARD_DEBOUNCE_MS) {
          // Same card within debounce → silently coalesce.
          return;
        }
        this.lastCardTimestamps.set(card.id, now);
        this.onCardDetected?.(card);
      }),
    );

    this.unlisteners.push(
      await listen<StationPayload>('si://station-detected', e => {
        const station = this.toLegacyStation(e.payload);
        this.stations.set(station.stationNumber, station);
        this.onStationsDetected?.(Array.from(this.stations.values()));
      }),
    );

    this.unlisteners.push(
      await listen<ErrorPayload>('si://error', e => {
        // Error events are logged; the UI's existing setTimeout-based
        // dismissal handles user feedback. We could surface these via
        // a dedicated callback in a future iteration if the dashboard
        // wants to show them.
        console.warn('[si] reader error:', e.payload.message);
      }),
    );
  }

  private async detachListeners() {
    for (const off of this.unlisteners) {
      try {
        off();
      } catch {
        // listen() returns an unlisten fn that throws if already
        // detached. Safe to ignore.
      }
    }
    this.unlisteners = [];
  }

  private toLegacyCard(p: CardPayload): CardData {
    return {
      id: p.cardId,
      series: SERIES_BY_TYPE[p.cardType] ?? 0,
      cardType: p.cardType,
      start: p.start && { code: p.start.code, time: p.start.time },
      end: p.finish && { code: p.finish.code, time: p.finish.time },
      check: p.check && { code: p.check.code, time: p.check.time },
      nbPunch: p.punches.length,
      punches: p.punches.map(x => ({ code: x.code, time: x.time })),
    };
  }

  private toLegacyStation(p: StationPayload): StationData {
    return {
      stationNumber: p.stationNumber,
      stationMode: p.mode,
      extended: p.extended,
      handShake: p.handshake,
      autoSend: p.autoSend,
      // Not surfaced by the new payload — legacy default was `false`
      // for USB dongles and a number for radio relay setups. Keeping
      // `false` matches the dongle path which is the only one in
      // production right now.
      radioChannel: false,
    };
  }
}

export const sportidentService = new SportIdentService();

// ─── isReaderConnected: fast "is a dongle plugged in?" probe ───────
//
// Footer.tsx polls this every 10 s for its green/red status dot. Lives
// here rather than as a `SportIdentService` method because it
// deliberately doesn't open the port — just enumerates and looks for the
// SI BSF7/BSF8/BSM8 USB descriptor.

/** SiLabs CP210x USB-to-UART bridge with SportIdent's custom PID, used
 *  by SI BSF7-USB / BSF8 / BSM8 readers. */
export const SPORTIDENT_VID = '10c4';
export const SPORTIDENT_PID = '800a';

export async function isReaderConnected(): Promise<boolean> {
  return (await detectReaderPort()) !== null;
}

// Returns the path of the first port matching the SportIdent reader's
// VID/PID, or null when no reader is plugged in (or the platform doesn't
// expose serial ports). Multi-reader case: picks the first match; users
// realistically only have one dongle, and the dispatch is single-port.
export async function detectReaderPort(): Promise<USBPort | null> {
  if (!sportidentService.isAvailable()) return null;
  try {
    const ports = await sportidentService.getAvailablePorts();
    return (
      ports.find(
        (p) => p.vendorId === SPORTIDENT_VID && p.productId === SPORTIDENT_PID,
      ) ?? null
    );
  } catch {
    return null;
  }
}
