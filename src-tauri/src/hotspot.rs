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

// ─── tauri commands ──────────────────────────────────────────────────────────

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
    // The WIFI: QR format uses ; , " : \ as separators/escapes — we'd rather
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
        TetheringOperationStatus, TetheringOperationalState,
    };

    pub fn start(ssid: &str, password: &str) -> Result<(), String> {
        let profile = pick_profile()?;
        let manager = NetworkOperatorTetheringManager::CreateFromConnectionProfile(&profile)
            .map_err(|e| format!("CreateFromConnectionProfile: {}", e.message()))?;

        // Configure SSID + passphrase. ConfigureAccessPointAsync is a no-op
        // when the new config matches the current; safe to call every start.
        let config = NetworkOperatorTetheringAccessPointConfiguration::new()
            .map_err(|e| format!("AccessPointConfiguration::new: {}", e.message()))?;
        config
            .SetSsid(&HSTRING::from(ssid))
            .map_err(|e| format!("SetSsid: {}", e.message()))?;
        config
            .SetPassphrase(&HSTRING::from(password))
            .map_err(|e| format!("SetPassphrase: {}", e.message()))?;

        let configure_op = manager
            .ConfigureAccessPointAsync(&config)
            .map_err(|e| format!("ConfigureAccessPointAsync: {}", e.message()))?;
        configure_op
            .get()
            .map_err(|e| format!("ConfigureAccessPointAsync await: {}", e.message()))?;

        // Already on? Return success without re-starting.
        let state = manager
            .TetheringOperationalState()
            .map_err(|e| format!("TetheringOperationalState: {}", e.message()))?;
        if state == TetheringOperationalState::On {
            return Ok(());
        }

        let start_op = manager
            .StartTetheringAsync()
            .map_err(|e| format!("StartTetheringAsync: {}", e.message()))?;
        let result = start_op
            .get()
            .map_err(|e| format!("StartTetheringAsync await: {}", e.message()))?;
        let status = result
            .Status()
            .map_err(|e| format!("StartTetheringAsync.Status: {}", e.message()))?;
        if status != TetheringOperationStatus::Success {
            return Err(format!(
                "StartTetheringAsync returned {:?} ({})",
                status,
                describe_op_status(status),
            ));
        }
        Ok(())
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
        // require an *active* upstream — we just need a profile object to
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
