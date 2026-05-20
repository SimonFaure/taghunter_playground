// SportIdent protocol constants. Sources cross-checked against MeOS
// SportIdent.cpp and the sportident-rs crate. Card scope is SI8/SI9/SI10/SI11
// (extended protocol, length-prefixed, no DLE byte-stuffing).

// Framing bytes.
pub const WAKEUP: u8 = 0xFF;
pub const STX: u8 = 0x02;
pub const ETX: u8 = 0x03;
pub const ACK: u8 = 0x06;
/// Negative-acknowledge byte. Kept for protocol completeness — the
/// decoder does not act on NAK yet.
#[allow(dead_code)]
pub const NAK: u8 = 0x15;

// Command codes (extended protocol only).
pub const CMD_SET_MS_MODE: u8 = 0xF0; // wakeup payload
pub const CMD_GET_SYSTEM_DATA: u8 = 0x83; // station config probe
pub const CMD_CARD_INSERTED: u8 = 0xE8; // master → host notification
pub const CMD_GET_SI9_DATA: u8 = 0xEF; // host → master block read
// Consumed only by `build_set_time`, which is itself pending the step-5
// set-station-time control channel.
#[allow(dead_code)]
pub const CMD_SET_STATION_TIME: u8 = 0xF6;

// Serial line. 38400 8N1 is the SI master default for extended mode.
pub const DEFAULT_BAUD: u32 = 38400;

// SI master idle-sleeps after ~10 s of no traffic. We resend the wakeup at
// 7 s to keep a 3 s safety margin — root cause #2 in the plan (wakeup was
// sent exactly once in the legacy code, so cards silently stopped triggering
// once the master dozed off).
pub const REWAKEUP_INTERVAL_MS: u64 = 7_000;

// How long to wait for a station response after wakeup before retrying.
// Handshake-retry tuning — not yet consumed by the reader state machine.
#[allow(dead_code)]
pub const STATION_HANDSHAKE_TIMEOUT_MS: u64 = 3_000;
#[allow(dead_code)]
pub const STATION_HANDSHAKE_MAX_RETRIES: u32 = 3;
