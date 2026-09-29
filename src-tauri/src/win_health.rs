// Windows settings a mother needs and a licensee will never find on their own
// (retours sept. #20). Read-only check (no elevation) + a one-UAC fix.
//
//  - Mobile-hotspot power saving (`icssvc\Settings\PeerlessTimeoutEnabled`):
//    Windows switches the AP off after a few minutes with no client while the
//    toggle still reads "on". A device that takes control before the satellites
//    have joined it can lose its Wi-Fi. Unset = Windows' default = ON.
//  - Sleep on mains: a mother that sleeps mid-game takes the game with it.
//  - "Allow the computer to turn off this device" on the Wi-Fi card.
//  - Public network profile on the Wi-Fi / hotspot adapters.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
pub struct WindowsHealth {
    /// None = could not be read (not Windows / query failed).
    pub hotspot_power_saving: Option<bool>,
    /// Minutes before sleep on mains; 0 = never.
    pub sleep_ac_minutes: Option<u32>,
    /// True when Windows may power the Wi-Fi card down.
    pub wifi_power_management: Option<bool>,
    /// Aliases of connected interfaces on the Public profile.
    pub public_networks: Vec<String>,
    /// Convenience: at least one setting needs fixing.
    pub needs_fix: bool,
}

#[cfg(target_os = "windows")]
fn read_health() -> WindowsHealth {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let ps = r#"$ErrorActionPreference='SilentlyContinue'
$p = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\icssvc\Settings' -Name PeerlessTimeoutEnabled
if ($p -ne $null) { Write-Output ('PEERLESS=' + $p.PeerlessTimeoutEnabled) } else { Write-Output 'PEERLESS=unset' }
$v = @((powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE) | Select-String -Pattern '0x[0-9a-fA-F]+' -AllMatches | ForEach-Object { $_.Matches } | ForEach-Object { $_.Value })
if ($v.Count -ge 2) { Write-Output ('SLEEPAC=' + $v[$v.Count - 2]) }
$w = Get-NetAdapter -Physical | Where-Object { $_.NdisPhysicalMedium -eq 9 } | Select-Object -First 1
if ($w) { $pm = Get-NetAdapterPowerManagement -Name $w.Name; if ($pm) { Write-Output ('WIFIPM=' + $pm.AllowComputerToTurnOffDevice) } }
Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' } | ForEach-Object { Write-Output ('PUBLIC=' + $_.InterfaceAlias) }
"#;
    let Ok(out) = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", ps])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return WindowsHealth::default();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut h = WindowsHealth::default();
    for line in text.lines().map(str::trim) {
        if let Some(v) = line.strip_prefix("PEERLESS=") {
            // Unset means Windows' default, which is power saving ON.
            h.hotspot_power_saving = Some(v != "0");
        } else if let Some(v) = line.strip_prefix("SLEEPAC=") {
            let secs = u32::from_str_radix(v.trim_start_matches("0x"), 16).ok();
            h.sleep_ac_minutes = secs.map(|s| s / 60);
        } else if let Some(v) = line.strip_prefix("WIFIPM=") {
            // Enabled / Disabled / Unsupported
            h.wifi_power_management = match v {
                "Enabled" => Some(true),
                "Disabled" => Some(false),
                _ => None,
            };
        } else if let Some(v) = line.strip_prefix("PUBLIC=") {
            if !v.is_empty() {
                h.public_networks.push(v.to_string());
            }
        }
    }
    h.needs_fix = h.hotspot_power_saving == Some(true)
        || h.sleep_ac_minutes.map_or(false, |m| m != 0)
        || h.wifi_power_management == Some(true)
        || !h.public_networks.is_empty();
    h
}

#[cfg(not(target_os = "windows"))]
fn read_health() -> WindowsHealth {
    WindowsHealth::default()
}

#[tauri::command]
pub async fn mother_windows_health() -> Result<WindowsHealth, String> {
    tokio::task::spawn_blocking(read_health)
        .await
        .map_err(|e| e.to_string())
}

/// Fix every setting above in ONE elevated PowerShell (one UAC prompt).
/// The hotspot power-saving flag takes effect at the next hotspot start - the
/// hotspot service is deliberately NOT restarted here, it would drop the AP.
#[tauri::command]
pub async fn mother_fix_windows_health() -> Result<WindowsHealth, String> {
    #[cfg(target_os = "windows")]
    {
        let script = r#"$ErrorActionPreference='SilentlyContinue'
New-Item -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\icssvc\Settings' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\icssvc\Settings' -Name PeerlessTimeoutEnabled -Value 0 -Type DWord
powercfg /change standby-timeout-ac 0
Get-NetAdapter -Physical | Where-Object { $_.NdisPhysicalMedium -eq 9 } | ForEach-Object { Set-NetAdapterPowerManagement -Name $_.Name -AllowComputerToTurnOffDevice Disabled -NoRestart }
Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' } | ForEach-Object { Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private }
exit 0
"#;
        let code = tokio::task::spawn_blocking(move || crate::lan_server::run_elevated_powershell(script))
            .await
            .map_err(|e| e.to_string())??;
        if code != 0 {
            return Err(format!("elevated fix exited with code {code} (UAC declined?)"));
        }
    }
    mother_windows_health().await
}
