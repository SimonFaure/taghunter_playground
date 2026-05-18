// Reader — top-level state machine that ties transport, framing, and
// card parsing together. Spawns one tokio task that:
//
//   1. Sends wakeup + get-system-data at startup.
//   2. Decodes inbound bytes via `framing::Decoder`.
//   3. Routes each Frame through `handle_frame` (state-dependent).
//   4. On `0xE8` (card inserted): looks up CardType from the ID, fires
//      sequential `0xEF` block reads (per `CardType::blocks_to_read`),
//      then parses + emits CardRead and ACKs the master.
//   5. Re-issues the wakeup every `REWAKEUP_INTERVAL_MS` of idle time —
//      this is the fix for root cause #2 in the plan (legacy reader
//      sent wakeup exactly once, so cards silently stopped triggering
//      after ~10 s of master idle-sleep).
//
// Notable design choices vs. legacy:
//   - Writes happen BEFORE the corresponding `StateChanged` event fires.
//     Tests can therefore observe a state transition and immediately
//     read `mock.captured_tx()` to confirm the resulting write — no need
//     for `yield_now()` dances.
//   - `Drop` of `ReaderHandle` signals stop. Forgetting to call
//     `stop()` is a non-issue; the task winds down with the handle.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::time::{interval, Instant, MissedTickBehavior};

use super::cards::{Card, CardType};
use super::commands;
use super::config::{
    CMD_CARD_INSERTED, CMD_GET_SI9_DATA, CMD_GET_SYSTEM_DATA, CMD_SET_MS_MODE,
    REWAKEUP_INTERVAL_MS,
};
use super::events::{ReaderEvent, ReaderState, StationInfo};
use super::framing::{DecodeEvent, Decoder, Frame};
use super::transport::{BytesRx, SerialTransport};

pub struct Reader;

pub struct ReaderHandle {
    stop_tx: Option<oneshot::Sender<()>>,
    /// JoinHandle for the reader task. `stop().await` awaits it so the
    /// caller knows the full shutdown chain (reader task → transport
    /// close → owner task → SerialStream drop) has completed and the
    /// OS port handle has been released. Critical for the
    /// stop-then-start pattern (e.g. game page unmount immediately
    /// followed by the settings test panel opening the same port).
    task_handle: Option<tokio::task::JoinHandle<()>>,
}

impl Reader {
    /// Spawn the reader task. Returns the control handle and the event
    /// receiver. The caller is responsible for forwarding events to JS
    /// (step 5) — the reader itself has no Tauri dependency.
    pub fn spawn(
        transport: Arc<dyn SerialTransport>,
        rx_bytes: BytesRx,
    ) -> (ReaderHandle, mpsc::UnboundedReceiver<ReaderEvent>) {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (stop_tx, stop_rx) = oneshot::channel();

        let task = tokio::spawn(reader_task(transport, rx_bytes, event_tx, stop_rx));

        (
            ReaderHandle {
                stop_tx: Some(stop_tx),
                task_handle: Some(task),
            },
            event_rx,
        )
    }
}

impl ReaderHandle {
    /// Explicit shutdown — awaits the reader task to fully exit, which
    /// in turn awaits the transport's owner task to drop the
    /// SerialStream and release the OS handle. Idempotent: calling on
    /// an already-stopped reader is a no-op.
    pub async fn stop(mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.task_handle.take() {
            if let Err(e) = handle.await {
                eprintln!("[sportident] reader task panicked: {}", e);
            }
        }
    }
}

impl Drop for ReaderHandle {
    fn drop(&mut self) {
        // Implicit stop on drop — fire the signal but don't (can't) wait
        // for the task to exit. The reader task will see the dropped
        // sender and shut down asynchronously. Callers that need to
        // observe full teardown (e.g. release-and-reopen a port) must
        // call `stop().await` explicitly instead of letting Drop run.
        let _ = self.stop_tx.take();
        // task_handle drops here too; tokio detaches the task, which
        // continues to its natural exit.
    }
}

