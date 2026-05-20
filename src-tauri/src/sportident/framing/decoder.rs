// Streaming SI frame decoder.
//
// Consumes raw RX bytes as they arrive from the serial transport (any
// chunk size, including 1-byte chunks) and emits `DecodeEvent`s. The
// decoder is the protocol-level fix for root cause #1 in the plan:
// legacy code peeked into the byte buffer at fixed offsets assuming
// alignment, with no recovery once a frame boundary was lost. Here the
// state is implicit in *which bytes are still in the work buffer*, so a
// bad frame just costs us a single dropped byte before we look for the
// next STX.
//
// Resync rule: on any validation failure (bad CRC, missing ETX, oversized
// LEN considered invalid by a higher layer — not enforced here), drop the
// leading STX and rescan. WAKEUP (0xFF) bytes before a frame are skipped
// silently; they're a known protocol artifact, not corruption.

use std::collections::VecDeque;

use crate::sportident::config::{ETX, STX, WAKEUP};
use super::crc::calc_crc;
use super::Frame;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResyncReason {
    /// A byte before any STX that isn't a WAKEUP. Most likely line noise
    /// or the tail of a previously-corrupted frame.
    UnexpectedByteBeforeStx,
    /// We had a candidate frame with the expected length but the CRC
    /// didn't match.
    BadCrc,
    /// Frame ended with a byte other than ETX. Almost always means the
    /// LEN byte was wrong — i.e. the STX we picked was a false positive.
    BadEtx,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeEvent {
    Frame(Frame),
    /// One byte dropped from the work buffer during resync. Surfaced
    /// individually so the reader can log/meter corruption without losing
    /// information.
    Resync { dropped: u8, reason: ResyncReason },
}

#[derive(Debug, Default)]
pub struct Decoder {
    /// Pending bytes received from the wire. We don't consume any of
    /// these until we have a *full* candidate frame to validate — that
    /// way a partial frame can wait across many push() calls without
    /// changing the decoder's state machine.
    buf: VecDeque<u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed bytes into the decoder. Emitted events are appended to `out`
    /// so the caller can scratch a Vec rather than allocate one per call.
    pub fn push(&mut self, bytes: &[u8], out: &mut Vec<DecodeEvent>) {
        self.buf.extend(bytes.iter().copied());
        self.try_decode(out);
    }

    /// Drain as many frames / resync events as possible from the work
    /// buffer. Stops when the buffer is short of a full frame or the
    /// first byte is the start of a valid (but incomplete) frame.
    fn try_decode(&mut self, out: &mut Vec<DecodeEvent>) {
        'outer: loop {
            // ── Phase 1: skip wakeup + scan for STX. ───────────────────
            while let Some(&head) = self.buf.front() {
                if head == STX {
                    break;
                }
                let dropped = self.buf.pop_front().unwrap();
                if dropped != WAKEUP {
                    out.push(DecodeEvent::Resync {
                        dropped,
                        reason: ResyncReason::UnexpectedByteBeforeStx,
                    });
                }
            }
            if self.buf.is_empty() {
                return;
            }
            // self.buf[0] is STX from here.

            // ── Phase 2: need at least CMD + LEN to know frame size. ───
            if self.buf.len() < 3 {
                return;
            }
            let cmd = self.buf[1];
            let len = self.buf[2] as usize;
            // Full frame length: STX + CMD + LEN + payload + CRC(2) + ETX
            let total = 4 + len + 2;
            if self.buf.len() < total {
                return;
            }

            // ── Phase 3: validate CRC + ETX. ───────────────────────────
            let crc_h = self.buf[3 + len];
            let crc_l = self.buf[3 + len + 1];
            let etx = self.buf[3 + len + 2];
            let expected_crc = ((crc_h as u16) << 8) | (crc_l as u16);

            // CRC input = CMD + LEN + payload (the bytes between STX and CRC).
            // Materialise once to feed `calc_crc` which wants a slice.
            let crc_input: Vec<u8> = self.buf.range(1..3 + len).copied().collect();
            let computed = calc_crc(&crc_input);

            // BadEtx takes priority over BadCrc when both fail: a wrong
            // ETX strongly suggests the LEN byte was bogus, i.e. the STX
            // we picked was a false positive — log accordingly.
            if etx != ETX {
                let dropped = self.buf.pop_front().unwrap();
                out.push(DecodeEvent::Resync {
                    dropped,
                    reason: ResyncReason::BadEtx,
                });
                continue 'outer;
            }
            if computed != expected_crc {
                let dropped = self.buf.pop_front().unwrap();
                out.push(DecodeEvent::Resync {
                    dropped,
                    reason: ResyncReason::BadCrc,
                });
                continue 'outer;
            }

            // ── Phase 4: emit Frame, consume the bytes. ────────────────
            // Materialise the payload as `Bytes` so the downstream parser
            // can hold onto it without copying further.
            let mut payload = Vec::with_capacity(len);
            payload.extend(self.buf.range(3..3 + len).copied());
            for _ in 0..total {
                self.buf.pop_front();
            }
            out.push(DecodeEvent::Frame(Frame {
                cmd,
                payload: bytes::Bytes::from(payload),
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sportident::framing::encoder::{build_frame, build_wakeup_frame};

    /// Helper: feed all bytes in one go, return the events vec.
    fn decode_all(bytes: &[u8]) -> Vec<DecodeEvent> {
        let mut d = Decoder::new();
        let mut out = Vec::new();
        d.push(bytes, &mut out);
        out
    }

    /// Helper: feed bytes one-at-a-time, simulating fragmented arrivals.
    fn decode_one_at_a_time(bytes: &[u8]) -> Vec<DecodeEvent> {
        let mut d = Decoder::new();
        let mut out = Vec::new();
        for &b in bytes {
            d.push(&[b], &mut out);
        }
        out
    }

    #[test]
    fn decodes_a_single_clean_frame() {
        let frame = build_frame(0xE8, &[0xAA, 0xBB, 0xCC]);
        let events = decode_all(&frame);
        assert_eq!(events.len(), 1);
        match &events[0] {
            DecodeEvent::Frame(f) => {
                assert_eq!(f.cmd, 0xE8);
                assert_eq!(&f.payload[..], &[0xAA, 0xBB, 0xCC]);
            }
            other => panic!("expected Frame, got {:?}", other),
        }
    }

    #[test]
    fn feed_one_byte_at_a_time_yields_identical_events() {
        // Two back-to-back frames, plus a leading wakeup byte. The
        // fragmentation equivalence test is the strongest guarantee a
        // streaming decoder can give — if this passes, the decoder is
        // safe against any chunking the OS happens to deliver.
        let mut wire = vec![WAKEUP];
        wire.extend(build_frame(0xE8, &[0x01, 0x02, 0x03]));
        wire.extend(build_frame(0x83, &[0xFF]));

        let bulk = decode_all(&wire);
        let drip = decode_one_at_a_time(&wire);
        assert_eq!(bulk, drip, "fragmented feed must produce identical events");
        // And we should see exactly two frames + zero resync events
        // (wakeup is skipped silently).
        assert!(matches!(bulk[0], DecodeEvent::Frame(_)));
        assert!(matches!(bulk[1], DecodeEvent::Frame(_)));
        assert_eq!(bulk.len(), 2);
    }

    #[test]
    fn skips_wakeup_silently() {
        let mut wire = vec![WAKEUP, WAKEUP, WAKEUP];
        wire.extend(build_frame(0xE8, &[0xAA]));
        let events = decode_all(&wire);
        // No Resync events should fire for the leading wakeups.
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], DecodeEvent::Frame(_)));
    }

    #[test]
    fn unexpected_byte_before_stx_emits_resync() {
        // Garbage byte that's not WAKEUP nor STX before a valid frame.
        let mut wire = vec![0xAB];
        wire.extend(build_frame(0xE8, &[0xCD]));
        let events = decode_all(&wire);
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[0],
            DecodeEvent::Resync {
                dropped: 0xAB,
                reason: ResyncReason::UnexpectedByteBeforeStx
            }
        ));
        assert!(matches!(events[1], DecodeEvent::Frame(_)));
    }

    #[test]
    fn bad_crc_resyncs_and_recovers() {
        // Hand-crafted bad frame: payload bytes chosen so the LEN byte and
        // every other byte after the leading STX are NOT 0x02 (STX). Why
        // it matters: after dropping the leading STX during resync, the
        // decoder rescans for the next STX byte. If a payload/LEN byte
        // *happens* to be 0x02, the decoder locks onto it as a false STX,
        // then waits forever for an implied-length frame that will never
        // complete. Real-world streams hit this rarely (recovery takes
        // longer but eventually works as more bytes arrive); in a closed
        // unit test where no further bytes are pushed, we need to
        // engineer the bad bytes to avoid the trap.
        let bad: Vec<u8> = vec![
            STX,
            0xE8, // CMD
            0x03, // LEN (NB: not 0x02; not 0x03 either — wait, ETX is 0x03. Decoder doesn't scan for ETX in phase 1, only STX, so 0x03 in LEN is fine.)
            0x11, 0x33, 0x55, // payload — none equal 0x02
            0xAA, 0xBB, // CRC — deliberately wrong; will not match calc_crc(...)
            ETX,
        ];
        let mut wire = bad.clone();
        wire.extend(build_frame(0x83, &[0x99]));

        let events = decode_all(&wire);

        // Exactly one Frame (the second one) must come through; the first
        // chunk drops at least 1 Resync.
        let frames: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                DecodeEvent::Frame(f) => Some(f),
                _ => None,
            })
            .collect();
        let resyncs: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, DecodeEvent::Resync { .. }))
            .collect();

        assert_eq!(frames.len(), 1, "second frame must recover after resync");
        assert_eq!(frames[0].cmd, 0x83);
        assert!(!resyncs.is_empty(), "must emit at least one Resync event");
        // The very first resync should be BadCrc (the leading STX of the
        // corrupted frame).
        assert!(matches!(
            resyncs[0],
            DecodeEvent::Resync {
                dropped: STX,
                reason: ResyncReason::BadCrc
            }
        ));
    }

    #[test]
    fn bad_etx_resyncs_with_bad_etx_reason() {
        let mut bad = build_frame(0xE8, &[0xAA]);
        let etx_pos = bad.len() - 1;
        bad[etx_pos] = 0x99; // not ETX
        // Append a valid frame so we can confirm recovery.
        let mut wire = bad;
        wire.extend(build_frame(0x83, &[0xBB]));

        let events = decode_all(&wire);
        let first_resync = events
            .iter()
            .find_map(|e| match e {
                DecodeEvent::Resync { reason, .. } => Some(reason.clone()),
                _ => None,
            })
            .expect("must emit a Resync");
        assert_eq!(first_resync, ResyncReason::BadEtx);
        // And we recover.
        let frame_count = events
            .iter()
            .filter(|e| matches!(e, DecodeEvent::Frame(_)))
            .count();
        assert_eq!(frame_count, 1);
    }

    #[test]
    fn partial_frame_waits_for_more_bytes() {
        let frame = build_frame(0xE8, &[0xAA, 0xBB, 0xCC]);
        // Feed all but the last byte.
        let mut d = Decoder::new();
        let mut out = Vec::new();
        d.push(&frame[..frame.len() - 1], &mut out);
        assert!(out.is_empty(), "incomplete frame must yield no events");
        // Feed the missing ETX.
        d.push(&[ETX], &mut out);
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0], DecodeEvent::Frame(_)));
    }

    #[test]
    fn wakeup_prefixed_frame_decodes() {
        let wire = build_wakeup_frame(0xF0, &[0x01, 0x4D]);
        let events = decode_all(&wire);
        assert_eq!(events.len(), 1);
        match &events[0] {
            DecodeEvent::Frame(f) => {
                assert_eq!(f.cmd, 0xF0);
                assert_eq!(&f.payload[..], &[0x01, 0x4D]);
            }
            other => panic!("expected Frame, got {:?}", other),
        }
    }

    #[test]
    fn round_trip_multiple_frames_back_to_back() {
        let mut wire = Vec::new();
        let inputs = [
            (0xE8, vec![0x01, 0x02, 0x03]),
            (0x83, vec![]),
            (0xEF, vec![0xAA; 128]),
            (0xF0, vec![0x4D]),
        ];
        for (cmd, payload) in &inputs {
            wire.extend(build_frame(*cmd, payload));
        }
        let events = decode_all(&wire);
        assert_eq!(events.len(), inputs.len());
        for (event, (cmd, payload)) in events.iter().zip(inputs.iter()) {
            match event {
                DecodeEvent::Frame(f) => {
                    assert_eq!(f.cmd, *cmd);
                    assert_eq!(&f.payload[..], payload.as_slice());
                }
                other => panic!("expected Frame, got {:?}", other),
            }
        }
    }
}
