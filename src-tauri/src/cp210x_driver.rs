// CP210x driver state detection + UAC-elevated install of the bundled
// SportIdent driver.
//
// The SportIdent reader is built around a Silicon Labs CP210x USB-UART chip
// (USB\VID_10C4&PID_800A). On Windows 11 24H2/25H2 the legacy CP210x driver
// (silabser.sys 6.7.x) sits on Microsoft's Vulnerable Driver Blocklist -
// even though the .sys file is on disk and signed, the kernel refuses to
// load it. Device Manager shows Code 39, "application control policy
// blocked this file". The fix is the Silicon Labs Universal driver (v11.x);
// once installed, Code 39 clears and a COM port appears.
//
// This module enumerates USB devices via SetupDi*, finds the SportIdent
// reader by VID/PID, and reads its ConfigManager problem code. The
// frontend renders the result and offers a one-click install that runs
// SportIdent's own signed installer (SPORTident.UsbDriver.Setup.exe /S, a
// v11.x silabser.sys under their sportident.inf) bundled in
// src-tauri/resources/sportident-driver/. Running their Setup.exe rather
// than pnputil means the UAC prompt names "SPORTident GmbH" as publisher
// instead of a generic Windows tool.
//
// Why DIGCF_ALLCLASSES (not DIGCF_DEVICEINTERFACE on the Ports class):
// a CP210x stuck in Code 39 is NOT enumerated under "Ports (COM & LPT)" -
// it sits under "Other devices" with no class assigned because the
// driver never loaded. We have to sweep every class to find it.

use serde::Serialize;

// `Unknown` is only constructed on non-Windows builds (see the cfg branch in
// check_cp210x_driver_state). On Windows the variant exists purely to be sent
// back through serde and rendered by the frontend, never built in Rust, hence
// the allow.
#[allow(dead_code)]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DriverState {
    /// Device present, ConfigManager reports problem 0 / no DN_HAS_PROBLEM.
    Healthy,
    /// Device present, CM problem code 39 (driver failed to load) or 40
    /// (driver blocked). On modern Windows 11 this almost always means the
    /// Vulnerable Driver Blocklist refused the .sys file.
    BlockedByPolicy,
    /// Device present, CM problem code 28 (CM_PROB_FAILED_INSTALL - "the
    /// drivers for this device are not installed") or 18 (CM_PROB_REINSTALL).
    /// The reader is physically plugged in but Windows has never bound a
    /// working driver to it, so it sits under "Other devices". Distinct from
    /// BlockedByPolicy: there a driver exists but the kernel refused to load
    /// it; here there is simply no driver to load - installing one fixes it.
    DriverNotInstalled,
    /// Device present, CM problem code is something else (uninitialized,
    /// disabled, resource conflict, etc.). Surfaced so the UI can render
    /// the code and point the operator at Event Viewer.
    OtherError { code: u32 },
    /// No USB device matching VID 10c4 / PID 800a is currently present.
    DeviceAbsent,
    /// Non-Windows, or the SetupDi enumeration failed. UI treats this as
    /// "fall back to the existing manual flow".
    Unknown,
}

#[tauri::command]
pub async fn check_cp210x_driver_state() -> Result<DriverState, String> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(windows_impl::enumerate)
            .await
            .map_err(|e| format!("join error: {}", e))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(DriverState::Unknown)
    }
}

/// Relative to the app's resource dir. Tauri keeps the glob's directory
/// structure ("resources/sportident-driver/**/*" in tauri.conf.json).
#[cfg(target_os = "windows")]
const SETUP_EXE: &str = "resources/sportident-driver/SPORTident.UsbDriver.Setup.exe";

