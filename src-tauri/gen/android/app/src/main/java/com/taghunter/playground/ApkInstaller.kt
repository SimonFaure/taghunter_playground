package com.taghunter.playground

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

// Android self-update (design: project_android_operator_tablet). The JS side
// downloads the APK from Studio into app data and checks its SHA-256; Rust
// (lib.rs android_install_apk) then calls install() over JNI. We copy the APK
// under cacheDir (the FileProvider's cache-path root) and hand it to the system
// installer, which asks the operator to confirm - and, the very first time, to
// allow Playground to install apps. Android itself refuses an APK signed with a
// different key than the installed app.
object ApkInstaller {
  /** Returns null on success, or the error text. */
  @JvmStatic
  fun install(context: Context, sourcePath: String): String? {
    return try {
      val dir = File(context.cacheDir, "update").apply { mkdirs() }
      val apk = File(dir, "playground-update.apk")
      File(sourcePath).copyTo(apk, overwrite = true)
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
      null
    } catch (e: Exception) {
      e.toString()
    }
  }
}
