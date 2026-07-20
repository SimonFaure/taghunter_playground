package com.taghunter.playground.sportident

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import com.hoho.android.usbserial.driver.UsbSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

// SportIdent (CP210x) USB-serial bridge for the Android target of the
// playground app. Mirrors the surface of src-tauri/src/sportident/transport/
// desktop.rs but lives on the JVM side because Android exposes USB only
// through java.* APIs.
//
// Threading
// =========
// Rust holds the policy (when to open/close/write); Kotlin holds the physical
// port. All Rust→Kotlin entry points are @JvmStatic on the companion object
// so the JNI signature stays simple (`com/taghunter/playground/sportident/
// SportIdentSerial$Companion.open(...)` mangled by the Kotlin compiler - we
// expose them through the matching Java static-method symbol via @JvmStatic).
//
// The RX path is push, not pull: SerialInputOutputManager's listener fires
// from a background executor thread; we forward straight into native code via
// nativeRxBytes(handle, bytes). The native side owns the mpsc that the
// reader state machine drains. We do NOT post to the main thread - the SI
// frame decoder is fast and pure, and round-tripping through Looper.post
// would add ~1 frame of latency for no benefit.
//
// Handle model
// ============
// Each open() returns an opaque Long handle. The handle is the only key the
// Rust side knows about; this keeps the Kotlin/Rust ownership boundary
// simple (no Rust references to UsbSerialPort, no Kotlin references to
// Rust mpsc senders). When close() is called, we tear down the IO manager,
// release the USB connection, and the native side disposes its router entry.

class SportIdentSerial {

    companion object {

        // CP210x (Silicon Labs CP2102/2102N). The SI master station family
        // (BSM7/BSM8/BSM-USB) is uniformly CP210x-based; FTDI variants are
        // out of scope. Hex shown for cross-reference with cp210x_driver.rs.
        private const val CP210X_VID = 0x10C4  // 4292
        private const val CP210X_PID = 0x800A  // 32778

        private const val ACTION_USB_PERMISSION =
            "com.taghunter.playground.sportident.USB_PERMISSION"

        private const val WRITE_TIMEOUT_MS = 1000
        private const val RX_BUFFER_SIZE = 4096

        private val handleSeq = AtomicLong(0)
        private val openPorts = ConcurrentHashMap<Long, OpenPort>()

        // Single shared executor for SerialInputOutputManager.start() calls.
        // newCachedThreadPool here means each open() task gets its own thread,
        // pooled and reused across reopens (avoids fresh-thread cost on the
        // common "connect → disconnect → reconnect" cycle).
        private val rxExecutor = Executors.newCachedThreadPool { r ->
            Thread(r, "sportident-rx").apply { isDaemon = true }
        }

        // System.loadLibrary already happens in Tauri's WryActivity (it loads
        // the taghunter_playground_lib cdylib that exports the
        // Java_com_taghunter_playground_sportident_SportIdentSerial_* JNI
        // symbols below). We do NOT call it here to avoid double-load.

        @JvmStatic
        external fun nativeRxBytes(handle: Long, bytes: ByteArray)

        @JvmStatic
        external fun nativeRxError(handle: Long, message: String)

        @JvmStatic
        external fun nativeRxClosed(handle: Long)

        // ─── Enumeration ────────────────────────────────────────────────

        // Returns a flat array, three slots per device: [deviceIdStr, label,
        // manufacturer]. Keeping a primitive shape avoids defining a Kotlin
        // type that JNI would need to allocate/inspect.
        @JvmStatic
        fun list(ctx: Context): Array<String> {
            val usbManager = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
            val out = mutableListOf<String>()
            for ((_, device) in usbManager.deviceList) {
                if (device.vendorId == CP210X_VID && device.productId == CP210X_PID) {
                    out += device.deviceName            // "/dev/bus/usb/001/004"
                    out += device.productName ?: "SportIdent master"
                    out += device.manufacturerName ?: "Silicon Labs"
                }
            }
            return out.toTypedArray()
        }

        // ─── Permission ─────────────────────────────────────────────────

        // Synchronous wrapper around UsbManager.requestPermission. The
        // BroadcastReceiver pattern is async by nature; we block the calling
        // thread on a CountDownLatch. The native side calls this from a
        // tokio blocking task (spawn_blocking) so we don't pin a tokio worker.
        //
        // Returns true if permission granted (or already held), false otherwise.
        @JvmStatic
        fun requestPermission(ctx: Context, deviceId: String): Boolean {
            val usbManager = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
            val device = usbManager.deviceList[deviceId] ?: return false
            if (usbManager.hasPermission(device)) return true

            val latch = java.util.concurrent.CountDownLatch(1)
            var granted = false

            val receiver = object : BroadcastReceiver() {
                override fun onReceive(c: Context, intent: Intent) {
                    if (intent.action == ACTION_USB_PERMISSION) {
                        synchronized(this) {
                            val d: UsbDevice? = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
                            granted = intent.getBooleanExtra(
                                UsbManager.EXTRA_PERMISSION_GRANTED, false
                            ) && d != null && d.deviceName == deviceId
                            latch.countDown()
                        }
                    }
                }
            }

            val filter = IntentFilter(ACTION_USB_PERMISSION)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                ctx.registerReceiver(receiver, filter)
            }

            // FLAG_MUTABLE is required on Android 12+ for the system to fill
            // in EXTRA_PERMISSION_GRANTED; FLAG_IMMUTABLE would silently
            // strip the result extras.
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                PendingIntent.FLAG_MUTABLE
            } else {
                0
            }
            val pi = PendingIntent.getBroadcast(
                ctx, 0, Intent(ACTION_USB_PERMISSION).setPackage(ctx.packageName), flags
            )
            usbManager.requestPermission(device, pi)

