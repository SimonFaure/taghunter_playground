// MockTransport — in-memory SerialTransport for hardware-free integration
// tests of the reader state machine (step 4 onwards).
//
// Usage shape:
//   let (mock, mut rx) = MockTransport::new();
//   mock.inject_rx(&[0x02, 0x83, ...]);       // simulate a station frame
//   reader.start(mock.clone() as _).await?;   // pumps from `rx`
//   ...
//   assert_eq!(mock.captured_tx(), expected);  // assert what reader sent

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::mpsc;

use super::{BytesRx, SerialTransport, TransportError};

pub struct MockTransport {
    /// None once the transport is closed (signals "the producer is gone" to
    /// the BytesRx consumer).
    rx_sender: Mutex<Option<mpsc::UnboundedSender<Result<Bytes, TransportError>>>>,
    /// Append-only log of every byte the caller has written. Tests read this
    /// to assert protocol commands.
    tx_log: Mutex<Vec<u8>>,
    open: AtomicBool,
}

impl MockTransport {
    pub fn new() -> (Arc<Self>, BytesRx) {
        let (tx, rx) = mpsc::unbounded_channel();
        let this = Arc::new(MockTransport {
            rx_sender: Mutex::new(Some(tx)),
            tx_log: Mutex::new(Vec::new()),
            open: AtomicBool::new(true),
        });
        (this, rx)
    }

    /// Simulate the peer sending bytes to us. Bytes appear in the same
    /// chunking the caller passes here — tests use this to assert the
    /// decoder is robust to fragmentation (1-byte chunks vs full frames).
    pub fn inject_rx(&self, bytes: &[u8]) {
        if let Some(tx) = self.rx_sender.lock().unwrap().as_ref() {
            // Bytes::copy_from_slice — owned snapshot, safe across awaits.
            let _ = tx.send(Ok(Bytes::copy_from_slice(bytes)));
        }
    }

    /// Simulate the underlying device returning a hard error mid-stream.
    /// Used to test ErrorRecovery transitions in the reader state machine.
    pub fn inject_error(&self, err: TransportError) {
        if let Some(tx) = self.rx_sender.lock().unwrap().as_ref() {
            let _ = tx.send(Err(err));
        }
    }

    /// Snapshot of all bytes the caller has written so far.
    pub fn captured_tx(&self) -> Vec<u8> {
        self.tx_log.lock().unwrap().clone()
    }

    /// Reset the tx log between phases of a test.
    pub fn clear_tx_log(&self) {
        self.tx_log.lock().unwrap().clear();
    }
}

#[async_trait::async_trait]
impl SerialTransport for MockTransport {
    async fn write(&self, bytes: &[u8]) -> Result<(), TransportError> {
        if !self.open.load(Ordering::SeqCst) {
            return Err(TransportError::NotOpen);
        }
        self.tx_log.lock().unwrap().extend_from_slice(bytes);
        Ok(())
    }

    async fn close(&self) -> Result<(), TransportError> {
        self.open.store(false, Ordering::SeqCst);
        // Drop the sender so the BytesRx side sees the channel close on its
        // next .recv().
        *self.rx_sender.lock().unwrap() = None;
        Ok(())
    }

    fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn round_trip_write_is_captured() {
        let (mock, _rx) = MockTransport::new();
        mock.write(&[0x02, 0x83, 0xFF]).await.unwrap();
        mock.write(&[0xAA]).await.unwrap();
        assert_eq!(mock.captured_tx(), vec![0x02, 0x83, 0xFF, 0xAA]);
    }

    #[tokio::test]
    async fn injected_rx_arrives_in_order() {
        let (mock, mut rx) = MockTransport::new();
        mock.inject_rx(&[0x02, 0x83]);
        mock.inject_rx(&[0xE8, 0x06]);

        let first = rx.recv().await.unwrap().unwrap();
        assert_eq!(&first[..], &[0x02, 0x83]);
        let second = rx.recv().await.unwrap().unwrap();
        assert_eq!(&second[..], &[0xE8, 0x06]);
    }

    #[tokio::test]
    async fn close_makes_rx_terminate_and_writes_fail() {
        let (mock, mut rx) = MockTransport::new();
        mock.inject_rx(&[0xAA]);
        mock.close().await.unwrap();

        // The one buffered chunk is still delivered…
        let first = rx.recv().await.unwrap().unwrap();
        assert_eq!(&first[..], &[0xAA]);
        // …then the channel closes.
        assert!(rx.recv().await.is_none());

        // Writes after close are rejected.
        match mock.write(&[0xBB]).await {
            Err(TransportError::NotOpen) => {}
            other => panic!("expected NotOpen, got {:?}", other),
        }
        assert!(!mock.is_open());
    }

    #[tokio::test]
    async fn injected_error_propagates() {
        let (mock, mut rx) = MockTransport::new();
        mock.inject_error(TransportError::Closed);

        match rx.recv().await {
            Some(Err(TransportError::Closed)) => {}
            other => panic!("expected Err(Closed), got {:?}", other),
        }
    }

    #[tokio::test]
    async fn clear_tx_log_resets_capture() {
        let (mock, _rx) = MockTransport::new();
        mock.write(&[0x01, 0x02]).await.unwrap();
        assert_eq!(mock.captured_tx(), vec![0x01, 0x02]);
        mock.clear_tx_log();
        assert!(mock.captured_tx().is_empty());
        mock.write(&[0x03]).await.unwrap();
        assert_eq!(mock.captured_tx(), vec![0x03]);
    }
}
