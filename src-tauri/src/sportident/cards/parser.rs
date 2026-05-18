// Shared readout-buffer parser. Works against the assembled buffer that
// the reader (step 4) hands us after concatenating `blocks_to_read()`
// responses.
//
// All offsets are confirmed against:
//   - MeOS SportIdent.cpp `getCard9Data` / parseable header at bytes 8-22
//   - sportident-rs `protocol/card_blocks/readout.rs`
//   - legacy lib.js `SICard.parse` (which only handles SI9 but uses the
//     same header layout)
//
// The header (bytes 0..56) is identical across every supported card
// type — only `punches_offset` differs.

use super::layout::{LAYOUTS, PUNCH_RECORD_LEN};
use super::{Card, CardType, ParseError, Punch};

// Header byte positions (constant across SI8/9/10/11).
const CHECK_PUNCH_OFFSET: usize = 8;
const START_PUNCH_OFFSET: usize = 12;
const FINISH_PUNCH_OFFSET: usize = 16;
const PUNCH_COUNT_BYTE: usize = 22;
const CARD_ID_HI_BYTE: usize = 25; // bytes 25..28 = card id, big-endian 3-byte

/// Sentinel byte patterns that mean "empty punch slot" rather than a real
/// record. SI8/9 cards leave 0xEE in unused slots; SI10/11/SIAC zero
/// them. Either pattern → `None`.
fn is_empty_punch(b: &[u8; PUNCH_RECORD_LEN]) -> bool {
    *b == [0xEE; 4] || *b == [0x00; 4]
}

/// Decode a 4-byte regular punch record.
///
/// Byte layout (matches sportident-rs's `Punch::decode_punch`):
///   data[0] (ptd, "punch time date"):
///     bit 0     — PM flag (12-hour pivot). If set, add 12h to seconds.
///     bits 1-3  — day-of-week (0=Mon). We discard.
///     bits 4-5  — week counter (0=first). We discard.
///     bits 6-7  — high 2 bits of the control number (10-bit codes 0..1023).
///   data[1]    — low byte of the control number.
///   data[2..4] — 16-bit big-endian seconds within the 12-hour pivot.
///
/// `None` for sentinel/empty slots; real punches always produce `Some`.
fn decode_punch(data: [u8; PUNCH_RECORD_LEN]) -> Option<Punch> {
    if is_empty_punch(&data) {
        return None;
    }

    let ptd = data[0];
    let pm = (ptd & 0x01) != 0;
    let code_low = data[1] as u16;
    let code_high = ((ptd & 0b1100_0000) as u16) << 2; // bits 6-7 → bits 8-9
    let code = code_low | code_high;

    let seconds_in_12h = ((data[2] as u32) << 8) | (data[3] as u32);
    let time_seconds = seconds_in_12h + if pm { 12 * 3600 } else { 0 };

    Some(Punch { code, time_seconds })
}

/// Decode start/finish/check punch from the fixed header positions.
///
/// Start and finish slots additionally carry sub-second precision in
/// data[1] (1/256 s). We currently discard it: the legacy JS exposed it
/// only as a fractional-tenth fudge factor and no consumer reads it. If
/// a downstream feature ever needs subsecond timing, plumb it through
/// `Punch` (add a field) — the data is here.
///
/// `data[1]` is **not** a control-number byte for these slots, so we
/// don't pass it into `decode_punch` directly: instead, take the time
/// bytes (data[2..4]) and the PM flag (data[0] bit 0) and synthesise a
/// Punch with code=0.
fn decode_start_finish(data: [u8; PUNCH_RECORD_LEN]) -> Option<Punch> {
    if is_empty_punch(&data) {
        return None;
    }
    let pm = (data[0] & 0x01) != 0;
    let seconds_in_12h = ((data[2] as u32) << 8) | (data[3] as u32);
    let time_seconds = seconds_in_12h + if pm { 12 * 3600 } else { 0 };
    Some(Punch { code: 0, time_seconds })
}

