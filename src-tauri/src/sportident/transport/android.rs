// Android SerialTransport - JNI bridge to
// gen/android/app/src/main/java/com/taghunter/playground/sportident/
// SportIdentSerial.kt.
//
// Architecture mirrors desktop.rs but the underlying I/O lives on the JVM:
//
//   Rust caller ───► open()/write()/close() ───► JNI ───► Kotlin static
//                                                          │
//                              ┌───────────────────────────┘
//                              ▼
//                       UsbSerialPort + SerialInputOutputManager
//                              │
//                              ▼  (background thread)
//                   Listener.onNewData(bytes) ───► nativeRxBytes JNI ───►
//                                                  router map (handle→mpsc)
//                                                  ───► BytesRx the caller
//                                                       owns
//
// Why a flat HashMap<i64, Sender<...>> instead of a per-port object owned by
// Rust: the JNI callback is invoked from Kotlin's RX executor thread; it has
// no way to pass a Rust pointer through, only the opaque Long handle that
// Kotlin minted on open(). The map is the rendezvous.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::sync::Arc;

use bytes::Bytes;
use jni::objects::{JByteArray, JClass, JObject, JString, JValue};
use jni::sys::jlong;
use jni::{JNIEnv, JavaVM};
use tokio::sync::mpsc;

use super::{BytesRx, PortInfo, SerialTransport, TransportError};

// ─── Global RX router ─────────────────────────────────────────────────

// One sender per open port, keyed by the Long handle Kotlin returns from
// open(). Stored in `std::sync::Mutex` (not tokio's) because the JNI callback
// is *not* on a tokio runtime thread - it runs on Kotlin's RX executor.
type RxTx = mpsc::UnboundedSender<Result<Bytes, TransportError>>;

fn router() -> &'static Mutex<HashMap<jlong, RxTx>> {
    static ROUTER: OnceLock<Mutex<HashMap<jlong, RxTx>>> = OnceLock::new();
    ROUTER.get_or_init(|| Mutex::new(HashMap::new()))
}

// ─── JNI exports ──────────────────────────────────────────────────────
//
// Symbol naming follows the JNI mangling rule: package separators become
// underscores, and the class containing the @JvmStatic method (the OUTER
// class, not the Companion) is the lookup root.

#[no_mangle]
pub extern "system" fn Java_com_taghunter_playground_sportident_SportIdentSerial_00024Companion_nativeRxBytes(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    bytes: JByteArray,
) {
    let buf = match env.convert_byte_array(&bytes) {
        Ok(v) => v,
        Err(_) => return,
    };
    if let Some(tx) = router().lock().unwrap().get(&handle) {
        // unbounded; failure here means the receiver was dropped - which is
        // fine, the port is being torn down.
        let _ = tx.send(Ok(Bytes::from(buf)));
    }
}

#[no_mangle]
pub extern "system" fn Java_com_taghunter_playground_sportident_SportIdentSerial_00024Companion_nativeRxError(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    message: JString,
) {
    let msg: String = env
        .get_string(&message)
        .map(|s| s.into())
        .unwrap_or_else(|_| "unknown rx error".to_string());
    if let Some(tx) = router().lock().unwrap().get(&handle) {
        let _ = tx.send(Err(TransportError::Other(msg)));
    }
}

#[no_mangle]
pub extern "system" fn Java_com_taghunter_playground_sportident_SportIdentSerial_00024Companion_nativeRxClosed(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    // Drop the sender → BytesRx surfaces end-of-stream. Send a final Closed
    // first so callers can distinguish "stopped cleanly" from "cable yanked".
    if let Some(tx) = router().lock().unwrap().remove(&handle) {
        let _ = tx.send(Err(TransportError::Closed));
    }
}

// ─── Rust → Kotlin call helpers ───────────────────────────────────────

