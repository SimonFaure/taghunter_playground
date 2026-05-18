// Desktop SerialTransport implementation backed by tokio-serial.
//
// Single tokio task per open port owns the SerialStream and multiplexes
// reads + writes via tokio::select. This is intentionally different from
// src-tauri/src/serialport/desktop.rs which uses std::thread + mpsc:
//
//   - The new reader is event-driven (root cause #3 in the plan: the legacy
//     code's 200 ms polling loop missed notification frames). Bytes are
//     pushed into a tokio mpsc the instant they arrive from the OS, no
//     deliberate sleeps anywhere on the read path.
//   - Closing = dropping the `write_tx` sender. The owning task sees
//     `writer_rx.recv()` return None and exits, which drops the
//     SerialStream and releases the OS handle.
//
// The legacy serialport module keeps shipping in parallel; this file does
// not touch it. Both go away in step 7.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::sync::Arc;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use bytes::Bytes;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tokio::sync::mpsc;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tokio_serial::SerialPortBuilderExt;

use super::{BytesRx, PortInfo, SerialTransport, TransportError};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Debug)]
pub struct DesktopTransport {
    /// Carries write requests to the owner task. Bounded — back-pressures a
    /// runaway caller and lets us drop the transport without leaking
    /// memory.
    write_tx: mpsc::Sender<Vec<u8>>,
    /// Explicit close signal. Decoupled from `write_tx` so a slow writer
    /// can't delay shutdown, and so `close()` works even when there are
    /// other live `Arc<DesktopTransport>` clones holding `write_tx` open.
    close_tx: mpsc::Sender<()>,
    open: Arc<AtomicBool>,
    /// Owner-task `JoinHandle`. `close()` awaits this so the caller knows
    /// the SerialStream has been dropped and the OS handle released by
    /// the time `close().await` returns. Without this, a fast restart
    /// (`stop()` then `start()` on the same port) races the previous
    /// task's teardown and the second open fails with "access denied"
    /// on Windows.
    ///
    /// `tokio::sync::Mutex<Option<...>>` so the handle can be taken
    /// once across `&self`. After the first close, subsequent calls
    /// are no-ops.
    task_handle: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn open(
    device_id: &str,
    baud: u32,
) -> Result<(Arc<DesktopTransport>, BytesRx), TransportError> {
    // 8N1 — SI master default. data_bits/stop_bits/parity are explicit even
    // though they match tokio-serial's defaults, so the wire config is
    // documented in one place.
    let stream = tokio_serial::new(device_id, baud)
        .data_bits(tokio_serial::DataBits::Eight)
        .stop_bits(tokio_serial::StopBits::One)
        .parity(tokio_serial::Parity::None)
        .flow_control(tokio_serial::FlowControl::None)
        .open_native_async()
        .map_err(|e| TransportError::Other(format!("open {}: {}", device_id, e)))?;

    let (rx_tx, rx_rx) = mpsc::unbounded_channel::<Result<Bytes, TransportError>>();
    // Bounded so a runaway producer can't OOM us. 32 pending frames is well
    // above the steady-state throughput (one notify + a handful of 0xEF
    // blocks per second).
    let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>(32);
    let (close_tx, close_rx) = mpsc::channel::<()>(1);

    let open = Arc::new(AtomicBool::new(true));
    let open_for_task = open.clone();

    let task = tokio::spawn(owner_task(stream, write_rx, close_rx, rx_tx, open_for_task));

    Ok((
        Arc::new(DesktopTransport {
            write_tx,
            close_tx,
            open,
            task_handle: tokio::sync::Mutex::new(Some(task)),
        }),
        rx_rx,
    ))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn owner_task(
    mut stream: tokio_serial::SerialStream,
    mut write_rx: mpsc::Receiver<Vec<u8>>,
    mut close_rx: mpsc::Receiver<()>,
    rx_tx: mpsc::UnboundedSender<Result<Bytes, TransportError>>,
    open: Arc<AtomicBool>,
) {
    let mut buf = vec![0u8; 4096];
    loop {
        tokio::select! {
            // biased: explicit close takes priority over pending writes,
            // which take priority over reads. Without this, a steady stream
            // of incoming bytes could starve writes / delay teardown.
            biased;

            close_signal = close_rx.recv() => {
                // Either an explicit close() or all close_tx clones dropped
                // — both mean "wind down". No emitted Err: the consumer
                // asked for this.
                let _ = close_signal;
                break;
            }

            write_req = write_rx.recv() => {
                match write_req {
                    Some(bytes) => {
                        if let Err(e) = stream.write_all(&bytes).await {
                            let _ = rx_tx.send(Err(TransportError::Io(e)));
                            break;
                        }
                        if let Err(e) = stream.flush().await {
                            let _ = rx_tx.send(Err(TransportError::Io(e)));
                            break;
                        }
                    }
                    // All Arc<DesktopTransport> clones gone — implicit
                    // shutdown via Drop.
                    None => break,
                }
            }

            read_res = stream.read(&mut buf) => {
                match read_res {
                    Ok(0) => {
                        // EOF on a serial port = the OS lost the device
                        // (USB unplug). Tell the consumer, then exit.
                        let _ = rx_tx.send(Err(TransportError::Closed));
                        break;
                    }
                    Ok(n) => {
                        if rx_tx.send(Ok(Bytes::copy_from_slice(&buf[..n]))).is_err() {
                            // Consumer dropped the BytesRx — no point
                            // continuing.
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = rx_tx.send(Err(TransportError::Io(e)));
                        break;
                    }
                }
            }
        }
    }

    open.store(false, Ordering::SeqCst);
    // Dropping `stream` here releases the OS handle.
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[async_trait::async_trait]
impl SerialTransport for DesktopTransport {
    async fn write(&self, bytes: &[u8]) -> Result<(), TransportError> {
        if !self.open.load(Ordering::SeqCst) {
            return Err(TransportError::NotOpen);
        }
        self.write_tx
            .send(bytes.to_vec())
            .await
            .map_err(|_| TransportError::NotOpen)
    }

    async fn close(&self) -> Result<(), TransportError> {
        // Flipping `open` first means a racing write() sees NotOpen before
        // the task actually winds down.
        self.open.store(false, Ordering::SeqCst);
        // `try_send` (not `await`): the channel is bounded to 1 and one
        // pending close-signal is sufficient. If the task has already
        // exited, the send fails silently — that's the desired idempotency.
        let _ = self.close_tx.try_send(());
        // Wait for the owner task to actually return — at which point
        // `stream` has been dropped and the OS handle released. This is
        // the synchronisation that lets a caller `close()` then
        // immediately `open()` the same port without an "access denied"
        // race on Windows. First close awaits the JoinHandle; subsequent
        // closes find `None` and return immediately.
        let mut guard = self.task_handle.lock().await;
        if let Some(handle) = guard.take() {
            // Errors here would mean the task panicked — log but don't
            // propagate; the port handle is still released either way.
            if let Err(e) = handle.await {
                eprintln!("[sportident] owner task panicked: {}", e);
            }
        }
        Ok(())
    }

    fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }
}

/// Desktop port enumeration. Uses the `serialport` crate (which tokio-serial
/// also re-exports), filtering down to a stable PortInfo shape.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn list_ports() -> Result<Vec<PortInfo>, TransportError> {
    // The underlying call is blocking but fast (no I/O on the wire). Run it
    // on the blocking pool so we don't hold a worker thread.
    tokio::task::spawn_blocking(|| -> Result<Vec<PortInfo>, TransportError> {
        let ports = serialport::available_ports()
            .map_err(|e| TransportError::Other(e.to_string()))?;
        Ok(ports
            .into_iter()
            .map(|p| {
                let (vid, pid, manufacturer) = match p.port_type {
                    serialport::SerialPortType::UsbPort(info) => {
                        (Some(info.vid), Some(info.pid), info.manufacturer)
                    }
                    _ => (None, None, None),
                };
                PortInfo {
                    device_id: p.port_name.clone(),
                    label: p.port_name,
                    vendor_id: vid,
                    product_id: pid,
                    manufacturer,
                }
            })
            .collect())
    })
    .await
    .map_err(|e| TransportError::Other(format!("spawn_blocking: {}", e)))?
}

// Mobile builds compile this file but the real implementations live in
// transport/android.rs (step 8 of the plan). Provide no-op stubs so the
// trait is still nameable from cross-platform code.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn list_ports() -> Result<Vec<PortInfo>, TransportError> {
    Err(TransportError::Other("desktop list_ports called on mobile".into()))
}

#[cfg(test)]
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn list_ports_returns_ok_even_when_empty() {
        // Doesn't matter whether ports exist on the CI/host machine — we
        // only assert the enumeration succeeds and returns a (possibly
        // empty) Vec. On a dev box with a CP210x plugged in, this will
        // include the SI master station; CI typically returns nothing.
        let ports = list_ports().await.expect("enumeration must succeed");
        // Sanity-check shape: device_id non-empty when present.
        for p in &ports {
            assert!(!p.device_id.is_empty(), "device_id must be non-empty: {:?}", p);
        }
    }

    #[tokio::test]
    async fn open_on_nonexistent_port_errors() {
        // No real SI master needed: just confirm we surface a useful error.
        // The exact OS message differs between platforms, so we only assert
        // the error variant, not the string contents.
        let result = open("/tmp/definitely-not-a-real-port-12345", 38400).await;
        match result {
            Err(TransportError::Other(_)) => {}
            other => panic!("expected Other(_), got {:?}", other),
        }
    }
}
