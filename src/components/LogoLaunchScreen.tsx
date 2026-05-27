import { useEffect, useState } from 'react';
import { readLaunchLogoUrl } from '../utils/launchLogo';
import { resolveLogoEffect, type LogoAnimation } from '../utils/logoEffect';
import { PinExitPrompt } from './PinExitPrompt';

// Branded screen shown instead of the home page at launch when
// `logoScreenOnLaunch` is enabled. Shown once per session, after the
// mandatory-update and first-launch-download gates (see App.tsx). Any
// click/tap or keypress dismisses it and reveals the home page.
//
// When `requirePin` is set (the "Require PIN to exit the logo screen" pref),
// an interaction reveals a PIN prompt over the logo instead of dismissing —
// turning the screen into a step-away kiosk lock. Correct PIN dismisses;
// Cancel returns to the clean logo. F11 still toggles fullscreen either way.

// Bundled fallback, served from public/. The user supplies this asset.
const FALLBACK_LOGO = '/taghunter-logo.png';

interface LogoLaunchScreenProps {
  bgColor: string;
  logoFile: string | null | undefined;
  animation?: LogoAnimation;
  glowColor?: string;
  requirePin?: boolean;
  onDismiss: () => void;
}

export function LogoLaunchScreen({
  bgColor,
  logoFile,
  animation,
  glowColor,
  requirePin = false,
  onDismiss,
}: LogoLaunchScreenProps) {
  const [logoUrl, setLogoUrl] = useState<string>(FALLBACK_LOGO);
  const [showPin, setShowPin] = useState(false);

  // Resolve a custom logo from AppData; fall back to the bundled asset.
  useEffect(() => {
    if (!logoFile) {
      setLogoUrl(FALLBACK_LOGO);
      return;
    }
    let cancelled = false;
    let created: string | null = null;
    void readLaunchLogoUrl(logoFile).then((url) => {
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      if (url) {
        created = url;
        setLogoUrl(url);
      } else {
        setLogoUrl(FALLBACK_LOGO);
      }
    });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [logoFile]);

  // Any key (other than the fullscreen F11 toggle) leaves the screen: it
  // dismisses directly, or — when a PIN is required — reveals the PIN prompt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') return;
      if (requirePin) setShowPin(true);
      else onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss, requirePin]);

  const handleInteract = () => {
    if (requirePin) setShowPin(true);
    else onDismiss();
  };

  const effect = resolveLogoEffect(animation, glowColor);

  return (
    <div
      onClick={handleInteract}
      className="fixed inset-0 z-50 flex items-center justify-center cursor-pointer select-none"
      style={{ backgroundColor: bgColor }}
    >
      <div
        className="relative inline-flex items-center justify-center"
        style={effect.wrapperStyle}
      >
        <img
          src={logoUrl}
          alt=""
          draggable={false}
          className={`max-w-[60vw] max-h-[55vh] object-contain ${effect.imgClassName}`}
        />
        {effect.showShimmer && (
          <span
            aria-hidden
            className="logo-shimmer pointer-events-none absolute inset-0"
            style={{
              WebkitMaskImage: `url("${logoUrl}")`,
              maskImage: `url("${logoUrl}")`,
            }}
          />
        )}
      </div>

      {showPin && (
        <PinExitPrompt
          subtitle="Enter the device PIN to exit."
          onSuccess={onDismiss}
          onCancel={() => setShowPin(false)}
        />
      )}
    </div>
  );
}
