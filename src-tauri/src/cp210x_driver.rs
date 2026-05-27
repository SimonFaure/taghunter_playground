// CP210x driver state detection + (Sprint 2 TODO) UAC-elevated install.
//
// The SportIdent reader is built around a Silicon Labs CP210x USB-UART chip
// (USB\VID_10C4&PID_800A). On Windows 11 24H2/25H2 the legacy CP210x driver
// (silabser.sys 6.7.x) sits on Microsoft's Vulnerable Driver Blocklist —
// even though the .sys file is on disk and signed, the kernel refuses to
// load it. Device Manager shows Code 39, "application control policy
// blocked this file". The fix is the Silicon Labs Universal driver (v11.x);
// once installed, Code 39 clears and a COM port appears.
//
// This module enumerates USB devices via SetupDi*, finds the SportIdent
// reader by VID/PID, and reads its ConfigManager problem code. The
// frontend renders the result and (in Sprint 2) offers a one-click
// elevated pnputil install against the driver bundle in
// src-tauri/resources/silabser-drivers/.
//
// Why DIGCF_ALLCLASSES (not DIGCF_DEVICEINTERFACE on the Ports class):
// a CP210x stuck in Code 39 is NOT enumerated under "Ports (COM & LPT)" —
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
    /// Device present, CM problem code 28 (CM_PROB_FAILED_INSTALL — "the
    /// drivers for this device are not installed") or 18 (CM_PROB_REINSTALL).
    /// The reader is physically plugged in but Windows has never bound a
    /// working driver to it, so it sits under "Other devices". Distinct from
    /// BlockedByPolicy: there a driver exists but the kernel refused to load
    /// it; here there is simply no driver to load — installing one fixes it.
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

#[tauri::command]
pub async fn install_cp210x_driver(_app: tauri::AppHandle) -> Result<(), String> {
    // Sprint 1 stub. Sprint 2 wires:
    //   1. resolve bundled silabser.inf via app.path().resource_dir().join(...)
    //   2. ShellExecuteExW with lpVerb="runas", lpFile="pnputil.exe",
    //      lpParameters="/add-driver \"<inf>\" /install", SW_HIDE
    //   3. WaitForSingleObject on a spawn_blocking task; GetExitCodeProcess
    //   4. caller re-runs check_cp210x_driver_state to confirm rebind
    Err("install_cp210x_driver is a Sprint 1 stub — coming in Sprint 2".into())
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::DriverState;

    use windows::core::PCWSTR;
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        CM_Get_DevNode_Status, SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo,
        SetupDiGetClassDevsW, SetupDiGetDeviceRegistryPropertyW, CM_DEVNODE_STATUS_FLAGS,
        CM_PROB, CR_SUCCESS, DIGCF_ALLCLASSES, DIGCF_PRESENT, DN_HAS_PROBLEM, HDEVINFO,
        SETUP_DI_GET_CLASS_DEVS_FLAGS, SETUP_DI_REGISTRY_PROPERTY, SPDRP_HARDWAREID,
        SP_DEVINFO_DATA,
    };

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
                        // No problem flagged — driver loaded fine.
                        DriverState::Healthy
                    } else {
                        match problem.0 {
                            // CM_PROB_DRIVER_FAILED_LOAD (39) is the exact code
                            // Code 39 in Device Manager. On Windows 11 24H2+
                            // with the policy that refused silabser.sys, this
                            // is the case we want to fix.
                            //
                            // CM_PROB_DRIVER_BLOCKED (40) is closely related —
                            // group it under the same UI bucket so the same
                            // Install Driver action fires.
                            39 | 40 => DriverState::BlockedByPolicy,
                            // CM_PROB_FAILED_INSTALL (28) is "the drivers for
                            // this device are not installed" — a CP210x that
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
    /// entry (case-insensitive). Hardware IDs come back as a REG_MULTI_SZ — a
    /// sequence of UTF-16 strings separated by nulls — so we walk it as such.
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