pub fn parse_card_readout(card_type: CardType, data: &[u8]) -> Result<Card, ParseError> {
    let layout = LAYOUTS[card_type as usize];

    // Need at least the header + punches_offset bytes to make any sense
    // of the readout. The reader (step 4) won't hand us a short buffer
    // in practice — every block-read completes before assembly — but
    // we'd rather error cleanly than panic-index.
    let header_end = PUNCH_COUNT_BYTE + 1;
    if data.len() < header_end.max(CARD_ID_HI_BYTE + 3) {
        return Err(ParseError::BufferTooShort {
            needed: CARD_ID_HI_BYTE + 3,
            got: data.len(),
        });
    }

    let claimed_punches = data[PUNCH_COUNT_BYTE] as usize;
    if claimed_punches > layout.max_punches {
        // Suspect garbage — better to refuse than emit a bogus card.
        return Err(ParseError::PunchCountOutOfRange {
            card_type,
            claimed: claimed_punches,
        });
    }

    let punches_end = layout.punches_offset + claimed_punches * PUNCH_RECORD_LEN;
    if data.len() < punches_end {
        return Err(ParseError::BufferTooShort {
            needed: punches_end,
            got: data.len(),
        });
    }

    // Card ID: 3-byte big-endian at bytes 25..28. High byte is always
    // 0 for SI8/9/10/11 in the readout — the ID space spec'd by SI fits
    // in 24 bits.
    let card_id = ((data[CARD_ID_HI_BYTE] as u32) << 16)
        | ((data[CARD_ID_HI_BYTE + 1] as u32) << 8)
        | (data[CARD_ID_HI_BYTE + 2] as u32);

    let read4 = |off: usize| -> [u8; 4] {
        [data[off], data[off + 1], data[off + 2], data[off + 3]]
    };

    let check = decode_punch(read4(CHECK_PUNCH_OFFSET));
    let start = decode_start_finish(read4(START_PUNCH_OFFSET));
    let finish = decode_start_finish(read4(FINISH_PUNCH_OFFSET));

    let mut punches = Vec::with_capacity(claimed_punches);
    for i in 0..claimed_punches {
        let off = layout.punches_offset + i * PUNCH_RECORD_LEN;
        if let Some(p) = decode_punch(read4(off)) {
            punches.push(p);
        }
        // Sentinel records anywhere within the claimed range are
        // dropped silently — matches legacy behaviour.
    }

    Ok(Card {
        card_id,
        card_type,
        check,
        start,
        finish,
        punches,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: build a 256-byte SI9 readout with the given fields. Bytes
    /// not explicitly set stay 0x00.
    fn make_si9_buffer(
        card_id: u32,
        punches: &[(u16, u32, bool)],     // (code, time_seconds, pm)
        start: Option<(u32, bool)>,
        finish: Option<(u32, bool)>,
        check: Option<(u16, u32, bool)>,
    ) -> Vec<u8> {
        let mut buf = vec![0u8; 256];
        // Card ID at 25..28 (BE)
        buf[25] = ((card_id >> 16) & 0xFF) as u8;
        buf[26] = ((card_id >> 8) & 0xFF) as u8;
        buf[27] = (card_id & 0xFF) as u8;
        // Punch count
        buf[22] = punches.len() as u8;
        // Helper to write a punch record.
        let write_punch = |buf: &mut Vec<u8>, off: usize, code: u16, time_sec: u32, pm: bool| {
            let secs_in_12h = if pm { time_sec - 12 * 3600 } else { time_sec };
            let code_low = (code & 0xFF) as u8;
            let code_high = ((code >> 8) & 0x03) as u8; // 2-bit high
            let mut ptd = (code_high << 6) | if pm { 0x01 } else { 0x00 };
            // day/week bits left at 0
            buf[off] = ptd as u8;
            // For start/finish (code==0) byte 1 is subsecond, irrelevant here.
            buf[off + 1] = code_low;
            buf[off + 2] = ((secs_in_12h >> 8) & 0xFF) as u8;
            buf[off + 3] = (secs_in_12h & 0xFF) as u8;
            // silence unused-let-mut warning when only PM is set
            ptd |= 0;
        };
        if let Some((code, t, pm)) = check {
            write_punch(&mut buf, 8, code, t, pm);
        }
        if let Some((t, pm)) = start {
            write_punch(&mut buf, 12, 0, t, pm);
        }
        if let Some((t, pm)) = finish {
            write_punch(&mut buf, 16, 0, t, pm);
        }
        for (i, &(code, t, pm)) in punches.iter().enumerate() {
            // SI9 punches start at offset 56.
            write_punch(&mut buf, 56 + i * 4, code, t, pm);
        }
        buf
    }

    /// Helper: build a 640-byte SI11 readout. Layout is identical for the
    /// header bytes (0..56) — what differs is `punches_offset = 128`.
    fn make_si11_buffer(
        card_id: u32,
        punches: &[(u16, u32, bool)],
    ) -> Vec<u8> {
        let mut buf = vec![0u8; 640];
        buf[25] = ((card_id >> 16) & 0xFF) as u8;
        buf[26] = ((card_id >> 8) & 0xFF) as u8;
        buf[27] = (card_id & 0xFF) as u8;
        buf[22] = punches.len() as u8;
        for (i, &(code, t, pm)) in punches.iter().enumerate() {
            let secs_in_12h = if pm { t - 12 * 3600 } else { t };
            let code_low = (code & 0xFF) as u8;
            let code_high = ((code >> 8) & 0x03) as u8;
            let off = 128 + i * 4;
            buf[off] = (code_high << 6) | if pm { 0x01 } else { 0x00 };
            buf[off + 1] = code_low;
            buf[off + 2] = ((secs_in_12h >> 8) & 0xFF) as u8;
            buf[off + 3] = (secs_in_12h & 0xFF) as u8;
        }
        buf
    }

    #[test]
    fn empty_punch_sentinels_decode_to_none() {
        assert!(decode_punch([0xEE, 0xEE, 0xEE, 0xEE]).is_none());
        assert!(decode_punch([0x00, 0x00, 0x00, 0x00]).is_none());
        // 0xEE in only some bytes does NOT count as empty — only the full
        // pattern. This matches legacy behaviour.
        assert!(decode_punch([0xEE, 0x00, 0xEE, 0x00]).is_some());
    }

    #[test]
    fn decode_punch_handles_pm_flag() {
        // 14:30:00 = 13:30:00 after subtracting 12h → 48600s in 12h pivot.
        // Wait: 14:30:00 = 14*3600 + 30*60 = 52200s wall clock.
        //       In 12h pivot, that's 52200 - 43200 = 9000s, PM=true.
        let punch = decode_punch([0x01, 0x42, 0x23, 0x28]).unwrap();
        //                         pm,   code, seconds-in-12h=9000=0x2328
        assert_eq!(punch.code, 0x42);
        assert_eq!(punch.time_seconds, 52200);
        assert_eq!(punch.time_hms(), "14:30:00");
    }

    #[test]
    fn decode_punch_extracts_10bit_code() {
        // Code = 1023 (0x3FF). High 2 bits → ptd bits 6-7 = 0b11. Low byte = 0xFF.
        let punch = decode_punch([0b1100_0000, 0xFF, 0x00, 0x64]).unwrap();
        assert_eq!(punch.code, 1023);
        assert_eq!(punch.time_seconds, 100);
    }

    #[test]
    fn card_type_from_id_covers_each_range() {
        assert_eq!(CardType::from_card_id(2_500_000), Some(CardType::Si8));
        assert_eq!(CardType::from_card_id(1_234_567), Some(CardType::Si9));
        assert_eq!(CardType::from_card_id(7_654_321), Some(CardType::Si10));
        assert_eq!(CardType::from_card_id(9_999_999), Some(CardType::Si11));
        // Out of range / unsupported types.
        assert_eq!(CardType::from_card_id(8_500_000), None); // SIAC — not yet
        assert_eq!(CardType::from_card_id(123), None);
        assert_eq!(CardType::from_card_id(20_000_000), None);
    }

    #[test]
    fn layouts_have_consistent_blocks_and_offsets() {
        // Sanity: blocks_to_read length × 128 ≥ punches_offset + max*4.
        for ct in [CardType::Si8, CardType::Si9, CardType::Si10, CardType::Si11] {
            let buf_size = ct.blocks_to_read().len() * 128;
            let needed = ct.punches_offset() + ct.max_punches() * 4;
            assert!(
                buf_size >= needed,
                "{}: buffer {} < needed {}",
                ct,
                buf_size,
                needed
            );
        }
    }

    #[test]
    fn parse_si9_with_no_punches() {
        let buf = make_si9_buffer(1_234_567, &[], None, None, None);
        let card = Card::parse(CardType::Si9, &buf).unwrap();
        assert_eq!(card.card_id, 1_234_567);
        assert_eq!(card.card_type, CardType::Si9);
        assert!(card.punches.is_empty());
        assert!(card.start.is_none());
        assert!(card.finish.is_none());
        assert!(card.check.is_none());
    }

    #[test]
    fn parse_si9_with_two_punches_and_start_finish() {
        let buf = make_si9_buffer(
            1_500_000,
            &[(31, 36_000, false), (32, 36_120, false)], // 10:00:00 + 10:02:00
            Some((35_900, false)),                       // start 09:58:20
            Some((36_300, false)),                       // finish 10:05:00
            None,
        );
        let card = Card::parse(CardType::Si9, &buf).unwrap();
        assert_eq!(card.card_id, 1_500_000);
        assert_eq!(card.punches.len(), 2);
        assert_eq!(card.punches[0].code, 31);
        assert_eq!(card.punches[0].time_hms(), "10:00:00");
        assert_eq!(card.punches[1].code, 32);
        assert_eq!(card.punches[1].time_hms(), "10:02:00");
        assert_eq!(card.start.unwrap().time_hms(), "09:58:20");
        assert_eq!(card.finish.unwrap().time_hms(), "10:05:00");
    }

    #[test]
    fn parse_si11_with_many_punches() {
        // 70 punches across the buffer — exercises the SI10/11 punches_offset=128.
        let punches: Vec<_> = (0..70)
            .map(|i| (100 + i as u16, 36_000 + (i as u32) * 60, false))
            .collect();
        let buf = make_si11_buffer(9_876_543, &punches);
        let card = Card::parse(CardType::Si11, &buf).unwrap();
        assert_eq!(card.card_id, 9_876_543);
        assert_eq!(card.card_type, CardType::Si11);
        assert_eq!(card.punches.len(), 70);
        assert_eq!(card.punches[0].code, 100);
        assert_eq!(card.punches[69].code, 169);
        // Spot-check time formatting at index 30: 10:00:00 + 30*60s = 10:30:00
        assert_eq!(card.punches[30].time_hms(), "10:30:00");
    }

    #[test]
    fn parse_rejects_oversize_punch_count() {
        let mut buf = make_si9_buffer(1_500_000, &[], None, None, None);
        buf[22] = 60; // SI9 max is 50
        let err = Card::parse(CardType::Si9, &buf).unwrap_err();
        assert!(matches!(
            err,
            ParseError::PunchCountOutOfRange {
                card_type: CardType::Si9,
                claimed: 60
            }
        ));
    }

    #[test]
    fn parse_rejects_short_buffer() {
        let buf = vec![0u8; 20]; // way too short
        let err = Card::parse(CardType::Si9, &buf).unwrap_err();
        assert!(matches!(err, ParseError::BufferTooShort { .. }));
    }

    #[test]
    fn parse_drops_sentinel_punches_within_claimed_range() {
        // Claim 3 punches but only 2 have real data — sentinel slot in
        // the middle should be filtered out.
        let mut buf = make_si9_buffer(
            1_500_000,
            &[(31, 36_000, false), (0, 0, false), (33, 36_120, false)],
            None,
            None,
            None,
        );
        // Overwrite slot 1 with the all-0xEE sentinel.
        for j in 0..4 {
            buf[56 + 4 + j] = 0xEE;
        }
        let card = Card::parse(CardType::Si9, &buf).unwrap();
        // Sentinel slot dropped; we get 2 punches, not 3.
        assert_eq!(card.punches.len(), 2);
        assert_eq!(card.punches[0].code, 31);
        assert_eq!(card.punches[1].code, 33);
    }
}
