// From-scratch SportIdent reader.
//
// Replaces src/lib/lib.js + src/services/usbReader.ts at step 7 of the plan
// in plans/let-s-work-on-the-flickering-leaf.md. Gated behind the
// `new-si-reader` cargo feature so main keeps shipping the legacy JS path
// until the migration completes.
//
// Layout (each layer testable in isolation):
//   transport/  -- async SerialTransport trait + desktop tokio-serial impl
//                  + MockTransport for hardware-free tests + Android bridge
//                  (added in step 8)
//   config      -- protocol constants (STX/ETX/wakeup, cmd codes, baud,
//                  re-wakeup interval). Lives at the top so every layer can
//                  see them without cycles.
//
// framing/, cards/, commands.rs, reader.rs, events.rs land in steps 2-5.

pub mod cards;
pub mod commands;
pub mod config;
pub mod events;
pub mod framing;
pub mod reader;
pub mod transport;

// ─────────────────────────────────────────────────────────────────────
// Tauri surface (event payloads, commands, managed state). This is the
// only layer aware of `tauri::` — the rest of the module is pure Rust
// and can be tested without an app context.
// ─────────────────────────────────────────────────────────────────────

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::sportident::cards::{Card, Punch};
use crate::sportident::events::{ReaderEvent, ReaderState, StationInfo};
use crate::sportident::framing::ResyncReason;
use crate::sportident::reader::{Reader, ReaderHandle};
use crate::sportident::transport::PortInfo;

/// Tauri-managed state. Wrapped in a `tokio::sync::Mutex` because every
/// access happens inside an `async fn` Tauri command — `std::sync::Mutex`
/// across awaits is a hazard.
#[derive(Default)]
pub struct SportIdentState(Mutex<Option<ReaderHandle>>);

// ─── Payloads (renamed to camelCase for JS consumption) ──────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PortPayload {
    pub device_id: String,
    pub label: String,
    /// Lower-case hex without the "0x" prefix, e.g. "10c4". `None` for
    /// non-USB ports (RS-232, virtual ports). The legacy JS surface
    /// expected hex strings here, so we match for one-line consumer
    /// migration.
    pub vendor_id: Option<String>,
    pub product_id: Option<String>,
    pub manufacturer: Option<String>,
}

impl From<PortInfo> for PortPayload {
    fn from(p: PortInfo) -> Self {
        Self {
            device_id: p.device_id,
            label: p.label,
            vendor_id: p.vendor_id.map(|v| format!("{:04x}", v)),
            product_id: p.product_id.map(|v| format!("{:04x}", v)),
            manufacturer: p.manufacturer,
        }
    }
}

#[derive(Serialize, Clone)]
pub struct PunchPayload {
    pub code: u16,
    /// "HH:MM:SS" — matches the legacy `CardData.punches[].time` shape.
    pub time: String,
}

