// Card-type-aware parsing of an assembled readout buffer.
//
// Scope per the plan: SI8 / SI9 / SI10 / SI11 only. SIAC, pCard, and the
// legacy SI5/SI6 families are deliberately out of scope — adding them
// later is purely a matter of extending CardType + the layout table.
//
// Offsets and block-numbering rules verified against the open-source
// sportident-rs crate (Apache-2.0; see plans/let-s-work-on-the-flickering-leaf.md).
// We do not depend on it — it owns the serial port and so doesn't fit our
// transport abstraction — but its byte-level layout has been used against
// real hardware for years and matches what MeOS does.

pub mod layout;
pub mod parser;

use std::fmt;

pub use layout::CardLayout;

/// Subset of SportIdent card families we currently support.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CardType {
    Si8,
    Si9,
    Si10,
    Si11,
}

impl CardType {
    /// Map a card ID (3-byte big-endian, 0..16_777_215) to a card type.
    ///
    /// Ranges come from the SI manufacturing scheme and are stable —
    /// every card sold in a given decade has a number in exactly one of
    /// these slots. `None` means either an unknown range (SIAC, pCard, …
    /// not yet supported) or an out-of-spec value.
    ///
    /// Why ID-based detection over the legacy `series byte` approach:
    /// the series byte (lo-nibble of buf[24]) lumps SI10 and SI11 into
    /// the same value, so we'd need the ID anyway to distinguish them.
    /// One source of truth, fewer ways to be wrong.
    pub fn from_card_id(id: u32) -> Option<Self> {
        match id {
            1_000_000..=1_999_999 => Some(Self::Si9),
            2_000_000..=2_999_999 => Some(Self::Si8),
            7_000_000..=7_999_999 => Some(Self::Si10),
            9_000_000..=9_999_999 => Some(Self::Si11),
            _ => None,
        }
    }

    /// Block numbers the reader should request via cmd 0xEF, in the order
    /// they get concatenated into the readout buffer. SI8/9 fit in two
    /// blocks; SI10/11 spread metadata + punches across five non-
    /// contiguous blocks (3..=7), so we skip 0..=2.
    pub fn blocks_to_read(self) -> &'static [u8] {
        layout::BLOCKS_TO_READ[self as usize]
    }

    /// Byte offset (within the assembled readout buffer) at which the
    /// punch array starts. Per-type:
    ///   SI8:136 / SI9:56 / SI10:128 / SI11:128
    pub fn punches_offset(self) -> usize {
        layout::LAYOUTS[self as usize].punches_offset
    }

    /// Cap on the `punch_count` byte (data[22]) for this card type.
    /// A real card never reports more than this; if `data[22]` exceeds
    /// it, we treat the readout as corrupt rather than parse garbage.
    pub fn max_punches(self) -> usize {
        layout::LAYOUTS[self as usize].max_punches
    }

    /// Display name as used in the Tauri event payload (`type` field on
    /// `si://card-read`). Matches the legacy TS shape so the JS surface
    /// can render unchanged.
    pub fn name(self) -> &'static str {
        match self {
            Self::Si8 => "SI8",
            Self::Si9 => "SI9",
            Self::Si10 => "SI10",
            Self::Si11 => "SI11",
        }
    }
}

impl fmt::Display for CardType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// Single timing record. We don't keep subsecond precision yet — the UI
/// displays HH:MM:SS, and the JS interface only has `time: string`.
/// Bump this to `u32` of 1/10-seconds (or add a subseconds field) the
/// day someone needs sub-second accuracy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Punch {
    /// Control number, 0..1023 (10-bit). Beacon controls share this
    /// space — they aren't separately flagged in the output.
    pub code: u16,
    /// Wall-clock seconds since 00:00, 0..86_399.
    pub time_seconds: u32,
}

impl Punch {
    /// Format as "HH:MM:SS" matching what the legacy JS surface emits in
    /// `CardData.punches[].time`.
    pub fn time_hms(&self) -> String {
        let h = self.time_seconds / 3600;
        let m = (self.time_seconds % 3600) / 60;
        let s = self.time_seconds % 60;
        format!("{:02}:{:02}:{:02}", h, m, s)
    }
}

/// Fully-parsed card readout. This is the producer side of the
/// `si://card-read` Tauri event payload (step 5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Card {
    pub card_id: u32,
    pub card_type: CardType,
    pub check: Option<Punch>,
    pub start: Option<Punch>,
    pub finish: Option<Punch>,
    pub punches: Vec<Punch>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// Readout buffer is shorter than the per-type minimum (i.e. fewer
    /// blocks arrived than expected — likely a transport failure between
    /// the 0xEF block reads).
    BufferTooShort { needed: usize, got: usize },
    /// `data[22]` exceeded `max_punches()` for this type. Either the
    /// buffer is corrupt or we got the type wrong from the notification
    /// frame. The reader surfaces this as `si://error{kind:'parse'}` and
    /// leaves the state machine in `Listening`.
    PunchCountOutOfRange { card_type: CardType, claimed: usize },
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BufferTooShort { needed, got } => {
                write!(f, "readout buffer too short: need {} bytes, got {}", needed, got)
            }
            Self::PunchCountOutOfRange { card_type, claimed } => write!(
                f,
                "{} card reports {} punches, exceeds max for type",
                card_type, claimed
            ),
        }
    }
}

impl std::error::Error for ParseError {}

impl Card {
    /// Parse a fully-assembled readout buffer. Caller is responsible for
    /// driving the 0xEF block reads, concatenating responses in the
    /// order `card_type.blocks_to_read()` returns, and trimming each
    /// block to 128 bytes.
    pub fn parse(card_type: CardType, readout: &[u8]) -> Result<Card, ParseError> {
        parser::parse_card_readout(card_type, readout)
    }
}
