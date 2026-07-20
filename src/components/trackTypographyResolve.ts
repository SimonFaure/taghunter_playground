/**
 * Resolve a tracks text-element typography spec by walking the inheritance
 * chain - element override (per field) → category default → scenario default.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ DUPLICATED from the studio:                                              │
 * │   studio-taghunter/src/scenarios/bodies/tracks/TypographyEditor.tsx      │
 * │     (the `resolveTypography` helper)                                     │
 * │   taghunter_playground/src/components/trackTypographyResolve.ts          │
 * │ Keep them in sync.                                                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Plan: C:\Users\faure\.claude\plans\tracks-text-elements-categories.md
 */

import { TEXT_ELEMENT_DEFAULT_ALIGN } from './trackTextElementStyle';

/** Per-category typography shape - every field independently optional. */
export interface TextCategoryTypography {
  font?: string;
  font_color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right';
  shadow?: boolean;
  background?: boolean;
}

/** Fully resolved typography - every field has a concrete value. */
export interface ResolvedTypography {
  font: string;       // '' = none / use renderer default
  font_color: string; // hex (or '' meaning "renderer fallback")
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: 'left' | 'center' | 'right';
  shadow: boolean;
  background: boolean;
}

export function resolveTypography(args: {
  element?: TextCategoryTypography;
  category?: TextCategoryTypography;
  scenarioFont: string;
  scenarioFontColor: string;
}): ResolvedTypography {
  const { element, category, scenarioFont, scenarioFontColor } = args;
  // Helper picks the first defined value across element → category → fallback.
  const pick = <K extends keyof TextCategoryTypography>(
    key: K,
    fallback: NonNullable<TextCategoryTypography[K]>,
  ): NonNullable<TextCategoryTypography[K]> => {
    if (element && element[key] !== undefined) return element[key] as NonNullable<TextCategoryTypography[K]>;
    if (category && category[key] !== undefined) return category[key] as NonNullable<TextCategoryTypography[K]>;
    return fallback;
  };
  return {
    font: pick('font', scenarioFont || ''),
    font_color: pick('font_color', scenarioFontColor || ''),
    bold: pick('bold', false),
    italic: pick('italic', false),
    underline: pick('underline', false),
    align: pick('align', TEXT_ELEMENT_DEFAULT_ALIGN),
    shadow: pick('shadow', false),
    background: pick('background', false),
  };
}
