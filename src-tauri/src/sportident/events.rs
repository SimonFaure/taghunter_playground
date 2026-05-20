// Reader-side event types. These cross the tokio mpsc boundary inside
// `Reader::spawn(...)`; step 5 (`sportident/mod.rs` Tauri commands) will
// re-shape them into JSON payloads with `serde::Serialize` before
// emitting via `app.emit()`.
//
// Why keep them serde-free for now: the framing/parser/transport layers
// don't depend on serde, and adding `#[derive(Serialize)]` here would
// require adding a serde dep on the `bytes::Bytes` field of Frame
// transitively. Step 5 will define dedicated payload structs with serde
// derives — these in-Rust types stay clean.

use crate::sportident::cards::Card;
use crate::sportident::framing::ResyncReason;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ReaderState {
    /// Reader not yet started. Never observed in practice — `Reader::spawn`
    /// immediately transitions to `Awakening`.
    Idle,
    /// Wakeup frame sent; waiting for the first valid response from the
    /// master to confirm it's alive.
    Awakening,
    /// Steady state — connected to the master, waiting for `0xE8`
    /// card-inserted notifications.
    Listening,
    /// Mid-card-read — sent `0xEF` block requests, accumulating responses.
    Reading,
    /// Transport-level failure. Reader task is winding down. (Recovery
    /// loop is a step-4-followup item; right now we just exit and let the
    /// caller spawn a new reader.)
    Error,
    /// Reader stopped cleanly via `ReaderHandle::stop()` or transport
    /// close. Terminal state.
    Stopped,
}

/// Station info extracted from a `0x83` "get system data" response. Field
/// names mirror the legacy `StationData` TS interface so the frontend
/// shape doesn't have to change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StationInfo {
    /// Station number assigned by the operator (1-511). 0 means a USB
    /// dongle (no station number).
    pub station_number: u16,
    /// Operating mode (e.g. 5=control, 2=start, 3=finish, 6=read SI card).
    /// Low nibble of byte 0x07 in the response payload.
    pub mode: u8,
    /// `extended` flag: master forwards `0xE8` notifications to host.
    /// Bit 0 of byte 0x0A in the response.
    pub extended: bool,
    /// `auto-send` flag: master pushes punch records as they happen.
    /// Bit 1 of byte 0x0A.
    pub auto_send: bool,
    /// `handshake` flag: master waits for ACK after each notification.
    /// Bit 2 of byte 0x0A.
    pub handshake: bool,
}

#[derive(Debug, Clone)]
pub enum ReaderEvent {
    /// Fired on every state transition. Step 5 forwards as
    /// `si://reader-state`.
    StateChanged(ReaderState),
    /// Fired on every successful `0x83` response. Step 5 forwards as
    /// `si://station-detected`.
    StationDetected(StationInfo),
    /// Fired after a full card readout completes and the master has been
    /// ACK'd. Step 5 forwards as `si://card-read`.
    CardRead(Card),
    /// Decoder dropped a byte during resync. Surfaced for telemetry —
    /// step 5 may or may not propagate to JS depending on noise level.
    Resync { dropped: u8, reason: ResyncReason },
    /// Higher-level error (transport, parse, unsupported card, …). Step
    /// 5 forwards as `si://error`.
    Error(String),
}
