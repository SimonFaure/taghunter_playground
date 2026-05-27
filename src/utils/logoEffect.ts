// Single source of truth for the logo-screen ambient animation, shared by the
// real launch screen (LogoLaunchScreen) and the settings live preview
// (ConfigurationPage) so the two can never drift.
//
// All effects are driven by CSS in index.css (the `logo-anim-*` classes and
// the `.logo-shimmer` overlay). The glow colour is passed down as the
// `--logo-glow` custom property on the wrapper, so one keyframe set serves any
// colour. The glow uses `filter: drop-shadow`, which follows the logo's alpha
// silhouette — transparent logos glow by their shape, opaque ones by their
// bounding rectangle (an accepted limitation; "transparent works best").

import type { CSSProperties } from 'react';

export type LogoAnimation = 'none' | 'pulse' | 'pulse-scale' | 'static' | 'shimmer';

// Operator-facing labels for the settings dropdown. Listed in escalation order.
export const LOGO_ANIMATION_OPTIONS: { value: LogoAnimation; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'pulse', label: 'Pulsing glow' },
  { value: 'pulse-scale', label: 'Pulsing glow + scale' },
  { value: 'static', label: 'Static glow' },
  { value: 'shimmer', label: 'Shimmer sweep' },
];

export const DEFAULT_LOGO_ANIMATION: LogoAnimation = 'pulse';
export const DEFAULT_LOGO_GLOW = '#FFFFFF';

export interface ResolvedLogoEffect {
  // Class added to the <img> (the breathing/static glow). Empty for none/shimmer.
  imgClassName: string;
  // Goes on the wrapper around the logo. Sets `--logo-glow` so both the image
  // glow and the shimmer overlay pick the colour up by inheritance. Empty for
  // `none` (no colour needed when nothing renders).
  wrapperStyle: CSSProperties;
  // Whether to render the masked `.logo-shimmer` sheen overlay over the logo.
  showShimmer: boolean;
}

export function resolveLogoEffect(
  animation: LogoAnimation | undefined,
  glowColor: string | undefined,
): ResolvedLogoEffect {
  const color = glowColor || DEFAULT_LOGO_GLOW;
  const wrapperStyle = { '--logo-glow': color } as CSSProperties;
  switch (animation ?? DEFAULT_LOGO_ANIMATION) {
    case 'pulse':
      return { imgClassName: 'logo-anim-pulse', wrapperStyle, showShimmer: false };
    case 'pulse-scale':
      return { imgClassName: 'logo-anim-pulse-scale', wrapperStyle, showShimmer: false };
    case 'static':
      return { imgClassName: 'logo-anim-static', wrapperStyle, showShimmer: false };
    case 'shimmer':
      return { imgClassName: '', wrapperStyle, showShimmer: true };
    case 'none':
    default:
      return { imgClassName: '', wrapperStyle: {}, showShimmer: false };
  }
}
