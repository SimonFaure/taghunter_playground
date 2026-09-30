package com.taghunter.playground

import android.content.Intent
import android.graphics.Color
import android.hardware.usb.UsbManager
import android.os.Bundle
import android.util.Log
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Dark bars (light icons) over the app's dark background.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
    keepContentClearOfSystemBars()
    handleUsbIntent(intent, fromLaunch = true)
  }

  // targetSdk 35+ forces edge-to-edge: the WebView would draw under the status
  // bar and the navigation bar, leaving top/bottom buttons untappable. Pad the
  // content root by the system bars + display cutout (and the keyboard, so
  // focused inputs in modals stay visible). The strips behind the bars show the
  // root's background, matched to the app's dark --pg-bg.
  private fun keepContentClearOfSystemBars() {
    val root = findViewById<View>(android.R.id.content)
    root.setBackgroundColor(Color.parseColor("#0c0c0e"))
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }

  // Called when the activity is already alive (launchMode="singleTask") and
  // a new intent arrives - e.g. the user plugged the SI reader in while the
  // app was foreground. We don't need to do anything beyond logging here:
  // sportidentService.ts polls `si_list_ports` on a short cadence, so the
  // newly-attached CP210x shows up in the device picker within ~2 s. The
  // foreground swap itself is what the user notices.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleUsbIntent(intent, fromLaunch = false)
  }

  private fun handleUsbIntent(intent: Intent?, fromLaunch: Boolean) {
    if (intent?.action != UsbManager.ACTION_USB_DEVICE_ATTACHED) return
    Log.i(
      "MainActivity",
      "SI reader attached via USB OTG (fromLaunch=$fromLaunch); waiting for JS-side poll"
    )
  }
}