/// Runs the bundled SportIdent installer silently, elevated through UAC, and
/// waits for it. Errors are stable codes the frontend maps to messages:
/// "cancelled" (operator declined UAC), "missing" (installer not bundled),
/// "timeout", "exit:<code>", or free text for anything else. The caller
/// re-runs check_cp210x_driver_state afterwards to confirm the rebind.
#[tauri::command]
pub async fn install_cp210x_driver(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        let exe = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir: {}", e))?
            .join(SETUP_EXE);
        if !exe.is_file() {
            return Err("missing".into());
        }
        tokio::task::spawn_blocking(move || windows_impl::run_elevated(&exe, "/S"))
            .await
            .map_err(|e| format!("join error: {}", e))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("install_cp210x_driver is Windows-only".into())
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::DriverState;

    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        CM_Get_DevNode_Status, SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo,
        SetupDiGetClassDevsW, SetupDiGetDeviceRegistryPropertyW, CM_DEVNODE_STATUS_FLAGS,
        CM_PROB, CR_SUCCESS, DIGCF_ALLCLASSES, DIGCF_PRESENT, DN_HAS_PROBLEM, HDEVINFO,
        SETUP_DI_GET_CLASS_DEVS_FLAGS, SETUP_DI_REGISTRY_PROPERTY, SPDRP_HARDWAREID,
        SP_DEVINFO_DATA,
    };

    /// Installer exit codes treated as success: 0, and 3010
    /// (ERROR_SUCCESS_REBOOT_REQUIRED) - the driver is staged either way.
    const OK_EXIT_CODES: [u32; 2] = [0, 3010];
    /// Generous: a silent driver install is a few seconds, but a slow disk
    /// or Defender scan of the .sys can stretch it.
    const INSTALL_TIMEOUT_MS: u32 = 5 * 60 * 1000;
    /// HRESULT_FROM_WIN32(ERROR_CANCELLED) - the operator said No to UAC.
    const HRESULT_CANCELLED: i32 = 0x800704C7u32 as i32;

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// ShellExecuteExW with the "runas" verb (triggers UAC), then block until
    /// the process exits and report its exit code.
    pub fn run_elevated(exe: &Path, params: &str) -> Result<(), String> {
        let file = wide(exe.as_os_str());
        let params = wide(std::ffi::OsStr::new(params));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
            lpVerb: w!("runas"),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: 0, // SW_HIDE
            ..Default::default()
        };

        unsafe {
            if let Err(e) = ShellExecuteExW(&mut info) {
                return Err(if e.code().0 == HRESULT_CANCELLED {
                    "cancelled".into()
                } else {
                    format!("ShellExecuteExW: {}", e)
                });
            }
            if info.hProcess.is_invalid() {
                return Err("no process handle".into());
            }

            let wait = WaitForSingleObject(info.hProcess, INSTALL_TIMEOUT_MS);
            let result = if wait == WAIT_OBJECT_0 {
                let mut code: u32 = 0;
                match GetExitCodeProcess(info.hProcess, &mut code) {
                    Ok(()) if OK_EXIT_CODES.contains(&code) => Ok(()),
                    Ok(()) => Err(format!("exit:{}", code)),
                    Err(e) => Err(format!("GetExitCodeProcess: {}", e)),
                }
            } else if wait == WAIT_TIMEOUT {
                Err("timeout".into())
            } else {
                Err(format!("WaitForSingleObject: {:?}", wait))
            };
            let _ = CloseHandle(info.hProcess);
            result
        }
    }

    pub fn enumerate() -> Result<DriverState, String> {
        unsafe {
            let flags = SETUP_DI_GET_CLASS_DEVS_FLAGS(DIGCF_ALLCLASSES.0 | DIGCF_PRESENT.0);
            let hdevinfo: HDEVINFO =
                SetupDiGetClassDevsW(None, PCWSTR::null(), None, flags)
                    .map_err(|e| format!("SetupDiGetClassDevsW: {:?}", e))?;

            let mut state = DriverState::DeviceAbsent;
            let mut idx: u32 = 0;

            loop {
                let mut devinfo = SP_DEVINFO_DATA {
                    cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
                    ..Default::default()
                };

                // Any error ends the iteration. The only expected error after
                // the last device is ERROR_NO_MORE_ITEMS; treat anything else
                // the same way (we've enumerated as much as the OS will give
                // us, and we want a deterministic exit either way).
                if SetupDiEnumDeviceInfo(hdevinfo, idx, &mut devinfo).is_err() {
                    break;
                }
                idx += 1;

                if !device_matches_cp210x(hdevinfo, &devinfo) {
                    continue;
                }

                // CP210x found. Read its CM problem code. The windows-rs API
                // uses newtype wrappers (CM_DEVNODE_STATUS_FLAGS, CM_PROB)
                // around the underlying u32; .0 unwraps to the raw value for
                // comparison against well-known constants.
                let mut status = CM_DEVNODE_STATUS_FLAGS(0);
                let mut problem = CM_PROB(0);
                let cr = CM_Get_DevNode_Status(&mut status, &mut problem, devinfo.DevInst, 0);

                state = if cr == CR_SUCCESS {
                    if (status.0 & DN_HAS_PROBLEM.0) == 0 {
                        // No problem flagged - driver loaded fine.
                        DriverState::Healthy
                    } else {
                        match problem.0 {
                            // CM_PROB_DRIVER_FAILED_LOAD (39) is the exact code
                            // Code 39 in Device Manager. On Windows 11 24H2+
                            // with the policy that refused silabser.sys, this
                            // is the case we want to fix.
                            //
                            // CM_PROB_DRIVER_BLOCKED (40) is closely related -
                            // group it under the same UI bucket so the same
                            // Install Driver action fires.
                            39 | 40 => DriverState::BlockedByPolicy,
                            // CM_PROB_FAILED_INSTALL (28) is "the drivers for
                            // this device are not installed" - a CP210x that
                            // never had a driver bound, sitting under "Other
                            // devices". CM_PROB_REINSTALL (18) is the same
                            // remedy from the operator's side (install the
                            // driver), so group them.
                            28 | 18 => DriverState::DriverNotInstalled,
                            code => DriverState::OtherError { code },
                        }
                    }
                } else {
                    DriverState::OtherError { code: cr.0 }
                };
                break;
            }

            let _ = SetupDiDestroyDeviceInfoList(hdevinfo);
            Ok(state)
        }
    }

    /// True iff this device's hardware-ID list contains a `USB\VID_10C4&PID_800A`
    /// entry (case-insensitive). Hardware IDs come back as a REG_MULTI_SZ - a
    /// sequence of UTF-16 strings separated by nulls - so we walk it as such.
    unsafe fn device_matches_cp210x(hdevinfo: HDEVINFO, devinfo: &SP_DEVINFO_DATA) -> bool {
        let mut buf = [0u8; 4096];
        let mut required: u32 = 0;
        let mut reg_type: u32 = 0;

        let r = SetupDiGetDeviceRegistryPropertyW(
            hdevinfo,
            devinfo,
            SETUP_DI_REGISTRY_PROPERTY(SPDRP_HARDWAREID.0),
            Some(&mut reg_type),
            Some(&mut buf),
            Some(&mut required),
        );

        if r.is_err() {
            return false;
        }

        let used_bytes = (required as usize).min(buf.len());
        if used_bytes < 2 {
            return false;
        }

        // SAFETY: REG_MULTI_SZ is UTF-16; the buffer is 4096 bytes / 2 = 2048
        // u16 elements, and `used_bytes / 2` is bounded by that. Re-borrowing
        // the same allocation as &[u16] is valid because u8 has weaker
        // alignment than u16... no, that's the wrong direction. The buffer is
        // aligned at u8 (no alignment requirement) and we want to read it as
        // u16, which needs 2-byte alignment. Stack-allocated [u8; 4096] is
        // typically 16-byte aligned in practice, but to be safe we copy into
        // a properly-aligned u16 buffer.
        let len_u16 = used_bytes / 2;
        let mut buf_u16 = vec![0u16; len_u16];
        std::ptr::copy_nonoverlapping(
            buf.as_ptr(),
            buf_u16.as_mut_ptr() as *mut u8,
            len_u16 * 2,
        );

        buf_u16
            .split(|&c| c == 0)
            .filter(|s| !s.is_empty())
            .any(|slice| {
                let s = String::from_utf16_lossy(slice).to_ascii_uppercase();
                s.contains("VID_10C4") && s.contains("PID_800A")
            })
    }
}
