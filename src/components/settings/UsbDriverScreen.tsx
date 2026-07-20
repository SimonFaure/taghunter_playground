// Settings → Developer → USB driver. The SportIdent reader connects as a
// USB-serial device and needs a vendor driver installed. Recent Windows
// builds block outdated/unsigned serial drivers ("This driver has been
// blocked … does not pass the Windows driver policy"), which leaves the
// reader undetected. This screen auto-detects the driver state and - only
// when there's an actual problem to fix - surfaces the SportIdent signed
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
  Info,
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useTranslation, Trans } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useDriverState } from '../../services/useDriverState';
import type { DriverState } from '../../services/cp210xDriver';

// SportIdent's own current signed driver package - the recommended first try.
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
      <UsbDriverExplainer />
      <DetectionCard state={state} recheck={recheck} />
      {needsFix && <DriverFix />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UsbDriverExplainer - what this tab is for, in one box, so an operator who
// lands here knows it's about the physical card reader's Windows driver (not
// content Sync or app Updates).
// ─────────────────────────────────────────────────────────────────────────────

function UsbDriverExplainer() {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 text-sm text-[var(--pg-text-muted)] bg-[var(--pg-surface-2)] border border-[var(--pg-line)] rounded-lg p-3">
      <Info className="w-4 h-4 mt-0.5 shrink-0 text-[var(--pg-text-dim)]" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-[var(--pg-text)]">{t('usbDriver:explainer.title')}</div>
        <p>{t('usbDriver:explainer.body')}</p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DetectionCard - auto-detects the CP210x driver state via the Rust
// check_cp210x_driver_state command and renders the matching status. The
// "Install signed driver" button is rendered for the two installable states
// (blocked / not installed) but disabled - the Rust install command is a
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
  const { t } = useTranslation();
  if (state.kind === 'unknown') return null;

  const v = variantFor(state, t);
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
              title={t('usbDriver:detection.recheck')}
              className="text-[var(--pg-text-dim)] hover:text-[var(--pg-text)] p-1 rounded transition-colors"
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <p className="text-sm text-[var(--pg-text-muted)] mb-3">{v.body}</p>

          {installable && (
            <button
              disabled
              title={t('usbDriver:detection.installTitle')}
              className="pg-btn pg-btn--primary cursor-not-allowed"
            >
              <HardDriveDownload size={16} />
              {t('usbDriver:detection.install')}
              <span className="text-xs uppercase tracking-wider opacity-80">
                {t('usbDriver:detection.comingSoon')}
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

function variantFor(state: DriverState, t: TFunction): DetectionVariant {
  switch (state.kind) {
    case 'healthy':
      return {
        Icon: CheckCircle2,
        iconColor: 'text-green-400',
        titleColor: 'text-green-300',
        border: 'border-green-500/40',
        bg: 'bg-green-500/10',
        title: t('usbDriver:variant.healthy.title'),
        body: t('usbDriver:variant.healthy.body'),
      };
    case 'blocked_by_policy':
      return {
        Icon: AlertTriangle,
        iconColor: 'text-red-400',
        titleColor: 'text-red-300',
        border: 'border-red-500/50',
        bg: 'bg-red-500/10',
        title: t('usbDriver:variant.blockedByPolicy.title'),
        body: t('usbDriver:variant.blockedByPolicy.body'),
      };
    case 'driver_not_installed':
      return {
        Icon: AlertTriangle,
        iconColor: 'text-amber-400',
        titleColor: 'text-amber-300',
        border: 'border-amber-500/50',
        bg: 'bg-amber-500/10',
        title: t('usbDriver:variant.driverNotInstalled.title'),
        body: t('usbDriver:variant.driverNotInstalled.body'),
      };
    case 'device_absent':
      return {
        Icon: Cable,
        iconColor: 'text-[var(--pg-text-dim)]',
        titleColor: 'text-[var(--pg-text)]',
        border: 'border-[var(--pg-line)]',
        bg: 'bg-[var(--pg-surface-2)]',
        title: t('usbDriver:variant.deviceAbsent.title'),
        body: t('usbDriver:variant.deviceAbsent.body'),
      };
    case 'other_error':
      return {
        Icon: AlertCircle,
        iconColor: 'text-orange-400',
        titleColor: 'text-orange-300',
        border: 'border-orange-500/40',
        bg: 'bg-orange-500/10',
        title: t('usbDriver:variant.otherError.title', { code: state.code }),
        body: t('usbDriver:variant.otherError.body'),
      };
    case 'unknown':
      // Unreachable - the card returns null before this point. Kept so the
      // switch is exhaustive for TS.
      return {
        Icon: AlertCircle,
        iconColor: 'text-[var(--pg-text-dim)]',
        titleColor: 'text-[var(--pg-text)]',
        border: 'border-[var(--pg-line)]',
        bg: 'bg-[var(--pg-surface-2)]',
        title: t('usbDriver:variant.unknown.title'),
        body: t('usbDriver:variant.unknown.body'),
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DriverFix - the actual remedy, shown only when DetectionCard reports a
// problem. Three blocks: the recommended SportIdent signed driver, the manual
// Silicon Labs CP210x workaround (collapsible steps), and the "why" explainer.
// Relocated here from the Hardware tab so the fix lives in one place.
// ─────────────────────────────────────────────────────────────────────────────

function DriverFix() {
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);
  const [showSteps, setShowSteps] = useState(false);

  // Shared inline-emphasis components for the <Trans> steps / verify list.
  const emph = {
    1: <span className="text-[var(--pg-text)]" />,
    2: <span className="text-[var(--pg-text)] font-medium" />,
    code: <span className="font-mono text-xs text-[var(--pg-text)]" />,
    mono: <span className="font-mono" />,
  };

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
      <div className="pg-panel">
        <div className="flex items-center gap-3 mb-4">
          <HardDriveDownload className="text-[var(--pg-accent-bright)]" size={24} />
          <div>
            <h2 className="text-xl font-semibold text-[var(--pg-text)]">{t('usbDriver:sportident.title')}</h2>
            <p className="text-sm text-[var(--pg-text-dim)]">
              {t('usbDriver:sportident.subtitle')}
            </p>
          </div>
        </div>

        <p className="text-sm text-[var(--pg-text-muted)] mb-4">
          <Trans
            i18nKey="usbDriver:sportident.body"
            components={{ 1: <span className="text-[var(--pg-text)] font-medium" /> }}
          />
        </p>

        <button
          onClick={openDriverPage}
          disabled={opening}
          className="pg-btn pg-btn--primary"
        >
          {opening ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <ExternalLink size={16} />
          )}
          {t('usbDriver:sportident.download')}
        </button>

        <p className="text-xs text-[var(--pg-text-dim)] mt-3 font-mono break-all">
          {DRIVER_URL}
        </p>

        <p className="text-xs text-[var(--pg-text-dim)] mt-4">
          {t('usbDriver:sportident.afterInstall')}
        </p>
      </div>

      {/* Manual fallback: replace the driver by hand with Silicon Labs CP210x. */}
      <div className="pg-panel">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <Wrench className="text-[var(--pg-accent-bright)]" size={24} />
            <div>
              <h2 className="text-xl font-semibold text-[var(--pg-text)]">{t('usbDriver:manual.title')}</h2>
              <p className="text-sm text-[var(--pg-text-dim)]">
                {t('usbDriver:manual.subtitle')}
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowSteps((s) => !s)}
            className="pg-btn pg-btn--sm shrink-0"
          >
            {showSteps ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            {showSteps ? t('usbDriver:manual.hideSteps') : t('usbDriver:manual.showSteps')}
          </button>
        </div>

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 mb-4 flex items-start gap-2">
          <AlertTriangle className="text-amber-400 flex-shrink-0 mt-0.5" size={18} />
          <div className="text-sm text-[var(--pg-text-muted)]">
            <Trans
              i18nKey="usbDriver:manual.warning"
              components={{ 1: <span className="text-amber-300 font-medium" /> }}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={openExternal(SILABS_CP210X_URL)}
            className="pg-btn pg-btn--primary"
          >
            <Download size={16} />
            {t('usbDriver:manual.downloadSilabs')}
          </button>
          <button
            onClick={openExternal(SPORTIDENT_WORKAROUND_URL)}
            className="pg-btn"
          >
            <ExternalLink size={16} />
            {t('usbDriver:manual.openGuide')}
          </button>
        </div>

        {showSteps && (
          <div className="mt-5">
            <div className="text-xs uppercase tracking-wider text-[var(--pg-text-dim)] mb-3">
              {t('usbDriver:manual.stepsHeading')}
            </div>
            <ol className="text-sm text-[var(--pg-text-muted)] space-y-2 list-decimal pl-5 marker:text-[var(--pg-text-dim)]">
              <li><Trans i18nKey="usbDriver:manual.step1" components={emph} /></li>
              <li><Trans i18nKey="usbDriver:manual.step2" components={emph} /></li>
              <li><Trans i18nKey="usbDriver:manual.step3" components={emph} /></li>
              <li><Trans i18nKey="usbDriver:manual.step4" components={emph} /></li>
              <li><Trans i18nKey="usbDriver:manual.step5" components={emph} /></li>
              <li><Trans i18nKey="usbDriver:manual.step6" components={emph} /></li>
              <li><Trans i18nKey="usbDriver:manual.step7" components={emph} /></li>
              <li><Trans i18nKey="usbDriver:manual.step8" components={emph} /></li>
            </ol>

            <div className="mt-4 space-y-1">
              <p className="text-xs text-[var(--pg-text-dim)] font-mono break-all">
                {SILABS_CP210X_URL}
              </p>
              <p className="text-xs text-[var(--pg-text-dim)] font-mono break-all">
                {SPORTIDENT_WORKAROUND_URL}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Why this happens. */}
      <div className="pg-panel">
        <div className="flex items-center gap-3 mb-4">
          <ShieldAlert className="text-[var(--pg-accent-bright)]" size={24} />
          <div>
            <h2 className="text-xl font-semibold text-[var(--pg-text)]">{t('usbDriver:why.title')}</h2>
            <p className="text-sm text-[var(--pg-text-dim)]">
              {t('usbDriver:why.subtitle')}
            </p>
          </div>
        </div>

        <p className="text-sm text-[var(--pg-text-muted)] mb-4">
          <Trans i18nKey="usbDriver:why.body" components={emph} />
        </p>

        <div className="text-xs uppercase tracking-wider text-[var(--pg-text-dim)] mb-2">
          {t('usbDriver:why.verifyHeading')}
        </div>
        <ul className="text-sm text-[var(--pg-text-muted)] space-y-2 list-disc pl-5 marker:text-[var(--pg-text-dim)]">
          <li><Trans i18nKey="usbDriver:why.verify1" components={emph} /></li>
          <li><Trans i18nKey="usbDriver:why.verify2" components={emph} /></li>
          <li><Trans i18nKey="usbDriver:why.verify3" components={emph} /></li>
        </ul>
      </div>
    </>
  );
}
