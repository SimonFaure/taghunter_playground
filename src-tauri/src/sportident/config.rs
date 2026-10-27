// SportIdent protocol constants. Sources cross-checked against MeOS
// SportIdent.cpp and the sportident-rs crate. Card scope is SI8/SI9/SI10/SI11
// (extended protocol, length-prefixed, no DLE byte-stuffing).

// Framing bytes.
pub const WAKEUP: u8 = 0xFF;
pub const STX: u8 = 0x02;
pub const ETX: u8 = 0x03;
pub const ACK: u8 = 0x06;
/// Negative-acknowledge byte. Kept for protocol completeness - the
/// decoder does not act on NAK yet.
#[allow(dead_code)]
pub const NAK: u8 = 0x15;

// Command codes (extended protocol only).
pub const CMD_SET_MS_MODE: u8 = 0xF0; // wakeup payload
pub const CMD_GET_SYSTEM_DATA: u8 = 0x83; // station config probe
pub const CMD_CARD_INSERTED: u8 = 0xE8; // master → host notification
pub const CMD_CARD_REMOVED: u8 = 0xE7; // master → host notification
pub const CMD_GET_SI9_DATA: u8 = 0xEF; // host → master block read
pub const CMD_BEEP: u8 = 0xF9; // host → master: beep N times (echoed back)
// Consumed only by `build_set_time`, which is itself pending the step-5
// set-station-time control channel.
#[allow(dead_code)]
pub const CMD_SET_STATION_TIME: u8 = 0xF6;

// Serial line. 38400 8N1 is the SI master default for extended mode.
pub const DEFAULT_BAUD: u32 = 38400;

// SI master idle-sleeps after ~10 s of no traffic. We resend the wakeup at
// 7 s to keep a 3 s safety margin - root cause #2 in the plan (wakeup was
// sent exactly once in the legacy code, so cards silently stopped triggering
// once the master dozed off).
pub const REWAKEUP_INTERVAL_MS: u64 = 7_000;

// While Awakening, resend wakeup + system-data probe at this cadence until
// the station answers. Measured from the last handshake WRITE, not from the
// last received byte: a sleeping master can swallow the first handshake
// while it wakes, and the player's own 0xE8 notifications must not push the
// retry back (field bug 2026-10-15: first bips after launch never beeped).
pub const HANDSHAKE_RETRY_MS: u64 = 500;

// A candidate frame (STX seen, rest still missing) older than this is a
// false STX. A whole SI frame arrives in one burst (137 bytes ≈ 36 ms at
// 38400), so anything still incomplete after 250 ms of silence never will be.
pub const STALE_PARTIAL_FRAME_MS: u64 = 250;

// Abort an in-flight card read when no 0xEF block reply arrives within this
// window (card pulled out mid-read, NAK, line noise). Without it the reader
// sat in Reading forever and ignored every later insertion.
pub const READ_BLOCK_TIMEOUT_MS: u64 = 1_500;
