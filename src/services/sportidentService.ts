// SportIdent service - sole entrypoint to the SI card reader. Delegates
// the protocol entirely to the Rust side (src-tauri/src/sportident).
//
// Replaces the legacy ./usbReader.ts (deleted at step 7 of the rewrite -
// see plans/let-s-work-on-the-flickering-leaf.md). The type definitions
// below are deliberately structurally identical to the legacy
// CardData/StationData/USBPort interfaces so consumers' typed callbacks
// kept working through the cutover with only an import-line change.
//
// Public surface:
//   - isAvailable() / getAvailablePorts() / closePort() / initializePort(path)
//   - setCardDetectedCallback / setCardRemovedCallback / setStationsDetectedCallback
//   - start() / stop()
//   - isReaderConnected() - fast "is a SI dongle plugged in?" probe
//
// Key behavioural notes (all improvements over the legacy path):
//   - No more `console.log` monkey-patching to extract card data. The
//     Rust reader publishes typed `si://card-read` events; we just
//     listen.
//   - `setCardRemovedCallback` is an explicit no-op. The SI extended
//     protocol has no "card removed" frame - the legacy code's removal
//     detection was a buggy heuristic that consumed the *next* card's
//     bytes (root cause #4 in the rewrite plan). UI code that needs
//     auto-dismissal uses its own setTimeout.
//   - `start()` is a no-op. The legacy split between `initializePort`
//     (open) and `start` (begin reading) collapses into a single
//     `si_start` Tauri command. We keep both methods so consumers
//     don't have to branch.

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { isAndroid } from '../utils/platform';
import { gameClock } from './gameClock';

// ─── Public types (single source of truth post-step-7) ──────────────

export interface USBPort {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
}

export type SICardType = 'SI8' | 'SI9' | 'SI10' | 'SI11';

/**
 * How many punches each card family can physically hold. Mirrors the
 * `max_punches` column of `LAYOUTS` in `src-tauri/src/sportident/cards/layout.rs`,
 * which is the source of truth (the Rust parser refuses a readout claiming
 * more) - keep the two in step.
 *
 * A full card is not an error: the station simply stops writing to it, with
 * nothing but a beep to tell the player. Chaining several scenarios on one chip
 * without wiping is what gets you there (client report #101), so surface it
 * rather than letting punches quietly vanish.
 */
export const SI_CARD_CAPACITY: Record<SICardType, number> = {
  SI8: 30,
  SI9: 50,
  SI10: 64,
  SI11: 128,
};

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
  /** Legacy name for "finish" punch - kept to avoid touching consumers. */
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

interface ReaderStatePayload {
  /** `"idle" | "awakening" | "listening" | "reading" | "error" | "stopped"`. */
  state: string;
}

// Same window the legacy reader uses, kept TS-side so we can tune it
// per consumer without restarting the Rust task. Lock-in for now.
const CARD_DEBOUNCE_MS = 5000;

/**
 * How long to wait between reconnect attempts after the native reader dies
 * on its own (USB unplug, driver reset, cable knocked loose). Short enough
 * that a replug is back in service before the operator has finished
 * re-seating the dongle, long enough not to spin on `si_list_ports`.
 */
