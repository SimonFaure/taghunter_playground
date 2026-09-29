# SPORTident USB Driver

SPORTident USB driver for BSM7/8 USB stations, the SRR USB Dongle and the RS232
USB converter. BS11 stations do not require this driver. Once installed, a
connected device appears as a virtual COM port (in Device Manager under **Ports
(COM & LPT)**).

Supported: Windows 10 1709 (build 16299) and later, and Windows 11 — x64 and
arm64 (including the matching Windows Server editions).

## Installation

Double-click `SPORTident.UsbDriver.Setup.exe` and confirm the Windows prompt
(the publisher is shown as **SPORTident GmbH**).

For unattended installation, run `SPORTident.UsbDriver.Setup.exe /S`.

## Manual installation

If you prefer not to run the installer, right-click `driver\sportident.inf` (in
the `driver` folder of this download) and choose **Install**.

## Uninstallation

### Using Device Manager

1. Open **Device Manager** (press `Win + X` and select **Device Manager**).
2. In the **View** menu, select **Devices by drivers**.
3. Locate the **SPORTident** entry (`sportident.inf`), right-click it, and
   choose **Remove driver**.
4. In the confirmation dialog, click **Remove**.

### Using PowerShell

You can run the following snippet in an elevated ("Run as administrator")
PowerShell to uninstall SPORTident drivers (including the old SPORTident driver
version 6.7.0 from 2014):

```pwsh
pnputil /enum-drivers | Select-String -Pattern "Provider Name:\s+SPORTident" -Context 2, 0 |
ForEach-Object {
       if ($_.Context.PreContext[0] -match "(oem\d+\.inf)") {
              Write-Host "Uninstalling driver: $($Matches[1])"
              pnputil /delete-driver $Matches[1] /uninstall
              Write-Host
       }
}
```

## Support

Web: https://www.sportident.com  
Email: support@sportident.com
