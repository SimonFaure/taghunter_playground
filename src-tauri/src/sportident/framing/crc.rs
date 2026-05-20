// CRC-16/SportIdent — word-oriented, polynomial 0x8005.
//
// Bit-for-bit port of `SportIdent::calcCRC` in MeOS SportIdent.cpp. The
// legacy JS (src/lib/lib.js calcCRC) is also a faithful port of the same
// algorithm — so frames produced here CRC-match what the existing app
// already sends on the wire. Verified by cross-checking the MeOS source
// via WebFetch on 2026-05-12.
//
// Quirks worth knowing:
//   - Inputs < 2 bytes return 0 (per spec).
//   - Inputs of exactly 2 bytes return the bytes as a big-endian u16 with
//     no mixing — there is no polynomial pass.
//   - Even-length inputs (> 2) get an implicit trailing zero word in the
//     last mix iteration: `count >> 1` iterations are run; the last one
//     uses `value = 0` when `count` is even. This is intentional, not a
//     bug — every SI implementation in the wild does this.
//   - Odd-length inputs > 2 pack the trailing byte into the high byte of
//     the last `value` word (low byte = 0).

/// Compute CRC-16/SI over `data`. Mirrors MeOS `calcCRC` exactly.
pub fn calc_crc(data: &[u8]) -> u16 {
    let count = data.len();
    if count < 2 {
        return 0;
    }
    let mut index = 0usize;
    let mut crc: u16 = ((data[0] as u16) << 8) | (data[1] as u16);
    index += 2;
    if count == 2 {
        return crc;
    }

    // `count >> 1` iterations, counting down. Mirrors `for (k = count>>1; k>0; k--)`.
    let mut k = count >> 1;
    while k > 0 {
        let mut value: u16 = if k > 1 {
            let v = ((data[index] as u16) << 8) | (data[index + 1] as u16);
            index += 2;
            v
        } else if count & 1 == 1 {
            // Odd remainder: trailing byte in the high half of the last word.
            (data[index] as u16) << 8
        } else {
            // Even input: implicit trailing-zero word.
            0
        };

        for _ in 0..16 {
            if crc & 0x8000 != 0 {
                crc = crc.wrapping_shl(1);
                if value & 0x8000 != 0 {
                    crc = crc.wrapping_add(1);
                }
                crc ^= 0x8005;
            } else {
                crc = crc.wrapping_shl(1);
                if value & 0x8000 != 0 {
                    crc = crc.wrapping_add(1);
                }
            }
            value = value.wrapping_shl(1);
        }

        k -= 1;
    }

    crc
}

/// Split a 16-bit CRC into the (high, low) byte pair as it sits on the wire.
#[inline]
pub fn crc_bytes(crc: u16) -> (u8, u8) {
    ((crc >> 8) as u8, (crc & 0xFF) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_single_byte_return_zero() {
        assert_eq!(calc_crc(&[]), 0);
        assert_eq!(calc_crc(&[0xAA]), 0);
    }

    #[test]
    fn two_bytes_return_them_as_big_endian_word_no_mixing() {
        // Per spec, no polynomial pass for length==2.
        assert_eq!(calc_crc(&[0x12, 0x34]), 0x1234);
        assert_eq!(calc_crc(&[0xFF, 0xFF]), 0xFFFF);
        assert_eq!(calc_crc(&[0x00, 0x00]), 0x0000);
    }

    #[test]
    fn wakeup_payload_matches_meos_jsoutput() {
        // [0xF0, 0x01, 0x4D] — the "set MS mode" payload that wakes the
        // SI master. Odd length, exercises the last-byte-in-high-half
        // branch. The legacy JS calcCRC produces this exact value on the
        // same input (hand-traced 2026-05-12) and the resulting wakeup
        // frame is what reliably wakes real SI masters in production.
        assert_eq!(calc_crc(&[0xF0, 0x01, 0x4D]), 0x6D0A);
    }

    #[test]
    fn even_length_input_matches_meos() {
        // [0x83, 0x02, 0x00, 0x80] — the "read system data" command frame
        // (CMD + LEN + 2-byte payload). Even length, exercises the
        // implicit-trailing-zero-word branch. Lock-in regression test:
        // if this value changes, the decoder will mismatch real SI master
        // responses.
        assert_eq!(calc_crc(&[0x83, 0x02, 0x00, 0x80]), 0xBF17);
    }

    #[test]
    fn crc_bytes_packs_high_then_low() {
        assert_eq!(crc_bytes(0x1234), (0x12, 0x34));
        assert_eq!(crc_bytes(0xFFFF), (0xFF, 0xFF));
        assert_eq!(crc_bytes(0x00FF), (0x00, 0xFF));
    }
}
