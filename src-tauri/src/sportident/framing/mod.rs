// Frame-level protocol primitives. Stateless and hardware-free.
//
// Wire format (SportIdent extended protocol, length-prefixed; no DLE
// stuffing because we only target SI8/9/10/11 — DLE is a legacy SI5/6
// concern).
//
//   [STX | CMD | LEN | payload(LEN bytes) | CRC_HI | CRC_LO | ETX]
//   bytes:   1    1    1        LEN              1       1     1
//
// CRC is computed over `CMD + LEN + payload` (LEN+2 bytes), big-endian.
//
// The decoder is a streaming state machine: callers push raw bytes from
// the serial port whenever they arrive (any chunking) and pull
// `DecodeEvent`s. Resync rule on validation failure: drop the leading
// STX and rescan — this is what the legacy reader was missing (root cause
// #1 in the plan: once buffer alignment was lost, every subsequent peek
// was garbage with no recovery path).

pub mod crc;
pub mod decoder;
pub mod encoder;

pub use decoder::{DecodeEvent, Decoder, ResyncReason};
pub use encoder::{build_frame, build_wakeup_frame};

/// A validated SI protocol frame as it lives in memory after framing
/// removes the STX/CRC/ETX wrapper.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub cmd: u8,
    pub payload: bytes::Bytes,
}