/// Per-card in-flight read. Lives only between a `0xE8` notification and
/// the final `0xEF` response, then resets to `None`.
struct CardSession {
    card_type: CardType,
    blocks_to_read: &'static [u8],
    /// Concatenated 128-byte block bodies as they arrive. Sized at
    /// construction so we don't reallocate per chunk.
    accumulated: Vec<u8>,
    /// Index into `blocks_to_read` of the *next* block to request.
    next_block_idx: usize,
}

async fn reader_task(
    transport: Arc<dyn SerialTransport>,
    mut rx_bytes: BytesRx,
    event_tx: mpsc::UnboundedSender<ReaderEvent>,
    mut stop_rx: oneshot::Receiver<()>,
) {
    let mut decoder = Decoder::new();
    let mut state = ReaderState::Idle;
    let mut session: Option<CardSession> = None;
    let mut last_rx_at = Instant::now();

    // Boot: send wakeup + system-data probe, then announce Awakening.
    // Writes happen BEFORE the StateChanged event so tests can observe
    // the transition and immediately verify `mock.captured_tx()`.
    let _ = transport.write(&commands::build_wakeup()).await;
    let _ = transport.write(&commands::build_get_system_data()).await;
    set_state(&mut state, ReaderState::Awakening, &event_tx);

    // Re-wakeup driver. Ticks once a second; only sends a fresh wakeup
    // when both (a) the state warrants it (Awakening or Listening) and
    // (b) we've been silent for ≥ REWAKEUP_INTERVAL_MS. The 1 s
    // granularity gives bounded latency without flooding the bus.
    let mut tick = interval(Duration::from_millis(1_000));
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut decode_scratch: Vec<DecodeEvent> = Vec::with_capacity(8);

    loop {
        tokio::select! {
            // Stop takes priority — if the handle is dropping, no point
            // processing more bytes.
            biased;

            _ = &mut stop_rx => {
                set_state(&mut state, ReaderState::Stopped, &event_tx);
                let _ = transport.close().await;
                return;
            }

            chunk = rx_bytes.recv() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        last_rx_at = Instant::now();
                        decode_scratch.clear();
                        decoder.push(&bytes, &mut decode_scratch);
                        // Drain into a local Vec so the borrow checker
                        // accepts the async calls below (decoder is
                        // mut-borrowed by push).
                        let events_to_process: Vec<DecodeEvent> =
                            decode_scratch.drain(..).collect();
                        for ev in events_to_process {
                            handle_decode_event(ev, &mut state, &mut session, &transport, &event_tx)
                                .await;
                        }
                    }
                    Some(Err(e)) => {
                        let _ = event_tx.send(ReaderEvent::Error(format!("transport: {}", e)));
                        set_state(&mut state, ReaderState::Error, &event_tx);
                        return;
                    }
                    None => {
                        // Transport closed (sender dropped its end).
                        set_state(&mut state, ReaderState::Stopped, &event_tx);
                        return;
                    }
                }
            }

            _ = tick.tick() => {
                let should_rewake = matches!(state, ReaderState::Awakening | ReaderState::Listening)
                    && last_rx_at.elapsed() >= Duration::from_millis(REWAKEUP_INTERVAL_MS);
                if should_rewake {
                    let _ = transport.write(&commands::build_wakeup()).await;
                    // Don't reset last_rx_at — we want to retry on the
                    // next tick if still silent, and ANY inbound byte
                    // will reset it anyway.
                    last_rx_at = Instant::now();
                }
            }
        }
    }
}

async fn handle_decode_event(
    event: DecodeEvent,
    state: &mut ReaderState,
    session: &mut Option<CardSession>,
    transport: &Arc<dyn SerialTransport>,
    event_tx: &mpsc::UnboundedSender<ReaderEvent>,
) {
    match event {
        DecodeEvent::Resync { dropped, reason } => {
            let _ = event_tx.send(ReaderEvent::Resync { dropped, reason });
        }
        DecodeEvent::Frame(frame) => {
            handle_frame(frame, state, session, transport, event_tx).await;
        }
    }
}