fn vm() -> Result<JavaVM, TransportError> {
    let ctx = ndk_context::android_context();
    // Safety: ndk-context guarantees a valid JavaVM* once the app has run
    // through Tauri's JNI_OnLoad. We never null-check the result.
    let ptr = ctx.vm() as *mut jni::sys::JavaVM;
    unsafe { JavaVM::from_raw(ptr) }
        .map_err(|e| TransportError::Other(format!("attach jvm: {e}")))
}

fn app_context_jobject() -> jni::sys::jobject {
    ndk_context::android_context().context() as jni::sys::jobject
}

const CLASS: &str = "com/taghunter/playground/sportident/SportIdentSerial$Companion";
// Dotted (binary) name for ClassLoader.loadClass - NOT the slashed JNI form.
const OUTER_DOTTED: &str = "com.taghunter.playground.sportident.SportIdentSerial";

// Resolve an app class from a *native* (Rust-spawned) thread.
//
// JNI's FindClass uses the class loader of the calling thread. Threads we
// attach via AttachCurrentThread (every tokio spawn_blocking worker here) get
// the *system* class loader, which cannot see app classes - FindClass then
// throws ClassNotFoundException, and the unhandled pending exception aborts the
// thread (the on-device FATAL crash). So we go through the app's own class
// loader instead, obtained from the Android Context we already hold. This works
// from any thread because we name the loader explicitly rather than relying on
// the thread's implicit one. On failure we clear the pending JNI exception so a
// graceful Rust error surfaces instead of a process abort at detach time.
fn load_app_class<'a>(env: &mut JNIEnv<'a>, dotted: &str) -> Result<JClass<'a>, TransportError> {
    // On any JNI error, clear the pending Java exception so the eventual thread
    // detach doesn't abort the process, then surface a plain Rust error.
    fn fail(env: &mut JNIEnv, what: &str, e: jni::errors::Error) -> TransportError {
        let _ = env.exception_clear();
        TransportError::Other(format!("{what}: {e}"))
    }

    let ctx = unsafe { JObject::from_raw(app_context_jobject()) };

    let loader = match env
        .call_method(&ctx, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .and_then(|v| v.l())
    {
        Ok(l) => l,
        Err(e) => return Err(fail(env, "getClassLoader", e)),
    };

    let name = match env.new_string(dotted) {
        Ok(n) => n,
        Err(e) => return Err(fail(env, "new_string", e)),
    };

    let class = match env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&name)],
        )
        .and_then(|v| v.l())
    {
        Ok(c) => c,
        Err(e) => return Err(fail(env, &format!("loadClass {dotted}"), e)),
    };

    Ok(JClass::from(class))
}

// Helper: retrieve the singleton Companion object. @JvmStatic mirrors the
// method on the OUTER class too, but going through Companion keeps the call
// shape identical regardless of how Kotlin's compiler decides to expose it.
fn companion<'a>(env: &mut JNIEnv<'a>) -> Result<JObject<'a>, TransportError> {
    let outer = load_app_class(env, OUTER_DOTTED)?;
    let companion = env
        .get_static_field(&outer, "Companion", &format!("L{};", CLASS))
        .and_then(|v| v.l())
        .map_err(|e| TransportError::Other(format!("Companion field: {e}")))?;
    Ok(companion)
}

// ─── Port enumeration ─────────────────────────────────────────────────

pub async fn list_ports() -> Result<Vec<PortInfo>, TransportError> {
    tokio::task::spawn_blocking(list_ports_blocking)
        .await
        .map_err(|e| TransportError::Other(format!("spawn_blocking: {e}")))?
}

