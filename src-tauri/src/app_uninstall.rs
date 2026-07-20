// Settings → Updates → "Uninstall this app".
//
// The app ships as a Tauri NSIS bundle (see tauri.conf.json bundle.targets),
// which writes its uninstaller to `uninstall.exe` next to the main binary in
// the install directory. Launching that exe runs the standard NSIS uninstall
// wizard (which copies itself to %TEMP% and re-runs from there so it can
// delete the install folder, including itself).
//
// We spawn it DETACHED so it survives our own process exit, then quit the app
// immediately - the running binary must not be held open or NSIS can't remove
// it. The uninstaller still shows its own confirmation page, and the frontend
// gates this behind a destructive-action ConfirmDialog of its own.
//
// Non-Windows targets (mobile go through the app stores) return an error; the
// frontend only surfaces the button on desktop.

#[tauri::command]
pub async fn uninstall_app(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        // Detach the child from this process so it keeps running after we exit.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

        let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
        let dir = exe
            .parent()
            .ok_or_else(|| "could not resolve install directory".to_string())?;
        let uninstaller = dir.join("uninstall.exe");

        if !uninstaller.exists() {
            return Err(format!(
                "Uninstaller not found at {}. The app may have been installed differently.",
                uninstaller.display()
            ));
        }

        std::process::Command::new(&uninstaller)
            .current_dir(dir)
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn()
            .map_err(|e| format!("Failed to launch uninstaller: {e}"))?;

        // Release the binary so NSIS can delete it, then let the uninstaller
        // take over. app.exit() does not return.
        app.exit(0);
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Uninstall from inside the app is only supported on Windows.".into())
    }
}
