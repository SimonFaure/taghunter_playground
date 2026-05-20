import { useEffect, useState } from 'react';
import { readLaunchLogoUrl } from '../utils/launchLogo';

// Branded screen shown instead of the home page at launch when
// `logoScreenOnLaunch` is enabled. Shown once per session, after the
// mandatory-update and first-launch-download gates (see App.tsx). Any
// click/tap or keypress dismisses it and reveals the home page.

// Bundled fallback, served from public/. The user supplies this asset.
const FALLBACK_LOGO = '/taghunter-logo.png';

interface LogoLaunchScreenProps {
  bgColor: string;
  logoFile: string | null | undefined;
  onDismiss: () => void;
}

export function LogoLaunchScreen({
  bgColor,
  logoFile,
  onDismiss,
}: LogoLaunchScreenProps) {
  const [logoUrl, setLogoUrl] = useState<string>(FALLBACK_LOGO);

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

  // Any key (other than the fullscreen F11 toggle) dismisses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F11') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      onClick={onDismiss}
      className="fixed inset-0 z-50 flex items-center justify-center cursor-pointer select-none"
      style={{ backgroundColor: bgColor }}
    >
      <img
        src={logoUrl}
        alt=""
        draggable={false}
        className="max-w-[60vw] max-h-[55vh] object-contain"
      />
    </div>
  );
}