fn list_ports_blocking() -> Result<Vec<PortInfo>, TransportError> {
    let vm = vm()?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| TransportError::Other(format!("attach: {e}")))?;

    let companion = companion(&mut env)?;
    let ctx = unsafe { JObject::from_raw(app_context_jobject()) };
    let result = env
        .call_method(
            companion,
            "list",
            "(Landroid/content/Context;)[Ljava/lang/String;",
            &[JValue::Object(&ctx)],
        )
        .and_then(|v| v.l())
        .map_err(|e| TransportError::Other(format!("list call: {e}")))?;

    let arr: jni::objects::JObjectArray = result.into();
    let len = env
        .get_array_length(&arr)
        .map_err(|e| TransportError::Other(format!("array len: {e}")))?;
    // Flat triplet layout: [deviceId, label, manufacturer] per device.
    let mut out = Vec::with_capacity((len / 3) as usize);
    let mut i = 0;
    while i + 2 < len {
        let device_id = jstring_at(&mut env, &arr, i)?;
        let label = jstring_at(&mut env, &arr, i + 1)?;
        let manufacturer = jstring_at(&mut env, &arr, i + 2)?;
        out.push(PortInfo {
            device_id,
            label,
            // Filter is fixed CP210x in Kotlin; mirror those constants here
            // so the JS layer can rely on vendor_id/product_id being present.
            vendor_id: Some(0x10c4),
            product_id: Some(0x800a),
            manufacturer: Some(manufacturer),
        });
        i += 3;
    }
    Ok(out)
}

fn jstring_at(
    env: &mut JNIEnv,
    arr: &jni::objects::JObjectArray,
    idx: i32,
) -> Result<String, TransportError> {
    let obj = env
        .get_object_array_element(arr, idx)
        .map_err(|e| TransportError::Other(format!("arr[{idx}]: {e}")))?;
    let s: JString = obj.into();
    env.get_string(&s)
        .map(|js| js.into())
        .map_err(|e| TransportError::Other(format!("string at {idx}: {e}")))
}

// ─── AndroidTransport ─────────────────────────────────────────────────

#[derive(Debug)]
pub struct AndroidTransport {
    // The opaque Long handle Kotlin minted in open(); the owner task already
    // owns its own copy for write/close JNI calls, but keeping it here makes
    // Debug output identify which port this transport refers to (useful when
    // a future feature opens multiple readers).
    #[allow(dead_code)]
    handle: jlong,
    write_tx: mpsc::Sender<Vec<u8>>,
    close_tx: mpsc::Sender<()>,
    open: Arc<AtomicBool>,
    task_handle: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

pub async fn open(
    device_id: &str,
    baud: u32,
) -> Result<(Arc<AndroidTransport>, BytesRx), TransportError> {
    let device_id_owned = device_id.to_string();
    // Permission dialog + JNI open are blocking on the JVM side (the dialog
    // can sit on screen for up to 30 s); off-load from the tokio runtime.
    let handle = tokio::task::spawn_blocking(move || {
        request_permission_and_open(&device_id_owned, baud)
    })
    .await
    .map_err(|e| TransportError::Other(format!("spawn_blocking: {e}")))??;

    let (rx_tx, rx_rx) = mpsc::unbounded_channel::<Result<Bytes, TransportError>>();
    router().lock().unwrap().insert(handle, rx_tx);

    let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>(32);
    let (close_tx, close_rx) = mpsc::channel::<()>(1);
    let open_flag = Arc::new(AtomicBool::new(true));
    let open_for_task = open_flag.clone();

    let task = tokio::spawn(owner_task(handle, write_rx, close_rx, open_for_task));

    Ok((
        Arc::new(AndroidTransport {
            handle,
            write_tx,
            close_tx,
            open: open_flag,
            task_handle: tokio::sync::Mutex::new(Some(task)),
        }),
        rx_rx,
    ))
}

fn request_permission_and_open(device_id: &str, baud: u32) -> Result<jlong, TransportError> {
    let vm = vm()?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| TransportError::Other(format!("attach: {e}")))?;

    let companion = companion(&mut env)?;
    let ctx = unsafe { JObject::from_raw(app_context_jobject()) };
    let device_id_j = env
        .new_string(device_id)
        .map_err(|e| TransportError::Other(format!("new_string: {e}")))?;