impl From<Punch> for PunchPayload {
    fn from(p: Punch) -> Self {
        Self { code: p.code, time: p.time_hms() }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CardPayload {
    pub card_id: u32,
    /// "SI8" / "SI9" / "SI10" / "SI11".
    pub card_type: &'static str,
    pub start: Option<PunchPayload>,
    pub finish: Option<PunchPayload>,
    pub check: Option<PunchPayload>,
    pub punches: Vec<PunchPayload>,
}

impl From<Card> for CardPayload {
    fn from(c: Card) -> Self {
        Self {
            card_id: c.card_id,
            card_type: c.card_type.name(),
            start: c.start.map(PunchPayload::from),
            finish: c.finish.map(PunchPayload::from),
            check: c.check.map(PunchPayload::from),
            punches: c.punches.into_iter().map(PunchPayload::from).collect(),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StationPayload {
    pub station_number: u16,
    pub mode: u8,
    pub extended: bool,
    pub auto_send: bool,
    pub handshake: bool,
}

impl From<StationInfo> for StationPayload {
    fn from(s: StationInfo) -> Self {
        Self {
            station_number: s.station_number,
            mode: s.mode,
            extended: s.extended,
            auto_send: s.auto_send,
            handshake: s.handshake,
        }
    }
}

#[derive(Serialize, Clone)]
pub struct ReaderStatePayload {
    /// `"idle" | "awakening" | "listening" | "reading" | "error" | "stopped"`.
    pub state: &'static str,
}

#[derive(Serialize, Clone)]
pub struct ResyncPayload {
    pub dropped: u8,
    /// `"unexpected-byte-before-stx" | "bad-crc" | "bad-etx"`.
    pub reason: &'static str,
}

#[derive(Serialize, Clone)]
pub struct ErrorPayload {
    pub message: String,
}

fn reader_state_name(s: &ReaderState) -> &'static str {
    match s {
        ReaderState::Idle => "idle",
        ReaderState::Awakening => "awakening",
        ReaderState::Listening => "listening",
        ReaderState::Reading => "reading",
        ReaderState::Error => "error",
        ReaderState::Stopped => "stopped",
    }
}

fn resync_reason_name(r: &ResyncReason) -> &'static str {
    match r {
        ResyncReason::UnexpectedByteBeforeStx => "unexpected-byte-before-stx",
        ResyncReason::BadCrc => "bad-crc",
        ResyncReason::BadEtx => "bad-etx",
    }
}

// ─── Event names (single source of truth) ────────────────────────────

/// `si://reader-state` — fires on every state machine transition.
pub const EVT_READER_STATE: &str = "si://reader-state";
/// `si://station-detected` — fires on every `0x83` response from the master.
pub const EVT_STATION_DETECTED: &str = "si://station-detected";
/// `si://card-read` — fires once per fully-read card, after the master is ACK'd.
pub const EVT_CARD_READ: &str = "si://card-read";
/// `si://decoder-resync` — diagnostic: decoder dropped a byte during resync.
pub const EVT_DECODER_RESYNC: &str = "si://decoder-resync";
/// `si://error` — higher-level error (transport, parse, unsupported card).
pub const EVT_ERROR: &str = "si://error";

fn emit_reader_event(app: &AppHandle, event: ReaderEvent) {
    match event {
        ReaderEvent::StateChanged(s) => {
            let _ = app.emit(
                EVT_READER_STATE,
                ReaderStatePayload { state: reader_state_name(&s) },
            );
        }
        ReaderEvent::StationDetected(info) => {
            let _ = app.emit(EVT_STATION_DETECTED, StationPayload::from(info));
        }
        ReaderEvent::CardRead(card) => {
            let _ = app.emit(EVT_CARD_READ, CardPayload::from(card));
        }
        ReaderEvent::Resync { dropped, reason } => {
            let _ = app.emit(
                EVT_DECODER_RESYNC,
                ResyncPayload { dropped, reason: resync_reason_name(&reason) },
            );
        }
        ReaderEvent::Error(message) => {
            let _ = app.emit(EVT_ERROR, ErrorPayload { message });
        }
    }
}

// ─── Tauri commands ──────────────────────────────────────────────────

#[tauri::command]
pub async fn si_list_ports() -> Result<Vec<PortPayload>, String> {
    let ports = transport::list_ports().await.map_err(|e| e.to_string())?;
    Ok(ports.into_iter().map(PortPayload::from).collect())
}

#[tauri::command]
pub async fn si_start(
    app: AppHandle,
    state: State<'_, SportIdentState>,
    device_id: String,
) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Err("reader already running; call si_stop first".into());
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, device_id);
        return Err("mobile transport pending step 8 of the migration plan".into());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let (transport_arc, rx_bytes) =
            transport::desktop::open(&device_id, config::DEFAULT_BAUD)
                .await
                .map_err(|e| e.to_string())?;
        let transport: Arc<dyn transport::SerialTransport> = transport_arc;
        let (handle, mut events) = Reader::spawn(transport, rx_bytes);

        // Detached forwarder task: drains the reader's event channel onto
        // Tauri's event bus until the channel closes (which happens after
        // the reader task winds down on stop / drop / transport error).
        let app_for_task = app.clone();
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                emit_reader_event(&app_for_task, event);
            }
        });

        *guard = Some(handle);
        Ok(())
    }
}

#[tauri::command]
pub async fn si_stop(state: State<'_, SportIdentState>) -> Result<(), String> {
    // Hold the state mutex across `handle.stop().await` — that way a
    // concurrent `si_start` (e.g. the settings test panel mounting while
    // a game page is still unmounting) blocks until the previous reader
    // has fully released the OS port handle. Without this, the next
    // open() races the previous task's teardown and the master station
    // appears "still in use" to Windows.
    let mut guard = state.0.lock().await;
    if let Some(handle) = guard.take() {
        handle.stop().await;
    }
    Ok(())
}

// Beep / set-time / read-config require a control channel inside the
// reader task that doesn't exist yet. Returning a clear error here is
// better than silently no-op'ing — JS surfaces the message verbatim so
// the developer knows to add the plumbing when first wiring these
// buttons. Tracked as a follow-up to step 5.
#[tauri::command]
pub async fn si_send_beep(_state: State<'_, SportIdentState>) -> Result<(), String> {
    Err("si_send_beep: control channel not yet wired (follow-up to step 5)".into())
}