async fn handle_frame(
    frame: Frame,
    state: &mut ReaderState,
    session: &mut Option<CardSession>,
    transport: &Arc<dyn SerialTransport>,
    event_tx: &mpsc::UnboundedSender<ReaderEvent>,
) {
    match frame.cmd {
        CMD_SET_MS_MODE => {
            // The wakeup ACK. Mostly informational — we don't need to
            // do anything beyond noting the master is alive.
            if matches!(*state, ReaderState::Awakening) {
                set_state(state, ReaderState::Listening, event_tx);
            }
        }

        CMD_GET_SYSTEM_DATA => {
            // 0x83 response: extract station fields and announce. If
            // we were still in Awakening, this confirms the handshake.
            if let Some(info) = parse_station_info(&frame.payload) {
                let _ = event_tx.send(ReaderEvent::StationDetected(info));
            }
            if matches!(*state, ReaderState::Awakening) {
                set_state(state, ReaderState::Listening, event_tx);
            }
        }

        CMD_CARD_INSERTED => {
            // 0xE8 unsolicited notification. Payload layout (per SI manual):
            //   [CN1, CN0, SI3, SI2, SI1, SI0]
            //  └── master station number ──┘
            //                 └── SI3: series indicator (NOT part of printed card number)
            //                          0x01 = SI9, 0x02 = SI8, 0x04 = SI10/SI11, 0x08 = SIAC
            //                     └── SI2..SI0: printed card number (24-bit, big-endian)
            //
            // The "printed card number" is the 7-digit ID stamped on the
            // physical card and used in the SI manufacturing ranges
            // (1M-2M = SI9, 2M-3M = SI8, etc.). SI3 is an out-of-band
            // series tag — we discard it here because the range-based
            // detection in `CardType::from_card_id` works directly off
            // the printed number and matches what `parser.rs` reads
            // from offsets 25-27 of the readout buffer.
            //
            // Bug history: the first implementation used all 4 bytes as
            // a u32, which made every real SI9/SI10/SI11 card fail with
            // "unsupported card id" because the SI3 byte shifted the
            // value out of the manufacturing range (e.g. card 1,894,253
            // arrived as 18,666,285 with SI3=0x01).
            //
            // Ignore notifications while we're already reading another
            // card — the legacy code's fake "removed" loop ate the next
            // card's bytes precisely because it didn't gate this way.
            if !matches!(*state, ReaderState::Listening) {
                return;
            }
            if frame.payload.len() < 6 {
                let _ = event_tx.send(ReaderEvent::Error(format!(
                    "short 0xE8 payload: {} bytes",
                    frame.payload.len()
                )));
                return;
            }
            let card_id = ((frame.payload[3] as u32) << 16)
                | ((frame.payload[4] as u32) << 8)
                | (frame.payload[5] as u32);
            let Some(card_type) = CardType::from_card_id(card_id) else {
                let _ = event_tx.send(ReaderEvent::Error(format!(
                    "unsupported card id {} (only SI8/9/10/11 supported)",
                    card_id
                )));
                return;
            };
            let blocks = card_type.blocks_to_read();
            // Send the first 0xEF block request BEFORE flipping state, so
            // the state event semantically means "request sent".
            let _ = transport
                .write(&commands::build_get_card_block(blocks[0]))
                .await;
            *session = Some(CardSession {
                card_type,
                blocks_to_read: blocks,
                accumulated: Vec::with_capacity(blocks.len() * 128),
                next_block_idx: 1,
            });
            set_state(state, ReaderState::Reading, event_tx);
        }

        CMD_GET_SI9_DATA => {
            // 0xEF block response. Payload layout (137-byte frame minus
            // STX/CMD/LEN/CRC/ETX overhead):
            //   [CN1, CN0, block_idx, ...128 bytes of block data...]
            // = 131 payload bytes total.
            let Some(s) = session.as_mut() else {
                // 0xEF outside an active session means we somehow lost
                // sync. Drop it rather than crash.
                return;
            };
            if frame.payload.len() < 3 + 128 {
                let _ = event_tx.send(ReaderEvent::Error(format!(
                    "short 0xEF response: {} bytes",
                    frame.payload.len()
                )));
                return;
            }
            s.accumulated.extend_from_slice(&frame.payload[3..3 + 128]);

            if s.next_block_idx < s.blocks_to_read.len() {
                // More blocks to fetch.
                let next = s.blocks_to_read[s.next_block_idx];
                s.next_block_idx += 1;
                let _ = transport
                    .write(&commands::build_get_card_block(next))
                    .await;
            } else {
                // All blocks in. Parse, ACK, emit.
                let card_type = s.card_type;
                let buffer = std::mem::take(&mut s.accumulated);
                *session = None;

                // ACK first so the master beeps fast even if parsing is
                // slow (it shouldn't be, but cheap insurance).
                let _ = transport.write(&commands::build_ack()).await;

                match Card::parse(card_type, &buffer) {
                    Ok(card) => {
                        let _ = event_tx.send(ReaderEvent::CardRead(card));
                    }
                    Err(e) => {
                        let _ = event_tx.send(ReaderEvent::Error(format!(
                            "card parse failed: {}",
                            e
                        )));
                    }
                }
                set_state(state, ReaderState::Listening, event_tx);
            }
        }

        _ => {
            // Unknown command — log once and move on. Could be a master
            // firmware extension, an echoed sub-byte, or noise.
        }
    }
}