const RECONNECT_RETRY_MS = 1500;

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
  /** Simulator-only `si://card-read` listener (see setSimulatedReads). */
  private simUnlisten: UnlistenFn | null = null;
  private isStarted = false;
  private currentPort: string | null = null;
  /**
   * Serialises native reader start/stop so an in-flight `si_stop` always
   * runs to completion before the next `si_start` (and vice-versa). The
   * Rust side guards `SportIdentState` with a mutex but does NOT order
   * competing commands, so without this a fire-and-forget `stop()` from a
   * page unmount can race the next page's `initializePort`: either the
   * start sees the old reader still open ("reader already running") or a
   * late stop tears down the freshly-started reader. Chaining every
   * start/stop through one promise makes the ordering deterministic.
   */
  private opChain: Promise<void> = Promise.resolve();
  private onCardDetected?: (card: CardData) => void;
  private onStationsDetected?: (stations: StationData[]) => void;
  /**
   * Per-card-id last read: when, and a signature of what the card held.
   * The same card scanned again within `CARD_DEBOUNCE_MS` with the SAME
   * content is silently coalesced - matches the legacy behaviour where a
   * child tapping their card three times in a row was treated as one read.
   * A read whose content changed (a new punch, a finish record) always
   * goes through: dropping it lost a team's finish.
   */
  private lastCardTimestamps = new Map<number, { at: number; sig: string }>();
  /**
   * Accumulated station info. We keep one entry per station_number so
   * a multi-station setup eventually populates them all. The legacy
   * callback expected a `StationData[]` and replaced the whole list
   * each fire, so we publish `Array.from(map.values())`.
   */
  private stations = new Map<number, StationData>();
  /**
   * True between `stop()` and the next `initializePort()`. Distinguishes a
   * reader we deliberately shut down (page unmount, test panel closed) from
   * one that died under us - only the latter should trigger a reconnect.
   */
  private intentionalStop = false;
  /** Pending reconnect attempt, if any. Cleared by `stop()`. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a reconnect attempt is in flight, so retries don't overlap. */
  private reconnecting = false;
  /**
   * `performance.now()` just before the last `si_start`. Field diagnosis only:
   * the state log shows how long the station took to answer the handshake.
   */
  private startedAt = 0;
  // Last `si://error` message (the reader test reports it to the operator).
  private lastReaderError: string | null = null;

  /** True when running inside the Tauri shell. Never on Android: the tablet is
   *  a locked operator-only device with no SI reader (utils/platform.ts). */
  isAvailable(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !isAndroid();
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
   * Opens the port AND starts the reader in one shot - the Rust
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

    return this.runExclusive(async () => {
      // Re-check inside the lock: a queued start for the same port (e.g. the
      // hotplug poll firing twice) is now a clean no-op instead of a needless
      // stop/start restart.
      if (this.isStarted && this.currentPort === portPath) return true;
      // An explicit start supersedes any pending self-heal: cancel the
      // retry timer and re-arm death detection for the new session.
      this.cancelReconnect();
      this.intentionalStop = false;
      try {
        await this.attachListeners();
        this.startedAt = performance.now();
        try {
          await invoke('si_start', { deviceId: portPath });
        } catch (err) {
          // Self-heal a stale native reader: the Rust process can still hold
          // an open reader from before a webview reload (its state outlives
          // the JS module) or from a stop that hasn't landed. The serialised
          // chain means nothing else is mid-flight here, so it's safe to stop
          // whatever's running and start once more.
          if (String(err).includes('already running')) {
            console.warn('[si] reader already running - stopping stale reader and retrying');
            await invoke('si_stop').catch(() => {});
            await invoke('si_start', { deviceId: portPath });
          } else {
            throw err;
          }
        }
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
    });
  }

  /**
   * The operator's remote "refresh reader" (`reader_refresh`): re-detect the
   * dongle (the OS may hand it another COM port after a replug) and, when a
   * game page holds the reader, close and re-open it there. Publishes the
   * result like the top-bar poll. Resolves whether a reader is plugged in.
   */
  async refresh(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    const found = await detectReaderPort().catch(() => null);
    if (this.isStarted || this.hasCardCallback()) {
      if (this.isStarted) await this.stop();
      if (found) await this.initializePort(found.path);
      if (!this.isStarted) {
        // Keep trying for the game page, as after an unplug.
        this.intentionalStop = false;
        this.scheduleReconnect();
      }
    }
    publishReaderPresence(!!found);
    return !!found;
  }

  /**
   * The operator's remote reader test (`reader_beep`): beep the master twice.
   * A reader nobody holds is opened for the test and closed again. The serial
   * link can die during the station's wake-up (`transport: io error`); like a
   * game page's reconnect, the test re-opens it, up to 3 times. `detail` is the
   * last reader error, for the operator.
   */
  async testBeep(): Promise<{ result: 'ok' | 'no_reader' | 'not_listening'; detail?: string }> {
    if (!this.isAvailable()) return { result: 'no_reader' };
    this.lastReaderError = null;
    let openedHere = false;
    let result: 'ok' | 'not_listening' = 'not_listening';
    for (let attempt = 0; attempt < 3 && result !== 'ok'; attempt++) {
      if (!this.isStarted) {
        // Our own retry, not the game page's background one.
        if (openedHere || !this.hasCardCallback()) this.cancelReconnect();
        const found = await detectReaderPort().catch(() => null);
        if (!found) return { result: 'no_reader', detail: this.lastReaderError ?? undefined };
        if (!(await this.initializePort(found.path))) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        openedHere = openedHere || !this.hasCardCallback();
      }
      // The station answers its wake-up within a second or so of opening.
      for (let i = 0; i < 12 && this.isStarted; i++) {
        try {
          await invoke('si_send_beep', { count: 2 });
          result = 'ok';
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (result !== 'ok' && this.isStarted) break; // open but silent: retrying won't help
      if (result !== 'ok') {
        console.warn(`[si] reader test: link lost (${this.lastReaderError ?? 'no detail'}), retrying`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (openedHere && !this.hasCardCallback()) {
      // Let the station play its beeps before the port closes under it.
      if (result === 'ok') await new Promise((r) => setTimeout(r, 1500));
      await this.stop();
    }
    return { result, detail: result === 'ok' ? undefined : this.lastReaderError ?? undefined };
  }

  setCardDetectedCallback(callback: ((card: CardData) => void) | undefined) {
    this.onCardDetected = callback;
  }

  /** True while a game page has bound its card handler (game simulator readiness). */
  hasCardCallback(): boolean {
    return this.onCardDetected !== undefined;
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
    // Flag the shutdown as deliberate BEFORE detaching, so the `stopped`
    // state event si_stop is about to emit isn't mistaken for a reader
    // that died on its own and doesn't kick off a reconnect loop.
    this.intentionalStop = true;
    this.cancelReconnect();
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
      await this.runExclusive(async () => {
        try {
          await invoke('si_stop');
        } catch (err) {
          console.warn('[si] si_stop warn:', err);
        }
      });
    }
  }

  // ─── Hotplug self-heal ────────────────────────────────────────────
  //
  // Unplugging the dongle mid-game kills the native reader for good: the
  // serial read returns EOF/error, the Rust reader task emits `error` and
  // returns (see reader_task in src-tauri/src/sportident/reader.rs). Nothing
  // used to tell JS about it, so `isStarted`/`currentPort` stayed
  // optimistically true and the next `initializePort` for the same COM port
  // short-circuited to `return true` - the reader never reopened and cards
  // stopped punching until the app was restarted.
  //
  // We now watch `si://reader-state` for that death and re-open the port
  // ourselves. The card/station callbacks live on this instance, not on the
  // native session, so a successful reconnect resumes punching with no
  // involvement from the game page.

  /**
   * The native reader stopped without us asking. Reset local state so the
   * next `initializePort` really re-opens, release the dead handle Rust-side,
   * and start retrying until the dongle comes back.
   */
  private handleUnexpectedReaderStop(reason: string) {
    if (this.intentionalStop || !this.isStarted) return;
    console.warn(`[si] native reader stopped unexpectedly (${reason}) - reconnecting`);
    this.isStarted = false;
    this.currentPort = null;
    this.lastCardTimestamps.clear();
    this.stations.clear();
    void this.detachListeners();
    // Drop the dead ReaderHandle the Rust side is still holding, otherwise
    // the next si_start is refused with "reader already running". (The
    // retry path self-heals that too, but clearing it here keeps the
    // reconnect a single clean open.)
    void this.runExclusive(async () => {
      try {
        await invoke('si_stop');
      } catch {
        // Already gone - nothing to release.
      }
    }).catch(() => {});
    this.scheduleReconnect();
  }

  private cancelReconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null || this.reconnecting) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryReconnect();
    }, RECONNECT_RETRY_MS);
  }

  /**
   * One reconnect attempt: re-run VID/PID detection (the OS may hand the
   * dongle a different COM port after a replug) and re-open. Reschedules
   * itself until it succeeds or `stop()` cancels the loop.
   */
  private async tryReconnect(): Promise<void> {
    if (this.intentionalStop || this.isStarted) return;
    this.reconnecting = true;
    let reconnected = false;
    try {
      const found = await detectReaderPort();
      // Re-check after the await: a page unmount may have called stop()
      // while we were probing the port list.
      if (found && !this.intentionalStop && !this.isStarted) {
        reconnected = await this.initializePort(found.path);
        if (reconnected) {
          console.log('[si] reader reconnected on', found.path);
          // Same signal TopbarStatus's 10 s poll emits, so the game pages'
          // 'reader:status' handlers refresh their own detection state
          // without waiting for the next tick.
          window.dispatchEvent(
            new CustomEvent('reader:status', { detail: { state: 'ok' } }),
          );
        }
      }
    } catch (err) {
      console.warn('[si] reconnect attempt failed:', err);
    } finally {
      this.reconnecting = false;
    }
    // Keep retrying while there's still no live reader. Deliberately not
    // gated on `reconnected`: if the dongle came back and was yanked again
    // during this attempt, `isStarted` is false once more and we must keep
    // going (the death handler's own scheduleReconnect is a no-op while
    // `reconnecting` is set).
    if (!this.intentionalStop && !this.isStarted) {
      this.scheduleReconnect();
    }
  }

  // ─── Internals ────────────────────────────────────────────────────

  /**
   * Runs `task` after every previously-queued start/stop has settled,
   * regardless of whether they resolved or rejected. Returns the task's
   * own result/rejection to the caller while keeping the shared chain
   * alive (its errors are swallowed so one failed op can't wedge the
   * queue). See `opChain` for why this ordering matters.
   */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.opChain.then(task, task);
    this.opChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async attachListeners() {
    // Defensive - in normal flow the listener list is already empty.
    await this.detachListeners();

    this.unlisteners.push(
      await listen<CardPayload>('si://card-read', e => this.handleCardRead(e.payload)),
    );

    this.unlisteners.push(
      await listen<StationPayload>('si://station-detected', e => {
        const station = this.toLegacyStation(e.payload);
        if (!this.stations.has(station.stationNumber)) {
          console.info('[si] station', e.payload);
        }
        this.stations.set(station.stationNumber, station);
        this.onStationsDetected?.(Array.from(this.stations.values()));
      }),
    );

    this.unlisteners.push(
      await listen<ErrorPayload>('si://error', e => {
        // Error events are logged; the UI's existing setTimeout-based
        // dismissal handles user feedback. The reconnect is driven off
        // 'si://reader-state' below rather than from here - a transport
        // error is always followed by the matching state transition, and
        // the state machine is the authority on whether the task died.
        console.warn('[si] reader error:', e.payload.message);
        this.lastReaderError = e.payload.message;
      }),
    );

    this.unlisteners.push(
      await listen<ReaderStatePayload>('si://reader-state', e => {
        const state = e.payload.state;
        console.info(`[si] state ${state} +${Math.round(performance.now() - this.startedAt)}ms since si_start`);
        // 'error' = transport blew up (unplug, driver reset).
        // 'stopped' = the reader task wound down; when we didn't ask for
        // it, that means the byte channel closed under us.
        if (state === 'error' || state === 'stopped') {
          this.handleUnexpectedReaderStop(state);
        }
      }),
    );
  }

  private handleCardRead(payload: CardPayload) {
    const card = this.toLegacyCard(payload);
    const now = gameClock.now();
    const sig = JSON.stringify([card.start ?? null, card.end ?? null, card.check ?? null, card.punches]);
    const last = this.lastCardTimestamps.get(card.id);
    if (last && now - last.at < CARD_DEBOUNCE_MS && last.sig === sig) {
      // Same card, same content, within debounce → silently coalesce.
      return;
    }
    this.lastCardTimestamps.set(card.id, { at: now, sig });
    this.onCardDetected?.(card);
  }

  /**
   * Game simulator (tester builds): listen to `si://card-read` even with no
   * physical reader, so cards injected by `si_simulate_card` reach the live
   * game page. When a real reader is also running, its own listener already
   * handles the event, so this one stands aside.
   */
  async setSimulatedReads(on: boolean) {
    this.simUnlisten?.();
    this.simUnlisten = null;
    if (!on) return;
    this.simUnlisten = await listen<CardPayload>('si://card-read', e => {
      if (this.unlisteners.length > 0) return;
      this.handleCardRead(e.payload);
    });
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
      // Not surfaced by the new payload - legacy default was `false`
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
// TopbarStatus.tsx polls this every 10 s for its green/red status dot. Lives
// here rather than as a `SportIdentService` method because it
// deliberately doesn't open the port - just enumerates and looks for the
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

/** Report the reader to the mother (next ping) and to this window's game pages,
 *  as TopbarStatus's poll does. */
export function publishReaderPresence(ok: boolean): void {
  void invoke('client_set_reader_presence', { hasReader: ok }).catch(() => {});
  window.dispatchEvent(new CustomEvent('reader:status', { detail: { state: ok ? 'ok' : 'bad' } }));
}
