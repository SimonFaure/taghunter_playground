// Settings → Developer → USB driver. The SportIdent reader connects as a
// USB-serial device and needs a vendor driver installed. Recent Windows
// builds block outdated/unsigned serial drivers ("This driver has been
// blocked … does not pass the Windows driver policy"), which leaves the
// reader undetected. This screen points operators at the current signed
// SportIdent USB driver package.

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
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useDriverState } from '../../services/useDriverState';
import type { DriverState } from '../../services/cp210xDriver';

const DRIVER_URL = 'https://sportident.fr/produit/usb-driver/';

export function UsbDriverScreen() {
  const [opening, setOpening] = useState(false);

  const openDriverPage = async () => {
    setOpening(true);
    try {
      await openUrl(DRIVER_URL);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="space-y-6">
      <DetectionCard />

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
          The SportIdent reader connects as a USB-serial device and needs the
          SportIdent USB driver installed. If the reader isn't detected — or
          Windows reports that the driver was{' '}
          <span className="text-slate-200 font-medium">blocked</span> because it
          "does not pass the Windows driver policy" — install the current
          signed driver from the link below.
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
          After installing, unplug and replug the reader, then check the{' '}
          <span className="text-slate-300">Hardware</span> tab — the reader
          status should turn green.
        </p>
      </div>

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
          installer above replaces it with a current signed, HVCI-compatible
          build —{' '}
          <span className="text-slate-200 font-medium">
            you don't need to disable Memory Integrity
          </span>
          .
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
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DetectionCard — Sprint 1 of the bundled-installer feature. Auto-detects the
// CP210x driver state via the Rust check_cp210x_driver_state command and
// renders one of four visual states. The "Install signed driver" button is
// rendered for blocked_by_policy but disabled — the Rust install command is
// a Sprint 2 stub. When unknown (non-Windows or detection failed), the card
// hides entirely and the existing manual cards below carry the screen.
// ─────────────────────────────────────────────────────────────────────────────

function DetectionCard() {
  const { state, recheck } = useDriverState();

  if (state.kind === 'unknown') return null;

  const v = variantFor(state);

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

          {state.kind === 'blocked_by_policy' && (
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
          ' Installing the signed Universal driver fixes it; no Memory' +
          ' Integrity change needed.',
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
          ' warning, the section below explains the known driver-policy' +
          ' block.',
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
          ' driver-block fix below may still help; if not, the Event Viewer' +
          ' steps under "Why this happens" name the exact .sys file Windows' +
          ' refused to load.',
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
