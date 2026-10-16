// One-shot cleanup of the retired mother hotspot (removed 2026-09-30).
//
// Devices now join a shared router / venue network through Windows; the app no
// longer raises a Mobile Hotspot nor writes WLAN profiles. A PC upgrading from
// a hotspot-era build can still have (a) Windows' Mobile Hotspot running - it
// survives app restarts - and (b) the auto-connect WLAN profiles the old
// auto-join engine wrote for the mother's SSID, which would keep pulling the
// satellite back onto a network nobody hosts any more. The renderer calls
// `legacy_hotspot_cleanup` once at boot (schema_meta flag) with the SSIDs it
// knows the app created.
//
// Only OUR hotspot is stopped: tethering is left alone when its SSID is not one
// of ours, since the operator may use Windows' hotspot for something else.
// Remove this module (and the Networking_* Cargo features) once the field fleet
// has upgraded past the hotspot era.

use serde::Serialize;

#[derive(Serialize, Default)]
pub struct LegacyCleanupReport {
    /// Our hotspot was running and has been stopped.
    pub hotspot_stopped: bool,
    /// Stopping it failed (detail) - the renderer just logs it.
    pub hotspot_error: Option<String>,
    /// WLAN profiles actually deleted.
    pub profiles_deleted: Vec<String>,
}

/// `ssids`: every SSID the old build broadcast or auto-joined (hotspot creds,
/// hotspot-sourced `wifi_networks` rows). Default "TagHunter-…" names are
/// always treated as ours.
#[tauri::command]
pub async fn legacy_hotspot_cleanup(ssids: Vec<String>) -> Result<LegacyCleanupReport, String> {
    #[cfg(target_os = "windows")]
    {
        let ours = ssids.clone();
        let (stopped, err) = tokio::task::spawn_blocking(move || windows_impl::stop_if_ours(&ours))
            .await
            .map_err(|e| format!("spawn_blocking: {e}"))?;
        let mut report = LegacyCleanupReport {
            hotspot_stopped: stopped,
            hotspot_error: err,
            profiles_deleted: Vec::new(),
        };
        for ssid in ssids.iter().filter(|s| !s.is_empty()) {
            if delete_wlan_profile(ssid).await {
                report.profiles_deleted.push(ssid.clone());
            }
        }
        return Ok(report);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = ssids;
        Ok(LegacyCleanupReport::default())
    }
}

fn is_ours(ssid: &str, ours: &[String]) -> bool {
    ssid.starts_with("TagHunter-") || ours.iter().any(|s| s == ssid)
}

#[cfg(target_os = "windows")]
async fn delete_wlan_profile(ssid: &str) -> bool {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // A missing profile (or a Group Policy one) just fails - harmless.
    tokio::process::Command::new("netsh")
        .args(["wlan", "delete", "profile"])
        .arg(format!("name={ssid}"))
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use windows::Networking::Connectivity::{ConnectionProfile, NetworkInformation};
    use windows::Networking::NetworkOperators::{
        NetworkOperatorTetheringManager, TetheringOperationStatus, TetheringOperationalState,
    };

    /// (stopped, error). Lenient: no profile / no manager = nothing to stop.
    pub fn stop_if_ours(ours: &[String]) -> (bool, Option<String>) {
        let Some(profile) = pick_profile() else { return (false, None) };
        let Ok(manager) = NetworkOperatorTetheringManager::CreateFromConnectionProfile(&profile) else {
            return (false, None);
        };
        if manager.TetheringOperationalState().ok() != Some(TetheringOperationalState::On) {
            return (false, None);
        }
        let ssid = manager
            .GetCurrentAccessPointConfiguration()
            .ok()
            .and_then(|c| c.Ssid().ok())
            .map(|s| s.to_string())
            .unwrap_or_default();
        if !super::is_ours(&ssid, ours) {
            return (false, None);
        }
        let status = manager
            .StopTetheringAsync()
            .and_then(|op| op.get())
            .and_then(|r| r.Status());
        match status {
            Ok(s) if s == TetheringOperationStatus::Success => (true, None),
            Ok(s) => (false, Some(format!("StopTetheringAsync returned {s:?}"))),
            Err(e) => (false, Some(format!("StopTetheringAsync: {}", e.message()))),
        }
    }

    fn pick_profile() -> Option<ConnectionProfile> {
        if let Ok(p) = NetworkInformation::GetInternetConnectionProfile() {
            return Some(p);
        }
        let profiles = NetworkInformation::GetConnectionProfiles().ok()?;
        if profiles.Size().unwrap_or(0) == 0 {
            return None;
        }
        profiles.GetAt(0).ok()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn default_and_listed_ssids_are_ours() {
        let ours = vec!["Salle-Evenement".to_string()];
        assert!(super::is_ours("TagHunter-3f9a1c2b", &ours));
        assert!(super::is_ours("Salle-Evenement", &ours));
        assert!(!super::is_ours("Livebox-1234", &ours));
    }
}
