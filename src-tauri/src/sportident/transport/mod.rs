// SerialTransport — minimal async surface so the reader state machine
// (step 4) can be written against an abstract port and tested via
// MockTransport without hardware.
//
// Why such a small trait surface (write/close/is_open):
//   - The RX path is naturally a one-way producer/consumer. Returning a
//     `Stream` from a trait method runs into ownership / `Self: Sized`
//     awkwardness (only one consumer can take it; lifetimes infect callers).
//     Instead, each impl's constructor returns `(Arc<Self>, BytesRx)` — the
//     caller owns the receiver end of an mpsc channel that the impl's
//     internal task pushes into. Closes when the impl's task drops the
//     sender.
//   - `list_ports()` is a static, platform-dispatched free function below.
//     Putting it on the trait would force `Self: Sized` and a turbofish at
//     every call site for no gain.

pub mod desktop;
pub mod mock;

use std::fmt;

#[derive(Debug)]
pub enum TransportError {
    Io(std::io::Error),
    /// Caller tried to write/close a port that was never opened or already
    /// closed (legitimately or due to disconnect).
    NotOpen,
    /// Underlying port returned EOF / 0-byte read. On real hardware this
    /// usually means the USB cable was unplugged.
    Closed,
    /// Catch-all for platform-specific failures we don't want to model
    /// individually (tokio-serial open errors, mdns plumbing, etc.).
    Other(String),
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TransportError::Io(e) => write!(f, "io error: {}", e),
            TransportError::NotOpen => write!(f, "port not open"),
            TransportError::Closed => write!(f, "port closed unexpectedly"),
            TransportError::Other(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for TransportError {}

impl From<std::io::Error> for TransportError {
    fn from(e: std::io::Error) -> Self {
        TransportError::Io(e)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortInfo {
    pub device_id: String,
    pub label: String,
    pub vendor_id: Option<u16>,
    pub product_id: Option<u16>,
    pub manufacturer: Option<String>,
}

/// Stream of raw RX chunks from a SerialTransport, terminated by either
/// `None` (channel closed cleanly) or a final `Err(_)` item before close.
pub type BytesRx = tokio::sync::mpsc::UnboundedReceiver<Result<bytes::Bytes, TransportError>>;

#[async_trait::async_trait]
pub trait SerialTransport: Send + Sync + 'static {
    /// Blocking-from-the-caller-perspective write. Resolves only after the
    /// bytes have been handed to the OS layer (or the platform plugin).
    async fn write(&self, bytes: &[u8]) -> Result<(), TransportError>;

    /// Idempotent. After `close()`, subsequent writes return
    /// `TransportError::NotOpen` and the corresponding `BytesRx` closes.
    async fn close(&self) -> Result<(), TransportError>;

    fn is_open(&self) -> bool;
}

/// Platform-dispatched port enumeration. Desktop hits the OS via
/// `serialport::available_ports()`; Android (step 8) will hit the Tauri 2
/// mobile plugin. Returns an empty Vec rather than an error when no ports
/// are visible — matches what the JS layer expects today.
pub async fn list_ports() -> Result<Vec<PortInfo>, TransportError> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        desktop::list_ports().await
    }
    #[cfg(target_os = "ios")]
    {
        Err(TransportError::Other("ios not supported".into()))
    }
    #[cfg(target_os = "android")]
    {
        // Wired up in step 8 of the plan. Until then, the new reader simply
        // can't enumerate ports on Android. Old `serialport_list` path keeps
        // working in parallel for legacy callers.
        Err(TransportError::Other("android transport not yet implemented".into()))
    }
}