            // 30 s ceiling - Android does not auto-dismiss the dialog; if the
            // user walks away we'd otherwise block forever and the native
            // open() would never return.
            val ok = try {
                latch.await(30, java.util.concurrent.TimeUnit.SECONDS)
            } catch (_: InterruptedException) {
                false
            }
            try { ctx.unregisterReceiver(receiver) } catch (_: IllegalArgumentException) {}
            return ok && granted
        }

        // ─── Open / Write / Close ───────────────────────────────────────

        // Returns the opaque handle, or 0 on failure. Native side must treat
        // 0 as "open failed" and surface a TransportError.
        @JvmStatic
        fun open(ctx: Context, deviceId: String, baud: Int): Long {
            val usbManager = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
            val device = usbManager.deviceList[deviceId] ?: return 0L
            if (!usbManager.hasPermission(device)) return 0L

            val drivers: List<UsbSerialDriver> =
                UsbSerialProber.getDefaultProber().findAllDrivers(usbManager)
            val driver = drivers.firstOrNull { it.device.deviceName == deviceId } ?: return 0L
            val port: UsbSerialPort = driver.ports.firstOrNull() ?: return 0L

            val connection = usbManager.openDevice(device) ?: return 0L
            try {
                port.open(connection)
                port.setParameters(
                    baud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE
                )
            } catch (e: Exception) {
                try { connection.close() } catch (_: Exception) {}
                return 0L
            }

            val handle = handleSeq.incrementAndGet()
            val listener = object : SerialInputOutputManager.Listener {
                override fun onNewData(data: ByteArray) {
                    // Hot path. Defensive copy because the IO manager owns
                    // the buffer and may reuse it on the next read.
                    nativeRxBytes(handle, data.copyOf())
                }
                override fun onRunError(e: Exception) {
                    nativeRxError(handle, e.message ?: e.javaClass.simpleName)
                    // The IO manager has already stopped at this point; mark
                    // the port closed-from-below so the native side can flip
                    // its is_open flag without an explicit close() round-trip.
                    nativeRxClosed(handle)
                }
            }
            val ioManager = SerialInputOutputManager(port, listener).apply {
                readBufferSize = RX_BUFFER_SIZE
                writeTimeout = WRITE_TIMEOUT_MS
            }
            rxExecutor.submit(ioManager)

            openPorts[handle] = OpenPort(port, ioManager)
            return handle
        }

        // Returns true on success. False means either the handle is unknown
        // or the underlying USB write failed (cable unplugged, etc.). The
        // native side maps false → TransportError::Other.
        @JvmStatic
        fun write(handle: Long, bytes: ByteArray): Boolean {
            val entry = openPorts[handle] ?: return false
            return try {
                entry.port.write(bytes, WRITE_TIMEOUT_MS)
                true
            } catch (_: Exception) {
                false
            }
        }

        // Idempotent. After close() returns, the native side may safely
        // re-issue open() on the same device.
        @JvmStatic
        fun close(handle: Long) {
            val entry = openPorts.remove(handle) ?: return
            try { entry.ioManager.stop() } catch (_: Exception) {}
            try { entry.port.close() } catch (_: Exception) {}
            nativeRxClosed(handle)
        }
    }

    private data class OpenPort(
        val port: UsbSerialPort,
        val ioManager: SerialInputOutputManager,
    )
}