    let granted = env
        .call_method(
            &companion,
            "requestPermission",
            "(Landroid/content/Context;Ljava/lang/String;)Z",
            &[JValue::Object(&ctx), JValue::Object(&device_id_j)],
        )
        .and_then(|v| v.z())
        .map_err(|e| TransportError::Other(format!("requestPermission: {e}")))?;
    if !granted {
        return Err(TransportError::Other("USB permission denied".into()));
    }

    let handle = env
        .call_method(
            &companion,
            "open",
            "(Landroid/content/Context;Ljava/lang/String;I)J",
            &[
                JValue::Object(&ctx),
                JValue::Object(&device_id_j),
                JValue::Int(baud as i32),
            ],
        )
        .and_then(|v| v.j())
        .map_err(|e| TransportError::Other(format!("open: {e}")))?;
    if handle == 0 {
        return Err(TransportError::Other(format!("open {device_id} failed")));
    }
    Ok(handle)
}

async fn owner_task(
    handle: jlong,
    mut write_rx: mpsc::Receiver<Vec<u8>>,
    mut close_rx: mpsc::Receiver<()>,
    open: Arc<AtomicBool>,
) {
    loop {
        tokio::select! {
            biased;
            _ = close_rx.recv() => break,
            maybe_bytes = write_rx.recv() => {
                let Some(bytes) = maybe_bytes else { break };
                if let Err(e) = blocking_write(handle, &bytes).await {
                    // A write failure here usually means the cable was
                    // unplugged; mark closed and exit. The RX side will see
                    // TransportError::Closed via nativeRxClosed shortly.
                    let _ = e;
                    break;
                }
            }
        }
    }
    open.store(false, Ordering::SeqCst);
    let _ = blocking_close(handle).await;
}

async fn blocking_write(handle: jlong, bytes: &[u8]) -> Result<(), TransportError> {
    let bytes = bytes.to_vec();
    tokio::task::spawn_blocking(move || jni_write(handle, &bytes))
        .await
        .map_err(|e| TransportError::Other(format!("spawn_blocking write: {e}")))?
}

fn jni_write(handle: jlong, bytes: &[u8]) -> Result<(), TransportError> {
    let vm = vm()?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| TransportError::Other(format!("attach: {e}")))?;
    let companion = companion(&mut env)?;
    let arr = env
        .byte_array_from_slice(bytes)
        .map_err(|e| TransportError::Other(format!("byte_array: {e}")))?;
    let ok = env
        .call_method(
            companion,
            "write",
            "(J[B)Z",
            &[JValue::Long(handle), JValue::Object(&arr)],
        )
        .and_then(|v| v.z())
        .map_err(|e| TransportError::Other(format!("write call: {e}")))?;
    if ok {
        Ok(())
    } else {
        Err(TransportError::Other("write returned false".into()))
    }
}

async fn blocking_close(handle: jlong) -> Result<(), TransportError> {
    tokio::task::spawn_blocking(move || jni_close(handle))
        .await
        .map_err(|e| TransportError::Other(format!("spawn_blocking close: {e}")))?
}

fn jni_close(handle: jlong) -> Result<(), TransportError> {
    let vm = vm()?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| TransportError::Other(format!("attach: {e}")))?;
    let companion = companion(&mut env)?;
    env.call_method(companion, "close", "(J)V", &[JValue::Long(handle)])
        .map_err(|e| TransportError::Other(format!("close call: {e}")))?;
    Ok(())
}

#[async_trait::async_trait]
impl SerialTransport for AndroidTransport {
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
        // Idempotent: first close winds down the owner task; subsequent calls
        // see is_open=false and no-op.
        if !self.open.load(Ordering::SeqCst) {
            return Ok(());
        }
        let _ = self.close_tx.send(()).await;
        if let Some(h) = self.task_handle.lock().await.take() {
            let _ = h.await;
        }
        Ok(())
    }

    fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }
}

