/**
 * Style constants for tracks text elements - shared between the studio editor
 * and the playground runtime so both surfaces render visually identical.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ DUPLICATED VERBATIM - keep in sync with the studio:                      │
 * │   studio-taghunter/src/scenarios/bodies/tracks/textElementStyle.ts       │
 * │   taghunter_playground/src/components/trackTextElementStyle.ts           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Plan: C:\Users\faure\.claude\plans\tracks-text-elements.md
 */

import type { CSSProperties } from 'react';

/**
 * Default position + size for a newly placed text element, in % of the
 * LayoutEditor viewport. Authored values override this - included here only
 * for parity with the studio side.
 */
export const TEXT_ELEMENT_DEFAULT_POSITION = {
  left: 35,
  top: 45,
  width: 30,
  height: 10,
} as const;

/**
 * CSS `text-shadow` applied when `shadow: true`. Tuned for readability over
 * busy map backgrounds; deliberately not configurable in v1.
 */
export const TEXT_ELEMENT_SHADOW_CSS = '0 2px 4px rgba(0, 0, 0, 0.6)';

/**
 * CSS bundle applied when `background: true`. Translucent dark rounded fill
 * with light padding - chip-like, readable against any map.
 */
export const TEXT_ELEMENT_BACKGROUND_CSS: CSSProperties = {
  backgroundColor: 'rgba(0, 0, 0, 0.45)',
  padding: '0.2em 0.4em',
  borderRadius: '0.3em',
};

/** Default horizontal alignment when `align` is unset on an element. */
export const TEXT_ELEMENT_DEFAULT_ALIGN: 'left' | 'center' | 'right' = 'center';
