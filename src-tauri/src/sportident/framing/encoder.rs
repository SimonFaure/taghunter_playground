// Frame encoder. Stateless — every command builder in commands.rs (step 4)
// ultimately funnels through here.

use crate::sportident::config::{ETX, STX, WAKEUP};
use super::crc::{calc_crc, crc_bytes};

/// Build a wire-format SI extended frame.
///
/// `payload.len()` must fit in a u8 (≤ 255). All commands we care about
/// (SI8-11 era) stay well below that — the longest is `0xEF` block read
/// at 128 payload bytes per block.
///
/// Layout: `[STX | cmd | len | payload | CRC_HI | CRC_LO | ETX]`
/// (no DLE byte-stuffing — extended protocol uses the length byte to bound
/// the payload, avoiding the need to escape STX/ETX bytes that appear in
/// data.)
pub fn build_frame(cmd: u8, payload: &[u8]) -> Vec<u8> {
    assert!(
        payload.len() <= 255,
        "SI extended frame payload exceeds 255 bytes ({})",
        payload.len()
    );
    let mut buf = Vec::with_capacity(payload.len() + 6);
    buf.push(STX);
    buf.push(cmd);
    buf.push(payload.len() as u8);
    buf.extend_from_slice(payload);
    let (h, l) = crc_bytes(calc_crc(&buf[1..])); // CRC over CMD + LEN + payload
    buf.push(h);
    buf.push(l);
    buf.push(ETX);
    buf
}

/// Wakeup-prefixed frame. The SI master idle-sleeps after ~10 s; a single
/// 0xFF byte before the frame brings it back up before the rest of the
/// payload arrives. The legacy JS sent this only once at session start
/// (root cause #2 in the plan: master fell asleep, cards stopped
/// triggering). The reader (step 4) re-uses this builder every
/// `REWAKEUP_INTERVAL_MS`.
pub fn build_wakeup_frame(cmd: u8, payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(payload.len() + 7);
    buf.push(WAKEUP);
    buf.extend(build_frame(cmd, payload));
    buf
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sportident::config::{CMD_GET_SYSTEM_DATA, CMD_SET_MS_MODE};

    #[test]
    fn frame_has_expected_shape() {
        let f = build_frame(0x83, &[0x00, 0x80]);
        // STX + CMD + LEN=2 + 2 payload + 2 CRC + ETX = 8 bytes
        assert_eq!(f.len(), 8);
        assert_eq!(f[0], STX);
        assert_eq!(f[1], 0x83);
        assert_eq!(f[2], 0x02);
        assert_eq!(&f[3..5], &[0x00, 0x80]);
        assert_eq!(f[7], ETX);
    }

    #[test]
    fn wakeup_frame_prepends_ff() {
        let f = build_wakeup_frame(CMD_SET_MS_MODE, &[0x4D]);
        assert_eq!(f[0], WAKEUP);
        assert_eq!(f[1], STX);
        assert_eq!(f[2], CMD_SET_MS_MODE);
    }

    #[test]
    fn empty_payload_is_allowed() {
        let f = build_frame(0xA0, &[]);
        // STX + CMD + LEN=0 + CRC_H + CRC_L + ETX = 6 bytes
        assert_eq!(f.len(), 6);
        assert_eq!(f[2], 0);
    }

    #[test]
    #[should_panic]
    fn oversize_payload_panics() {
        let big = vec![0u8; 256];
        let _ = build_frame(0xA0, &big);
    }

    #[test]
    fn read_system_data_frame_matches_legacy_wire_bytes() {
        // [STX, 0x83, 0x02, 0x00, 0x80, CRC_H, CRC_L, ETX].
        // The exact wire bytes the legacy `SendReadRequest()` sends — and
        // since the legacy code does successfully read station config in
        // the field today, this is a known-good golden vector.
        let f = build_frame(CMD_GET_SYSTEM_DATA, &[0x00, 0x80]);
        // Lock in: any change to CRC algorithm or framing would break this.
        assert_eq!(
            f,
            vec![STX, 0x83, 0x02, 0x00, 0x80, 0xBF, 0x17, ETX],
            "frame: {:02X?}",
            f
        );
    }
}
