// Settings → Developer → USB driver. The SportIdent reader connects as a
// USB-serial device and needs a vendor driver installed. Recent Windows
// builds block outdated/unsigned serial drivers ("This driver has been
// blocked … does not pass the Windows driver policy"), which leaves the
// reader undetected. This screen auto-detects the driver state and — only
// when there's an actual problem to fix — surfaces the SportIdent signed
// driver and the manual Silicon Labs CP210x workaround.

import { useState } from 'react';
import {
  HardDriveDownload,
  ExternalLink,
  Loader2,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Cable,
  RefreshCw,
  Download,
  Wrench,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useDriverState } from '../../services/useDriverState';
import type { DriverState } from '../../services/cp210xDriver';

// SportIdent's own current signed driver package — the recommended first try.
const DRIVER_URL = 'https://sportident.fr/produit/usb-driver/';
// Manual fallback: the signed Silicon Labs CP210x driver, installed by hand
// when the bundled/blocked driver won't take. Surfaced under "Manual workaround".
const SILABS_CP210X_URL =
  'https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers';
const SPORTIDENT_WORKAROUND_URL =
  'https://docs.sportident.com/products/stations/usb-driver-workaround';

export function UsbDriverScreen() {
  const { state, recheck } = useDriverState();

  // "Show the fix only if needed": a healthy driver and a not-plugged-in
  // reader both need no driver action. For 'unknown' (non-Windows or the
  // probe failed) we still show the fix so the tab is never a dead end.
  const needsFix = state.kind !== 'healthy' && state.kind !== 'device_absent';

  return (
    <div className="space-y-6">
      <DetectionCard state={state} recheck={recheck} />
      {needsFix && <DriverFix />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DetectionCard — auto-detects the CP210x driver state via the Rust
// check_cp210x_driver_state command and renders the matching status. The
// "Install signed driver" button is rendered for the two installable states
// (blocked / not installed) but disabled — the Rust install command is a
// Sprint 2 stub. When unknown (non-Windows or detection failed), the card
// hides entirely and DriverFix carries the screen.
// ─────────────────────────────────────────────────────────────────────────────

function DetectionCard({
  state,
  recheck,
}: {
  state: DriverState;
  recheck: () => void;
}) {
  if (state.kind === 'unknown') return null;

  const v = variantFor(state);
  const installable =
    state.kind === 'blocked_by_policy' || state.kind === 'driver_not_installed';

  return (
    <div className={`rounded-lg p-6 border-2 ${v.border} ${v.bg}`}>
      <div className="flex items-start gap-3">
        <v.Icon className={`${v.iconColor} flex-shrink-0`} size={28} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h2 className={`text-xl font-semibold ${v.titleColor}`}>{v.title}</h2>
            <button
              onClick={recheck}
              title="Re-check"
              className="text-slate-400 hover:text-slate-200 p-1 rounded transition-colors"
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <p className="text-sm text-slate-300 mb-3">{v.body}</p>

          {installable && (
            <button
              disabled
              title="Coming in the next build"
              className="inline-flex items-center gap-2 px-4 py-2 bg-red-600/60 rounded-lg font-medium text-white opacity-60 cursor-not-allowed"
            >
              <HardDriveDownload size={16} />
              Install signed driver
              <span className="text-xs uppercase tracking-wider opacity-80">
                (coming soon)
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface DetectionVariant {
  Icon: typeof CheckCircle2;
  iconColor: string;
  titleColor: string;
  border: string;
  bg: string;
  title: string;
  body: string;
}

function variantFor(state: DriverState): DetectionVariant {
  switch (state.kind) {
    case 'healthy':
      return {
        Icon: CheckCircle2,
        iconColor: 'text-green-400',
        titleColor: 'text-green-300',
        border: 'border-green-500/40',
        bg: 'bg-green-500/10',
        title: 'Reader driver looks good',
        body:
          'Windows loaded the SportIdent reader driver. Plug in your reader' +
          ' and the Hardware tab will show the COM port.',
      };
    case 'blocked_by_policy':
      return {
        Icon: AlertTriangle,
        iconColor: 'text-red-400',
        titleColor: 'text-red-300',
        border: 'border-red-500/50',
        bg: 'bg-red-500/10',
        title: 'Driver blocked by Windows',
        body:
          'A SportIdent reader is plugged in, but Windows refused to load' +
          ' its driver — almost certainly the Vulnerable Driver Blocklist' +
          ' refusing the legacy silabser.sys (the 24H2 / 25H2 case).' +
          ' Installing the signed driver below fixes it; no Memory' +
          ' Integrity change needed.',
      };
    case 'driver_not_installed':
      return {
        Icon: AlertTriangle,
        iconColor: 'text-amber-400',
        titleColor: 'text-amber-300',
        border: 'border-amber-500/50',
        bg: 'bg-amber-500/10',
        title: 'Reader driver not installed',
        body:
          'A SportIdent reader is plugged in, but Windows has no driver for' +
          ' it (Device Manager shows it under "Other devices", code 28).' +
          ' Install the SportIdent USB driver below and the reader will come' +
          ' online.',
      };
    case 'device_absent':
      return {
        Icon: Cable,
        iconColor: 'text-slate-400',
        titleColor: 'text-slate-200',
        border: 'border-slate-700',
        bg: 'bg-slate-700/30',
        title: 'No SportIdent reader detected',
        body:
          'Plug in your reader and this card will refresh automatically. If' +
          ' the reader is plugged in but Device Manager shows a yellow' +
          ' warning, the driver fix will appear here once detected.',
      };
    case 'other_error':
      return {
        Icon: AlertCircle,
        iconColor: 'text-orange-400',
        titleColor: 'text-orange-300',
        border: 'border-orange-500/40',
        bg: 'bg-orange-500/10',
        title: `Device error (code ${state.code})`,
        body:
          'Windows reported an unusual error for the SportIdent reader. The' +
          ' driver fix below may still help; if not, the Event Viewer steps' +
          ' under "Why this happens" name the exact .sys file Windows refused' +
          ' to load.',
      };
    case 'unknown':
      // Unreachable — the card returns null before this point. Kept so the
      // switch is exhaustive for TS.
      return {
        Icon: AlertCircle,
        iconColor: 'text-slate-400',
        titleColor: 'text-slate-200',
        border: 'border-slate-700',
        bg: 'bg-slate-700/30',
        title: 'Unknown',
        body: '',
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DriverFix — the actual remedy, shown only when DetectionCard reports a
// problem. Three blocks: the recommended SportIdent signed driver, the manual
// Silicon Labs CP210x workaround (collapsible steps), and the "why" explainer.
// Relocated here from the Hardware tab so the fix lives in one place.
// ─────────────────────────────────────────────────────────────────────────────

function DriverFix() {
  const [opening, setOpening] = useState(false);
  const [showSteps, setShowSteps] = useState(false);

  const openDriverPage = async () => {
    setOpening(true);
    try {
      await openUrl(DRIVER_URL);
    } finally {
      setOpening(false);
    }
  };

  const openExternal = (url: string) => () => {
    void openUrl(url);
  };

  return (
    <>
      {/* Recommended fix: SportIdent's current signed driver. */}
      <div className="bg-slate-800/50 rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <HardDriveDownload className="text-blue-400" size={24} />
          <div>
            <h2 className="text-xl font-semibold">SportIdent USB driver</h2>
            <p className="text-sm text-slate-400">
              Required for the reader to be detected.
            </p>
          </div>
        </div>

        <p className="text-sm text-slate-300 mb-4">
          Install the current signed SportIdent USB driver. It replaces the
          blocked/missing legacy driver with an HVCI-compatible build —{' '}
          <span className="text-slate-200 font-medium">
            you don't need to disable Memory Integrity
          </span>
          .
        </p>

        <button
          onClick={openDriverPage}
          disabled={opening}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors disabled:opacity-60"
        >
          {opening ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <ExternalLink size={16} />
          )}
          Download SportIdent USB driver
        </button>

        <p className="text-xs text-slate-500 mt-3 font-mono break-all">
          {DRIVER_URL}
        </p>

        <p className="text-xs text-slate-400 mt-4">
          After installing, unplug and replug the reader, then hit the re-check
          button on the status card above — it should turn green.
        </p>
      </div>

      {/* Manual fallback: replace the driver by hand with Silicon Labs CP210x. */}
      <div className="bg-slate-800/50 rounded-lg p-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <Wrench className="text-blue-400" size={24} />
            <div>
              <h2 className="text-xl font-semibold">Manual workaround</h2>
              <p className="text-sm text-slate-400">
                If the installer above doesn't take.
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowSteps((s) => !s)}
            className="flex items-center gap-1.5 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors text-sm shrink-0"
          >
            {showSteps ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            {showSteps ? 'Hide steps' : 'Show steps'}
          </button>
        </div>

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 mb-4 flex items-start gap-2">
          <AlertTriangle className="text-amber-400 flex-shrink-0 mt-0.5" size={18} />
          <div className="text-sm text-slate-300">
            <span className="text-amber-300 font-medium">Temporary workaround.</span>{' '}
            Replacing the bundled SportIdent USB driver by hand with the signed
            Silicon Labs CP210x driver restores the COM port until SportIdent
            ships a permanent fix.
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={openExternal(SILABS_CP210X_URL)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors text-sm"
          >
            <Download size={16} />
            Download Silicon Labs CP210x driver
          </button>
          <button
            onClick={openExternal(SPORTIDENT_WORKAROUND_URL)}
            className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors text-sm"
          >
            <ExternalLink size={16} />
            Open full workaround guide
          </button>
        </div>

        {showSteps && (
          <div className="mt-5">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-3">
              Replace the driver by hand
            </div>
            <ol className="text-sm text-slate-300 space-y-2 list-decimal pl-5 marker:text-slate-500">
              <li>
                Open Windows{' '}
                <span className="text-slate-200">Settings → Apps → Installed apps</span>{' '}
                and uninstall{' '}
                <span className="text-slate-200 font-medium">
                  "Windows Driver Package – SPORTident (sliabenm) Ports"
                </span>
                .
              </li>
              <li>
                Download the Silicon Labs CP210x VCP driver (button above) and
                extract the ZIP. On ARM / Snapdragon PCs, pick the{' '}
                <span className="text-slate-200 font-medium">
                  CP210x Universal Windows Driver
                </span>
                .
              </li>
              <li>
                Plug in the SportIdent reader, then open{' '}
                <span className="text-slate-200">Device Manager</span>.
              </li>
              <li>
                Find the device (listed as{' '}
                <span className="text-slate-200">
                  "SPORTident USB to UART Bridge Controller"
                </span>
                , often with a yellow warning). Right-click it →{' '}
                <span className="text-slate-200">Update driver</span>.
              </li>
              <li>
                Choose{' '}
                <span className="text-slate-200">
                  Browse my computer for drivers → Let me pick from a list → Show
                  All Devices
                </span>
                .
              </li>
              <li>
                Click <span className="text-slate-200">Have Disk… → Browse…</span>,
                open the extracted folder and select{' '}
                <span className="font-mono text-xs text-slate-200">silabser.inf</span>.
              </li>
              <li>
                Select{' '}
                <span className="text-slate-200">
                  "Silicon Labs CP210x USB to UART Bridge"
                </span>{' '}
                and confirm through any warnings.
              </li>
              <li>
                The reader now appears as a COM port.{' '}
                <span className="text-slate-200 font-medium">
                  Repeat steps 3–7 for every additional reader or dongle.
                </span>
              </li>
            </ol>

            <div className="mt-4 space-y-1">
              <p className="text-xs text-slate-500 font-mono break-all">
                {SILABS_CP210X_URL}
              </p>
              <p className="text-xs text-slate-500 font-mono break-all">
                {SPORTIDENT_WORKAROUND_URL}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Why this happens. */}
      <div className="bg-slate-800/50 rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <ShieldAlert className="text-blue-400" size={24} />
          <div>
            <h2 className="text-xl font-semibold">Why this happens</h2>
            <p className="text-sm text-slate-400">
              Memory Integrity and recent Windows 11 feature updates.
            </p>
          </div>
        </div>

        <p className="text-sm text-slate-300 mb-4">
          Recent Windows 11 feature updates (<span className="text-slate-200 font-medium">24H2</span>,{' '}
          <span className="text-slate-200 font-medium">25H2</span>) tighten the
          kernel driver code-integrity policy and turn{' '}
          <span className="text-slate-200 font-medium">Memory Integrity</span>{' '}
          (Core Isolation) on by default. Older USB-serial drivers — including
          the one previously bundled with the SportIdent reader — no longer
          load under the new policy, so the reader stops being detected. The
          signed driver above replaces it with a current HVCI-compatible build.
        </p>

        <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">
          How to verify on your machine
        </div>
        <ul className="text-sm text-slate-300 space-y-2 list-disc pl-5 marker:text-slate-500">
          <li>
            Windows Security →{' '}
            <span className="text-slate-200">Device Security → Core Isolation</span>{' '}
            — if Memory Integrity is{' '}
            <span className="text-slate-200 font-medium">On</span>, that's the
            block.
          </li>
          <li>
            Windows Update →{' '}
            <span className="text-slate-200">Update history</span> — look for a
            recent feature update to 24H2 or 25H2.
          </li>
          <li>
            Event Viewer →{' '}
            <span className="text-slate-200">Windows Logs → System</span>,
            filter by source{' '}
            <span className="font-mono text-xs text-slate-200">
              Microsoft-Windows-CodeIntegrity
            </span>{' '}
            — the blocking entry names the exact{' '}
            <span className="font-mono">.sys</span> file Windows refused to load
            (for advanced diagnosis).
          </li>
        </ul>
      </div>
    </>
  );
}