#[tauri::command]
pub async fn si_set_station_time(
    _state: State<'_, SportIdentState>,
    _time_iso: String,
) -> Result<(), String> {
    Err("si_set_station_time: control channel not yet wired (follow-up to step 5)".into())
}

#[tauri::command]
pub async fn si_read_station_config(
    _state: State<'_, SportIdentState>,
) -> Result<StationPayload, String> {
    Err("si_read_station_config: control channel not yet wired (follow-up to step 5)".into())
}

#[cfg(test)]
mod tauri_payload_tests {
    use super::*;
    use crate::sportident::cards::CardType;

    #[test]
    fn card_payload_serializes_with_camelcase_and_string_time() {
        let card = Card {
            card_id: 1_500_000,
            card_type: CardType::Si9,
            check: None,
            start: Some(Punch { code: 0, time_seconds: 35_900 }),
            finish: None,
            punches: vec![Punch { code: 31, time_seconds: 36_000 }],
        };
        let json = serde_json::to_value(&CardPayload::from(card)).unwrap();
        assert_eq!(json["cardId"], 1_500_000);
        assert_eq!(json["cardType"], "SI9");
        assert_eq!(json["start"]["time"], "09:58:20");
        assert!(json["finish"].is_null());
        assert_eq!(json["punches"][0]["code"], 31);
        assert_eq!(json["punches"][0]["time"], "10:00:00");
    }

    #[test]
    fn station_payload_uses_camelcase() {
        let info = StationInfo {
            station_number: 42,
            mode: 5,
            extended: true,
            auto_send: false,
            handshake: false,
        };
        let json = serde_json::to_value(&StationPayload::from(info)).unwrap();
        assert_eq!(json["stationNumber"], 42);
        assert_eq!(json["mode"], 5);
        assert_eq!(json["extended"], true);
        assert_eq!(json["autoSend"], false);
        assert_eq!(json["handshake"], false);
    }

    #[test]
    fn port_payload_hex_encodes_vid_pid() {
        let info = PortInfo {
            device_id: "COM3".into(),
            label: "Silicon Labs CP210x".into(),
            vendor_id: Some(0x10c4),
            product_id: Some(0x800a),
            manufacturer: Some("Silicon Labs".into()),
        };
        let json = serde_json::to_value(&PortPayload::from(info)).unwrap();
        assert_eq!(json["deviceId"], "COM3");
        assert_eq!(json["vendorId"], "10c4");
        assert_eq!(json["productId"], "800a");
    }

    #[test]
    fn port_payload_handles_missing_vid_pid() {
        let info = PortInfo {
            device_id: "COM5".into(),
            label: "Generic Serial".into(),
            vendor_id: None,
            product_id: None,
            manufacturer: None,
        };
        let json = serde_json::to_value(&PortPayload::from(info)).unwrap();
        assert!(json["vendorId"].is_null());
        assert!(json["productId"].is_null());
    }

    #[test]
    fn reader_state_names_match_documented_strings() {
        // These strings cross the Tauri boundary into TS — any change
        // here must be reflected in sportidentService.ts (step 6).
        assert_eq!(reader_state_name(&ReaderState::Idle), "idle");
        assert_eq!(reader_state_name(&ReaderState::Awakening), "awakening");
        assert_eq!(reader_state_name(&ReaderState::Listening), "listening");
        assert_eq!(reader_state_name(&ReaderState::Reading), "reading");
        assert_eq!(reader_state_name(&ReaderState::Error), "error");
        assert_eq!(reader_state_name(&ReaderState::Stopped), "stopped");
    }

    #[test]
    fn resync_reason_names_match_documented_strings() {
        assert_eq!(
            resync_reason_name(&ResyncReason::UnexpectedByteBeforeStx),
            "unexpected-byte-before-stx"
        );
        assert_eq!(resync_reason_name(&ResyncReason::BadCrc), "bad-crc");
        assert_eq!(resync_reason_name(&ResyncReason::BadEtx), "bad-etx");
    }

    #[test]
    fn event_names_are_stable() {
        // Lock-in test: changing these strings without coordinating with
        // the JS surface will silently break event delivery.
        assert_eq!(EVT_READER_STATE, "si://reader-state");
        assert_eq!(EVT_STATION_DETECTED, "si://station-detected");
        assert_eq!(EVT_CARD_READ, "si://card-read");
        assert_eq!(EVT_DECODER_RESYNC, "si://decoder-resync");
        assert_eq!(EVT_ERROR, "si://error");
    }
}
