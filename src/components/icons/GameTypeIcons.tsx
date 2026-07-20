import React from 'react';

/**
 * TagHunter game-type icons
 * --------------------------
 * Lucide-style line icons (24×24, stroke = currentColor, round caps/joins) so
 * they sit naturally next to the lucide-react icons used across the Playground.
 *
 * Per-type icons:
 *   import { GameTypeIcon, gameTypeIcons } from './icons/GameTypeIcons';
 *   <GameTypeIcon type={scenario.game_type.name} className="w-4 h-4" />
 *   <TagQuestIcon size={20} />
 *
 * They inherit text color via `currentColor`, so Tailwind text-* classes work.
 */

export interface GameTypeIconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  strokeWidth?: number | string;
}

const IconBase = React.forwardRef<SVGSVGElement, GameTypeIconProps & { children: React.ReactNode }>(
  ({ size = 24, strokeWidth = 2, children, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
);
IconBase.displayName = 'IconBase';

/** TagQuest - a tag with a check: punch tag cards to complete quest objectives. */
export const TagQuestIcon = React.forwardRef<SVGSVGElement, GameTypeIconProps>((props, ref) => (
  <IconBase ref={ref} {...props}>
    <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
    <circle cx="7.5" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
    <path d="m10.4 12.6 1.8 1.8 3.7-3.7" />
  </IconBase>
));
TagQuestIcon.displayName = 'TagQuestIcon';

/** Mystery - magnifying glass with a question mark: solve enigmas. */
export const MysteryIcon = React.forwardRef<SVGSVGElement, GameTypeIconProps>((props, ref) => (
  <IconBase ref={ref} {...props}>
    <circle cx="10" cy="10" r="7" />
    <path d="m20 20-4.95-4.95" />
    <path d="M8.4 8.6a1.7 1.7 0 0 1 3.3.55c0 1.2-1.7 1.6-1.7 2.6" />
    <path d="M10 14.4h.01" />
  </IconBase>
));
MysteryIcon.displayName = 'MysteryIcon';

/** Tracks - a route from start node to destination: itinerary + checkpoints. */
export const TracksIcon = React.forwardRef<SVGSVGElement, GameTypeIconProps>((props, ref) => (
  <IconBase ref={ref} {...props}>
    <circle cx="6" cy="19" r="3" />
    <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
    <circle cx="18" cy="5" r="3" />
  </IconBase>
));
TracksIcon.displayName = 'TracksIcon';

/** Clash - crossed swords: clans / territories competing. */
export const ClashIcon = React.forwardRef<SVGSVGElement, GameTypeIconProps>((props, ref) => (
  <IconBase ref={ref} {...props}>
    <polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5" />
    <line x1="13" x2="19" y1="19" y2="13" />
    <line x1="16" x2="20" y1="16" y2="20" />
    <line x1="19" x2="21" y1="21" y2="19" />
    <polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5" />
    <line x1="5" x2="9" y1="14" y2="18" />
    <line x1="7" x2="4" y1="17" y2="20" />
    <line x1="3" x2="5" y1="19" y2="21" />
  </IconBase>
));
ClashIcon.displayName = 'ClashIcon';

/** Convenience map keyed by game type slug. */
export const gameTypeIcons = {
  tagquest: TagQuestIcon,
  mystery: MysteryIcon,
  tracks: TracksIcon,
  clash: ClashIcon,
} as const;

export type GameType = keyof typeof gameTypeIcons;

/**
 * Resolve a (possibly free-form) game-type string to its icon. Accepts the
 * canonical slug ('tagquest') or a display name ('TagQuest', 'Mystery') - both
 * normalize via lowercase. Renders nothing for an unknown type.
 */
export function GameTypeIcon({
  type,
  ...props
}: GameTypeIconProps & { type: string | null | undefined }) {
  const Icon = gameTypeIcons[(type || '').toLowerCase() as GameType];
  return Icon ? <Icon {...props} /> : null;
}
