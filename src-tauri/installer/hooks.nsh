; NSIS installer hooks for Tag Hunter Playground.
;
; Adds a Windows Firewall rule so the mother device's LAN server accepts inbound
; TCP from satellites joined to its hotspot. Windows classes the hotspot as a
; "Public" network and blocks custom inbound TCP by default, which is why a mother
; is discoverable over mDNS (multicast is allowed) yet unreachable over HTTP.
;
; These netsh calls require elevation. When the installer runs elevated they add
; the rule at install time; on a normal per-user (unelevated) install they
; silently no-op and the app's runtime one-time UAC fallback (firewall.ts →
; mother_open_firewall_elevated) adds the rule instead. Both are idempotent
; (delete-then-add), so running both paths never leaves duplicate rules.

!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec 'netsh advfirewall firewall delete rule name="TagHunter Playground LAN"'
  ; TCP for the mother's axum server; UDP for mDNS discovery (5353) so satellites
  ; can DETECT the mother. Both are required - discovery is UDP, pairing is TCP.
  nsExec::Exec 'netsh advfirewall firewall add rule name="TagHunter Playground LAN" dir=in action=allow enable=yes profile=any protocol=TCP program="$INSTDIR\${MAINBINARYNAME}.exe"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="TagHunter Playground LAN" dir=in action=allow enable=yes profile=any protocol=UDP program="$INSTDIR\${MAINBINARYNAME}.exe"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  nsExec::Exec 'netsh advfirewall firewall delete rule name="TagHunter Playground LAN"'
!macroend
