// Mother-side Wi-Fi hotspot control.
//
// Slice C: Windows implementation via the WinRT
// `NetworkOperatorTetheringManager` API. The mother device spins up a soft
// AP with a stable SSID + WPA2 passphrase that clients scan from a Wi-Fi
// QR code (slice C/D UI work).
//
// Other platforms expose the same Tauri command surface but return a typed
// "not supported" error; Android lands in slice D, macOS/iOS/Linux remain
// out-of-scope per the plan.
//
// Concurrency: the WinRT async operations block via `.get()`. We run them on
// `tokio::task::spawn_blocking` so the Tauri command future stays cooperative.

use serde::Serialize;

const PLATFORM: &str = if cfg!(target_os = "windows") {
    "windows"
} else if cfg!(target_os = "android") {
    "android"
} else if cfg!(target_os = "linux") {
    "linux"
} else if cfg!(target_os = "macos") {
    "macos"
} else if cfg!(target_os = "ios") {
    "ios"
} else {
    "unknown"
};

#[derive(Serialize)]
pub struct HotspotInfo {
    pub ssid: String,
    pub password: String,
    pub ipv4_addresses: Vec<String>,
    pub platform: &'static str,
}

#[derive(Serialize)]
pub struct HotspotStatus {
    pub running: bool,
    pub ssid: Option<String>,
    pub ipv4_addresses: Vec<String>,
    pub platform: &'static str,
}

// ─── access-point band ───────────────────────────────────────────────────────
// Retours sept. #19: with the AP left on Windows' "any available" band, some of
// the field's heterogeneous test PCs never saw a promoted mother's Wi-Fi; forcing
// 2.4 GHz is what made them appear. 2.4 GHz is therefore the default, with an
// "auto" escape hatch in Settings → Network → Advanced (the renderer pushes the
// operator's choice here at boot and on change). Process-global because the AP
// is raised both from the renderer and from `become_mother` in Rust.
static HOTSPOT_BAND_24: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// `band`: "2.4" (default) or "auto".
#[tauri::command]
pub fn mother_set_hotspot_band(band: String) {
    HOTSPOT_BAND_24.store(band != "auto", std::sync::atomic::Ordering::Relaxed);
}

// ─── tauri commands ──────────────────────────────────────────────────────────

/// Opens Windows' own Mobile hotspot page - the operator's check when our start
/// fails: if Windows' toggle fails too, it is the Wi-Fi driver, not Tag Hunter.
/// (The opener plugin's default scope only allows http(s)/mailto/tel.)
#[tauri::command]
pub fn open_windows_hotspot_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:network-mobilehotspot")
            .spawn()
            .map_err(|e| format!("open ms-settings: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(format!("not supported on {PLATFORM}"))
    }
}

#[tauri::command]
pub async fn mother_start_hotspot(
    ssid: String,
    password: String,
) -> Result<HotspotInfo, String> {
    validate_creds(&ssid, &password)?;

    #[cfg(target_os = "windows")]
    {
        let s = ssid.clone();
        let p = password.clone();
        tokio::task::spawn_blocking(move || windows_impl::start(&s, &p))
            .await
            .map_err(|e| format!("spawn_blocking: {e}"))??;
    }
    #[cfg(not(target_os = "windows"))]
    {
        return Err(format!(
            "hotspot creation not implemented on {PLATFORM} (slice C is Windows-only; slice D adds Android)"
        ));
    }

    #[allow(unreachable_code)]
    Ok(HotspotInfo {
        ssid,
        password,
        ipv4_addresses: enumerate_local_ipv4(),
        platform: PLATFORM,
    })
}

#[tauri::command]
pub async fn mother_stop_hotspot() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(windows_impl::stop)
            .await
            .map_err(|e| format!("spawn_blocking: {e}"))??;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(format!("hotspot stop not implemented on {PLATFORM}"))
    }
}

