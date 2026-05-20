// SI command-frame builders. Every byte the reader sends to the master
// flows through these. Kept stateless — no dependency on transport, no
// async — so they're trivial to test in isolation and to call from
// anywhere in the reader.

use crate::sportident::config::{
    ACK, CMD_GET_SI9_DATA, CMD_GET_SYSTEM_DATA, CMD_SET_MS_MODE, CMD_SET_STATION_TIME,
};
use crate::sportident::framing::{build_frame, build_wakeup_frame};

/// "Set MS mode" wakeup frame. Prefixed with 0xFF, payload `[0x4D]` =
/// ASCII 'M' = direct (master/host) mode. The 0xFF wakes the master from
/// idle-sleep; the frame configures it to forward 0xE8 card-inserted
/// notifications to the host instead of beeping locally.
pub fn build_wakeup() -> Vec<u8> {
    build_wakeup_frame(CMD_SET_MS_MODE, &[0x4D])
}

/// "Get system data" probe. Asks the master for its config block (number,
/// mode, firmware, etc.). Payload `[block, count]` — we request block 0
/// (system config) of 128 bytes. The 0x83 response triggers
/// `StationDetected` in the reader.
pub fn build_get_system_data() -> Vec<u8> {
    build_frame(CMD_GET_SYSTEM_DATA, &[0x00, 0x80])
}

/// "Get SI card data" — request one 128-byte block from the inserted
/// card. Block indices come from `CardType::blocks_to_read()`.
pub fn build_get_card_block(block: u8) -> Vec<u8> {
    build_frame(CMD_GET_SI9_DATA, &[block])
}

/// ACK byte — single 0x06, not a framed message. Sent after a complete
/// card readout; the master beeps + lights up confirmation and accepts
/// card removal. Without this, the master holds the card in "just read"
/// state and may not detect the next insertion cleanly.
pub fn build_ack() -> Vec<u8> {
    vec![ACK]
}

/// "Set station time" — sync master clock. Payload format per SI manual:
///   [year, month, day, day-of-week, hour, minute, second, fraction]
/// Year is 2-digit (year - 2000); fraction is 1/256 s.
///
/// Caller passes a (yy, mm, dd, dow, hh, mn, ss) tuple — converting from
/// a chrono DateTime is the Tauri command's job (step 5), keeping this
/// module free of date-time deps.
// Frame builder ready (and unit-tested) ahead of its step-5 caller, the
// `si_set_station_time` control channel.
#[allow(dead_code)]
pub fn build_set_time(yy: u8, mm: u8, dd: u8, dow: u8, hh: u8, mn: u8, ss: u8) -> Vec<u8> {
    build_frame(
        CMD_SET_STATION_TIME,
        &[yy, mm, dd, dow, hh, mn, ss, 0x00],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sportident::config::{ETX, STX, WAKEUP};

    #[test]
    fn wakeup_starts_with_ff_and_set_ms_mode_payload() {
        let f = build_wakeup();
        assert_eq!(f[0], WAKEUP);
        assert_eq!(f[1], STX);
        assert_eq!(f[2], CMD_SET_MS_MODE);
        assert_eq!(f[3], 0x01); // LEN = 1
        assert_eq!(f[4], 0x4D); // payload byte = 'M'
        assert_eq!(*f.last().unwrap(), ETX);
    }

    #[test]
    fn get_system_data_matches_legacy_byte_sequence() {
        // Same wire bytes as the legacy SendReadRequest. Verified against
        // crc.rs `even_length_input_matches_meos` vector.
        let f = build_get_system_data();
        assert_eq!(
            f,
            vec![STX, CMD_GET_SYSTEM_DATA, 0x02, 0x00, 0x80, 0xBF, 0x17, ETX]
        );
    }

    #[test]
    fn get_card_block_encodes_block_number() {
        let f = build_get_card_block(3);
        assert_eq!(f[0], STX);
        assert_eq!(f[1], CMD_GET_SI9_DATA);
        assert_eq!(f[2], 0x01); // LEN = 1
        assert_eq!(f[3], 0x03); // requested block
        assert_eq!(*f.last().unwrap(), ETX);
    }

    #[test]
    fn ack_is_a_single_byte() {
        assert_eq!(build_ack(), vec![ACK]);
    }

    #[test]
    fn set_time_packs_8_byte_payload() {
        let f = build_set_time(26, 5, 12, 1, 14, 30, 45);
        // STX + CMD + LEN(8) + 8 payload + CRC(2) + ETX = 14
        assert_eq!(f.len(), 14);
        assert_eq!(f[2], 8);
        assert_eq!(&f[3..11], &[26, 5, 12, 1, 14, 30, 45, 0]);
    }
}
