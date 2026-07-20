package com.taghunter.playground

import android.content.Intent
import android.hardware.usb.UsbManager
import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    handleUsbIntent(intent, fromLaunch = true)
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