#[tauri::command]
pub async fn mother_hotspot_status() -> Result<HotspotStatus, String> {
    #[cfg(target_os = "windows")]
    {
        let (running, ssid) = tokio::task::spawn_blocking(windows_impl::status)
            .await
            .map_err(|e| format!("spawn_blocking: {e}"))??;
        return Ok(HotspotStatus {
            running,
            ssid,
            ipv4_addresses: enumerate_local_ipv4(),
            platform: PLATFORM,
        });
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(HotspotStatus {
            running: false,
            ssid: None,
            ipv4_addresses: enumerate_local_ipv4(),
            platform: PLATFORM,
        })
    }
}

// ─── shared helpers ──────────────────────────────────────────────────────────

fn validate_creds(ssid: &str, password: &str) -> Result<(), String> {
    if ssid.is_empty() || ssid.len() > 32 {
        return Err("SSID must be 1-32 characters".into());
    }
    if password.len() < 8 || password.len() > 63 {
        return Err("WPA2 password must be 8-63 characters".into());
    }
    // The WIFI: QR format uses ; , " : \ as separators/escapes - we'd rather
    // refuse those than rely on perfect escaping in the QR generator.
    if ssid.contains(|c: char| matches!(c, ';' | ',' | '"' | ':' | '\\')) {
        return Err("SSID must not contain ; , \" : \\".into());
    }
    if password.contains(|c: char| matches!(c, ';' | ',' | '"' | ':' | '\\')) {
        return Err("password must not contain ; , \" : \\".into());
    }
    Ok(())
}

