// Per-card-type constants. Kept in their own file so adding a new card
// family is one row in each of these tables plus a CardType variant.

/// Bytes per block (128). Hard-coded throughout the SI protocol — every
/// 0xEF block read returns exactly this many bytes.
pub const BLOCK_SIZE: usize = 128;

#[derive(Debug, Clone, Copy)]
pub struct CardLayout {
    /// Byte offset within the assembled readout buffer where the punch
    /// array starts. Each punch is `PUNCH_RECORD_LEN` bytes long.
    pub punches_offset: usize,
    /// Maximum value of the `punch_count` byte (data[22]) we'll trust
    /// before treating the readout as corrupt.
    pub max_punches: usize,
}

/// Punch records are always 4 bytes on every supported card type.
pub const PUNCH_RECORD_LEN: usize = 4;

/// Indexed by `CardType as usize`. Order MUST match the enum declaration
/// in `mod.rs` — keep them in lockstep.
pub const LAYOUTS: [CardLayout; 4] = [
    // Si8 — 2 blocks (256 bytes), punches start at 136 → (256-136)/4 = 30 max.
    CardLayout { punches_offset: 136, max_punches: 30 },
    // Si9 — 2 blocks (256 bytes), punches start at 56 → (256-56)/4 = 50 max.
    CardLayout { punches_offset: 56, max_punches: 50 },
    // Si10 — 5 blocks (640 bytes), punches start at 128 → enough room for
    // (640-128)/4 = 128 records, but real SI10 cards cap at 64.
    CardLayout { punches_offset: 128, max_punches: 64 },
    // Si11 — same buffer shape as Si10, hardware allows 128 punches.
    CardLayout { punches_offset: 128, max_punches: 128 },
];

/// Block numbers the reader feeds to cmd 0xEF, in concatenation order.
/// Indexed by `CardType as usize`.
///
/// SI8/9 layout is contiguous from block 0. SI10/11 layout puts the
/// metadata in block 3 and punches in blocks 4-7 (block 1+2 hold owner
/// data we don't currently care about; block 0 holds factory data).
pub const BLOCKS_TO_READ: [&[u8]; 4] = [
    &[0, 1],          // Si8
    &[0, 1],          // Si9
    &[3, 4, 5, 6, 7], // Si10
    &[3, 4, 5, 6, 7], // Si11
];