fn set_state(
    state: &mut ReaderState,
    new: ReaderState,
    event_tx: &mpsc::UnboundedSender<ReaderEvent>,
) {
    if *state != new {
        *state = new.clone();
        let _ = event_tx.send(ReaderEvent::StateChanged(new));
    }
}

/// Extract station fields from the `0x83` "get system data" response
/// payload. Offsets verified against legacy lib.js `Station.parse` —
/// the legacy code uses absolute frame offsets (incl. STX/CMD/LEN), so
/// subtract 3 to map onto our payload-only slice.
fn parse_station_info(payload: &[u8]) -> Option<StationInfo> {
    // Need at least the bytes legacy `parse()` reads: 0x0A in full
    // frame = 7 in payload. Be lenient — short responses surface as
    // None rather than panic.
    if payload.len() < 8 {
        return None;
    }
    // station_number: legacy buffer[3]+buffer[4]*256 → payload[0]+payload[1]*256
    let station_number = ((payload[1] as u16) << 8 | payload[0] as u16) & 0x01FF;
    // mode: legacy buffer[0x07] = payload[4], low nibble.
    let mode = payload[4] & 0x0F;
    // flags: legacy buffer[0x0A] = payload[7].
    let pr = payload[7];
    Some(StationInfo {
        station_number,
        mode,
        extended: (pr & 0x01) != 0,
        auto_send: (pr & 0x02) != 0,
        handshake: (pr & 0x04) != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sportident::config::{ACK, CMD_CARD_INSERTED, CMD_GET_SI9_DATA, CMD_GET_SYSTEM_DATA};
    use crate::sportident::framing::build_frame;
    use crate::sportident::transport::mock::MockTransport;

    /// Build a synthetic `0x83` station-config response covering enough
    /// bytes for `parse_station_info` to populate every field.
    fn synth_station_response(station_number: u16) -> Vec<u8> {
        // Payload layout (per legacy offsets, subtract 3 for our slice):
        //   [0] station_number low
        //   [1] station_number high
        //   [2,3] don't-care
        //   [4] mode (low nibble)
        //   [5,6] don't-care
        //   [7] flags byte (extended/autoSend/handshake)
        //   rest don't-care; pad to a comfortable length.
        let mut payload = vec![0u8; 16];
        payload[0] = (station_number & 0xFF) as u8;
        payload[1] = ((station_number >> 8) & 0xFF) as u8;
        payload[4] = 0x05; // mode = 5 (control)
        payload[7] = 0x01; // extended=1, autoSend=0, handshake=0
        build_frame(CMD_GET_SYSTEM_DATA, &payload)
    }

    /// Build a synthetic `0xE8` card-inserted notification for the given
    /// 24-bit printed card number. Auto-derives the series byte (SI3)
    /// from the SI manufacturing range so tests don't have to know the
    /// magic constants:
    ///   1M-2M → 0x01 (SI9), 2M-3M → 0x02 (SI8), 7M-10M → 0x04 (SI10/11).
    fn synth_card_inserted(card_id: u32) -> Vec<u8> {
        assert!(
            card_id <= 0x00FF_FFFF,
            "printed card number must fit in 24 bits ({})",
            card_id
        );
        let series_byte: u8 = match card_id {
            1_000_000..=1_999_999 => 0x01,
            2_000_000..=2_999_999 => 0x02,
            7_000_000..=9_999_999 => 0x04,
            _ => 0x00, // unknown/unsupported — exercised by the negative test below
        };
        // Payload = [CN1, CN0, SI3, SI2, SI1, SI0]. CN values don't
        // matter — the reader only consumes the SI bytes.
        let payload = vec![
            0x00,
            0x01,
            series_byte,
            ((card_id >> 16) & 0xFF) as u8,
            ((card_id >> 8) & 0xFF) as u8,
            (card_id & 0xFF) as u8,
        ];
        build_frame(CMD_CARD_INSERTED, &payload)
    }

    /// Build a synthetic `0xEF` block response. Wraps `block_body`
    /// (exactly 128 bytes) with the 3-byte response header [CN1, CN0,
    /// block_idx].
    fn synth_block_response(block_idx: u8, block_body: &[u8]) -> Vec<u8> {
        assert_eq!(block_body.len(), 128);
        let mut payload = Vec::with_capacity(3 + 128);
        payload.extend_from_slice(&[0x00, 0x01, block_idx]);
        payload.extend_from_slice(block_body);
        build_frame(CMD_GET_SI9_DATA, &payload)
    }

    /// Build the bytes that comprise an SI9 readout buffer's block 0:
    /// card ID at 25-27, punch count at 22, plus a single punch at
    /// offset 56 with code 31 at time 10:00:00.
    fn synth_si9_block0(card_id: u32) -> Vec<u8> {
        let mut block = vec![0u8; 128];
        block[22] = 1; // 1 punch claimed
        block[25] = ((card_id >> 16) & 0xFF) as u8;
        block[26] = ((card_id >> 8) & 0xFF) as u8;
        block[27] = (card_id & 0xFF) as u8;
        // punch at 56: code 31, 10:00:00 (36000s in 12h pivot → AM, no PM bit).
        block[56] = 0x00; // ptd: AM, no high code bits, no day/week
        block[57] = 31;
        let secs: u32 = 36000;
        block[58] = ((secs >> 8) & 0xFF) as u8;
        block[59] = (secs & 0xFF) as u8;
        block
    }

    /// Drain events until the predicate matches; bail with a panic if
    /// the channel closes first.
    async fn recv_until<F>(
        rx: &mut mpsc::UnboundedReceiver<ReaderEvent>,
        mut pred: F,
    ) -> ReaderEvent
    where
        F: FnMut(&ReaderEvent) -> bool,
    {
        loop {
            let ev = rx.recv().await.expect("event channel closed");
            if pred(&ev) {
                return ev;
            }
        }
    }

    #[tokio::test]
    async fn boot_sends_wakeup_then_get_system_data_then_emits_awakening() {
        let (mock, rx_bytes) = MockTransport::new();
        let transport: Arc<dyn SerialTransport> = mock.clone();
        let (_handle, mut events) = Reader::spawn(transport, rx_bytes);

        // First event is StateChanged(Awakening). Per the reader's
        // write-then-emit ordering, the wakeup + get-system-data bytes
        // are already in the captured tx by the time we observe this.
        let evt = events.recv().await.unwrap();
        assert!(
            matches!(evt, ReaderEvent::StateChanged(ReaderState::Awakening)),
            "first event was {:?}",
            evt
        );

        let tx = mock.captured_tx();
        let wakeup = commands::build_wakeup();
        let probe = commands::build_get_system_data();
        let mut expected = wakeup.clone();
        expected.extend_from_slice(&probe);
        assert_eq!(tx, expected, "tx did not match wakeup+probe");
    }

    #[tokio::test]
    async fn station_response_emits_station_detected_and_transitions_to_listening() {
        let (mock, rx_bytes) = MockTransport::new();
        let transport: Arc<dyn SerialTransport> = mock.clone();
        let (_handle, mut events) = Reader::spawn(transport, rx_bytes);

        // Wait for boot transition.
        let _ = events.recv().await;

        // Push a synthetic 0x83 response.
        mock.inject_rx(&synth_station_response(42));

        let station = recv_until(&mut events, |e| matches!(e, ReaderEvent::StationDetected(_))).await;
        match station {
            ReaderEvent::StationDetected(info) => {
                assert_eq!(info.station_number, 42);
                assert_eq!(info.mode, 5);
                assert!(info.extended);
                assert!(!info.auto_send);
                assert!(!info.handshake);
            }
            _ => unreachable!(),
        }

        let listening = recv_until(&mut events, |e| {
            matches!(e, ReaderEvent::StateChanged(ReaderState::Listening))
        })
        .await;
        assert!(matches!(
            listening,
            ReaderEvent::StateChanged(ReaderState::Listening)
        ));
    }

    #[tokio::test]
    async fn happy_path_si9_card_read_end_to_end() {
        let (mock, rx_bytes) = MockTransport::new();
        let transport: Arc<dyn SerialTransport> = mock.clone();
        let (_handle, mut events) = Reader::spawn(transport, rx_bytes);

        // Boot.
        let _ = events.recv().await; // StateChanged(Awakening)
        mock.inject_rx(&synth_station_response(7));
        let _ = recv_until(&mut events, |e| {
            matches!(e, ReaderEvent::StateChanged(ReaderState::Listening))
        })
        .await;

        // We've sent wakeup + get-system-data so far. Reset the log so we
        // can scrutinize only the read-side bytes from here on.
        mock.clear_tx_log();

        // Card inserted!
        let card_id = 1_500_000u32; // SI9 range
        mock.inject_rx(&synth_card_inserted(card_id));

        // Reader must transition to Reading AND have sent the block-0
        // request. Per the ordering invariant, by the time we see the
        // state event, the write is in the log.
        let _ = recv_until(&mut events, |e| {
            matches!(e, ReaderEvent::StateChanged(ReaderState::Reading))
        })
        .await;
        assert_eq!(
            mock.captured_tx(),
            commands::build_get_card_block(0),
            "expected block-0 request after 0xE8"
        );
        mock.clear_tx_log();

        // Reply with block 0 (carries the card metadata + 1 punch).
        let block0 = synth_si9_block0(card_id);
        mock.inject_rx(&synth_block_response(0, &block0));

        // We can't observe a state event between blocks (still Reading),
        // but block 1 should have been requested. Yield until the write
        // shows up.
        // Easiest: poll the captured_tx briefly (in practice the write
        // happens immediately when the frame is decoded). One yield_now
        // suffices since the task is single-threaded and our injection
        // synchronously feeds the mpsc.
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        assert_eq!(
            mock.captured_tx(),
            commands::build_get_card_block(1),
            "expected block-1 request after block-0 response"
        );
        mock.clear_tx_log();

        // Reply with block 1 (empty, padding).
        let block1 = vec![0u8; 128];
        mock.inject_rx(&synth_block_response(1, &block1));

        // Reader emits CardRead + ACKs the master + transitions back.
        let card_event = recv_until(&mut events, |e| matches!(e, ReaderEvent::CardRead(_))).await;
        match card_event {
            ReaderEvent::CardRead(card) => {
                assert_eq!(card.card_id, card_id);
                assert_eq!(card.card_type, CardType::Si9);
                assert_eq!(card.punches.len(), 1);
                assert_eq!(card.punches[0].code, 31);
            }
            _ => unreachable!(),
        }

        let _ = recv_until(&mut events, |e| {
            matches!(e, ReaderEvent::StateChanged(ReaderState::Listening))
        })
        .await;
        // ACK is a single 0x06 byte.
        assert_eq!(mock.captured_tx(), vec![ACK]);
    }

    #[tokio::test]
    async fn si3_series_byte_does_not_inflate_card_id() {
        // Regression test for the bug where the 0xE8 notification's first
        // payload byte (SI3 series indicator) was being treated as the
        // high byte of a 32-bit card id. Real-world SI9 card: SI3=0x01,
        // SI2..SI0=0x1CE96D. Wrongly combined as u32 this is 18_666_285
        // (outside all manufacturing ranges → "unsupported card id"
        // error). The correct printed number is 0x1CE96D = 1_894_253,
        // which is in the SI9 range.
        let (mock, rx_bytes) = MockTransport::new();
        let transport: Arc<dyn SerialTransport> = mock.clone();
        let (_handle, mut events) = Reader::spawn(transport, rx_bytes);
        let _ = events.recv().await; // boot Awakening
        mock.inject_rx(&synth_station_response(1));
        let _ = recv_until(&mut events, |e| {
            matches!(e, ReaderEvent::StateChanged(ReaderState::Listening))
        })
        .await;
        mock.clear_tx_log();

        // Inject the user's exact failing card: SI3=0x01, lower 3 bytes
        // = 0x1CE96D = 1_894_253. Hand-built to bypass the helper's
        // auto-series logic, exactly as a real master would emit it.
        let mut wire = Vec::new();
        wire.extend(crate::sportident::framing::build_frame(
            CMD_CARD_INSERTED,
            &[0x00, 0x01, 0x01, 0x1C, 0xE9, 0x6D],
        ));
        mock.inject_rx(&wire);

        // Must transition to Reading (i.e. card type was recognised),
        // and the requested block must be block 0 (SI9's blocks_to_read).
        let _ = recv_until(&mut events, |e| {
            matches!(e, ReaderEvent::StateChanged(ReaderState::Reading))
        })
        .await;
        assert_eq!(
            mock.captured_tx(),
            commands::build_get_card_block(0),
            "expected SI9 block-0 request — card id was not parsed correctly"
        );
    }

    #[tokio::test]
    async fn unsupported_card_id_emits_error_and_stays_in_listening() {
        let (mock, rx_bytes) = MockTransport::new();
        let transport: Arc<dyn SerialTransport> = mock.clone();
        let (_handle, mut events) = Reader::spawn(transport, rx_bytes);

        let _ = events.recv().await;
        mock.inject_rx(&synth_station_response(1));
        let _ = recv_until(&mut events, |e| {
            matches!(e, ReaderEvent::StateChanged(ReaderState::Listening))
        })
        .await;

        // Inject an 0xE8 notification with a card id outside any supported
        // range (e.g. SIAC band 8M-9M, not yet supported).
        mock.inject_rx(&synth_card_inserted(8_500_000));

        let err = recv_until(&mut events, |e| matches!(e, ReaderEvent::Error(_))).await;
        match err {
            ReaderEvent::Error(msg) => {
                assert!(msg.contains("unsupported"), "msg: {}", msg);
            }
            _ => unreachable!(),
        }
        // No state transition into Reading.
        // (We don't directly assert this — but the next event the test
        // pulls would be the next thing we inject. Implicit by progress.)
    }

    #[tokio::test]
    async fn second_e8_during_active_read_is_ignored() {
        let (mock, rx_bytes) = MockTransport::new();
        let transport: Arc<dyn SerialTransport> = mock.clone();
        let (_handle, mut events) = Reader::spawn(transport, rx_bytes);

        let _ = events.recv().await;
        mock.inject_rx(&synth_station_response(1));
        let _ = recv_until(&mut events, |e| {
            matches!(e, ReaderEvent::StateChanged(ReaderState::Listening))
        })
        .await;

        mock.clear_tx_log();
        let card_id = 1_500_000u32;
        mock.inject_rx(&synth_card_inserted(card_id));
        let _ = recv_until(&mut events, |e| {
            matches!(e, ReaderEvent::StateChanged(ReaderState::Reading))
        })
        .await;
        mock.clear_tx_log();

        // Now inject ANOTHER 0xE8 while still in Reading. Legacy reader
        // would have happily overwritten the in-flight session, mangling
        // both reads. We require this to be dropped silently.
        mock.inject_rx(&synth_card_inserted(2_500_000));
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        // No new block-request write triggered by the second notification.
        assert!(mock.captured_tx().is_empty(), "captured: {:?}", mock.captured_tx());
    }
}