fn enumerate_local_ipv4() -> Vec<String> {
    match if_addrs::get_if_addrs() {
        Ok(addrs) => addrs
            .into_iter()
            .filter(|i| !i.is_loopback())
            .filter_map(|i| match i.addr {
                if_addrs::IfAddr::V4(v) => Some(v.ip.to_string()),
                _ => None,
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

// ─── windows impl ────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows_impl {
    use windows::core::HSTRING;
    use windows::Networking::Connectivity::{ConnectionProfile, NetworkInformation};
    use windows::Networking::NetworkOperators::{
        NetworkOperatorTetheringAccessPointConfiguration, NetworkOperatorTetheringManager,
        TetheringCapability, TetheringOperationStatus, TetheringOperationalState,
        TetheringWiFiBand,
    };

    /// Start failures are coded `HOTSPOT_ERR:<code>|<detail>` so the renderer
    /// can explain them in the licensee's language (HotspotIssueBanner).
    fn coded(code: &str, detail: String) -> String {
        format!("HOTSPOT_ERR:{code}|{detail}")
    }

    pub fn start(ssid: &str, password: &str) -> Result<(), String> {
        let profile = pick_profile().map_err(|e| coded("no_profile", e))?;

        // Windows says up front when tethering is off-limits (policy, SKU,
        // driver/hardware) - no point firing StartTetheringAsync then.
        if let Ok(cap) =
            NetworkOperatorTetheringManager::GetTetheringCapabilityFromConnectionProfile(&profile)
        {
            if cap != TetheringCapability::Enabled {
                let name = describe_capability(cap);
                return Err(coded(
                    &format!("capability_{name}"),
                    format!("tethering capability {name} ({})", adapter_description()),
                ));
            }
        }

        let manager = NetworkOperatorTetheringManager::CreateFromConnectionProfile(&profile)
            .map_err(|e| format!("CreateFromConnectionProfile: {}", e.message()))?;

        let band = if super::HOTSPOT_BAND_24.load(std::sync::atomic::Ordering::Relaxed) {
            TetheringWiFiBand::TwoPointFourGigahertz
        } else {
            TetheringWiFiBand::Auto
        };
        configure(&manager, ssid, password, band)?;

        // Already on? Return success without re-starting.
        let state = manager
            .TetheringOperationalState()
            .map_err(|e| format!("TetheringOperationalState: {}", e.message()))?;
        if state == TetheringOperationalState::On {
            return Ok(());
        }

        let status = start_tethering(&manager)?;
        if status == TetheringOperationStatus::Success {
            return Ok(());
        }
        // Single-radio adapters (e.g. MediaTek RZ616) can't host a 2.4 GHz AP
        // while their station link sits on 5 GHz: Windows fails with a bare
        // `Unknown`. Fall back to Auto so the AP shares the upstream's band -
        // a hotspot on 5 GHz beats no hotspot at all.
        if band == TetheringWiFiBand::TwoPointFourGigahertz {
            eprintln!(
                "[hotspot] 2.4 GHz start failed ({}); retrying with band Auto",
                describe_op_status(status),
            );
            // Let the failed attempt settle before reconfiguring.
            std::thread::sleep(std::time::Duration::from_millis(1500));
            configure(&manager, ssid, password, TetheringWiFiBand::Auto)?;
            let retry = start_tethering(&manager)?;
            if retry == TetheringOperationStatus::Success {
                return Ok(());
            }
            return Err(coded(
                failure_code(retry),
                format!(
                    "StartTetheringAsync returned {:?} ({}) on 2.4 GHz and {:?} ({}) on Auto band ({})",
                    status,
                    describe_op_status(status),
                    retry,
                    describe_op_status(retry),
                    adapter_description(),
                ),
            ));
        }
        Err(coded(
            failure_code(status),
            format!(
                "StartTetheringAsync returned {:?} ({}) ({})",
                status,
                describe_op_status(status),
                adapter_description(),
            ),
        ))
    }

    fn failure_code(s: TetheringOperationStatus) -> &'static str {
        if s == TetheringOperationStatus::WiFiDeviceOff {
            "wifi_off"
        } else {
            "unknown"
        }
    }

    /// Wi-Fi card description (e.g. "RZ616 Wi-Fi 6E 160MHz") for support -
    /// a bare `Unknown` from Windows is almost always a driver matter.
    /// Only called on failure; best effort.
    fn adapter_description() -> String {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let ps = "$w = Get-NetAdapter -Physical | Where-Object { $_.NdisPhysicalMedium -eq 9 } | Select-Object -First 1; \
                  if ($w) { Write-Output ($w.InterfaceDescription + ' / driver ' + $w.DriverVersion) }";
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", ps])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Wi-Fi adapter unknown".into())
    }

    fn describe_capability(c: TetheringCapability) -> &'static str {
        match c {
            TetheringCapability::Enabled => "Enabled",
            TetheringCapability::DisabledByGroupPolicy => "DisabledByGroupPolicy",
            TetheringCapability::DisabledByHardwareLimitation => "DisabledByHardwareLimitation",
            TetheringCapability::DisabledByOperator => "DisabledByOperator",
            TetheringCapability::DisabledBySku => "DisabledBySku",
            TetheringCapability::DisabledByRequiredAppNotInstalled => {
                "DisabledByRequiredAppNotInstalled"
            }
            TetheringCapability::DisabledDueToUnknownCause => "DisabledDueToUnknownCause",
            TetheringCapability::DisabledBySystemCapability => "DisabledBySystemCapability",
            _ => "other",
        }
    }

    /// Configure SSID + passphrase + band. ConfigureAccessPointAsync is a
    /// no-op when the new config matches the current; safe to call every start.
    fn configure(
        manager: &NetworkOperatorTetheringManager,
        ssid: &str,
        password: &str,
        band: TetheringWiFiBand,
    ) -> Result<(), String> {
        let config = NetworkOperatorTetheringAccessPointConfiguration::new()
            .map_err(|e| format!("AccessPointConfiguration::new: {}", e.message()))?;
        config
            .SetSsid(&HSTRING::from(ssid))
            .map_err(|e| format!("SetSsid: {}", e.message()))?;
        config
            .SetPassphrase(&HSTRING::from(password))
            .map_err(|e| format!("SetPassphrase: {}", e.message()))?;
        // Band (Windows 10 2004+). Unsupported API/band → leave Windows' choice.
        if config.IsBandSupported(band).unwrap_or(false) {
            let _ = config.SetBand(band);
        }
        manager
            .ConfigureAccessPointAsync(&config)
            .map_err(|e| format!("ConfigureAccessPointAsync: {}", e.message()))?
            .get()
            .map_err(|e| format!("ConfigureAccessPointAsync await: {}", e.message()))?;
        Ok(())
    }

    fn start_tethering(
        manager: &NetworkOperatorTetheringManager,
    ) -> Result<TetheringOperationStatus, String> {
        manager
            .StartTetheringAsync()
            .map_err(|e| format!("StartTetheringAsync: {}", e.message()))?
            .get()
            .map_err(|e| format!("StartTetheringAsync await: {}", e.message()))?
            .Status()
            .map_err(|e| format!("StartTetheringAsync.Status: {}", e.message()))
    }

    pub fn stop() -> Result<(), String> {
        let profile = pick_profile()?;
        let manager = NetworkOperatorTetheringManager::CreateFromConnectionProfile(&profile)
            .map_err(|e| format!("CreateFromConnectionProfile: {}", e.message()))?;

        let state = manager
            .TetheringOperationalState()
            .map_err(|e| format!("TetheringOperationalState: {}", e.message()))?;
        if state == TetheringOperationalState::Off {
            return Ok(());
        }

        let stop_op = manager
            .StopTetheringAsync()
            .map_err(|e| format!("StopTetheringAsync: {}", e.message()))?;
        let result = stop_op
            .get()
            .map_err(|e| format!("StopTetheringAsync await: {}", e.message()))?;
        let status = result
            .Status()
            .map_err(|e| format!("StopTetheringAsync.Status: {}", e.message()))?;
        if status != TetheringOperationStatus::Success {
            return Err(format!(
                "StopTetheringAsync returned {:?} ({})",
                status,
                describe_op_status(status),
            ));
        }
        Ok(())
    }

    pub fn status() -> Result<(bool, Option<String>), String> {
        // `status` is intentionally lenient: when there's no profile or no
        // tethering manager we return (false, None) rather than erroring,
        // because the caller polls this from a UI footer and a transient
        // "no profile" should render as "off" not as a red error.
        let profile = match pick_profile() {
            Ok(p) => p,
            Err(_) => return Ok((false, None)),
        };
        let manager = match NetworkOperatorTetheringManager::CreateFromConnectionProfile(&profile) {
            Ok(m) => m,
            Err(_) => return Ok((false, None)),
        };
        let state = manager
            .TetheringOperationalState()
            .map_err(|e| format!("TetheringOperationalState: {}", e.message()))?;
        let running = state == TetheringOperationalState::On;
        let ssid = match manager.GetCurrentAccessPointConfiguration() {
            Ok(cfg) => cfg.Ssid().ok().map(|s| s.to_string()),
            Err(_) => None,
        };
        Ok((running, ssid))
    }

    fn pick_profile() -> Result<ConnectionProfile, String> {
        if let Ok(p) = NetworkInformation::GetInternetConnectionProfile() {
            return Ok(p);
        }
        // Fallback: pick any saved connection profile. Tethering doesn't
        // require an *active* upstream - we just need a profile object to
        // anchor the manager. LAN devices joining the AP get LAN-only
        // connectivity, which is what slice C explicitly wants.
        let profiles = NetworkInformation::GetConnectionProfiles()
            .map_err(|e| format!("GetConnectionProfiles: {}", e.message()))?;
        let count = profiles.Size().unwrap_or(0);
        if count == 0 {
            return Err("no connection profile available; connect once to a Wi-Fi network so Windows can derive a tethering profile, then retry".into());
        }
        profiles
            .GetAt(0)
            .map_err(|e| format!("ConnectionProfiles.GetAt(0): {}", e.message()))
    }

    fn describe_op_status(s: TetheringOperationStatus) -> &'static str {
        match s {
            TetheringOperationStatus::Success => "Success",
            TetheringOperationStatus::Unknown => "Unknown",
            TetheringOperationStatus::MobileBroadbandDeviceOff => "MobileBroadbandDeviceOff",
            TetheringOperationStatus::WiFiDeviceOff => "WiFiDeviceOff",
            TetheringOperationStatus::EntitlementCheckTimeout => "EntitlementCheckTimeout",
            TetheringOperationStatus::EntitlementCheckFailure => "EntitlementCheckFailure",
            TetheringOperationStatus::OperationInProgress => "OperationInProgress",
            TetheringOperationStatus::BluetoothDeviceOff => "BluetoothDeviceOff",
            TetheringOperationStatus::NetworkLimitedConnectivity => "NetworkLimitedConnectivity",
            _ => "other",
        }
    }
}
