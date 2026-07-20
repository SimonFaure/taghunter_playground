// Per-device team-assignment chips for station-based self-registration
// (Clash 'self' / TagQuest team mode). One toggle chip per team; the selected
// set is the device's hard-locked registration assignment. No selection ⇒ the
// device keeps the legacy pick-any-team grid. Purely presentational - used by
// the launch wizard's step 3 and the in-game Devices modal.
// Design: project_selfregister_team_device_assignment.

export interface RegTeamDef {
  /** 1-based team_number - the value stored in the assignment map. */
  number: number;
  name: string;
}

interface RegAssignChipsProps {
  teams: RegTeamDef[];
  /** Assigned team numbers for this device. */
  value: number[];
  onToggle: (teamNumber: number) => void;
  disabled?: boolean;
  /** Trailing slot - e.g. an "auto" badge or a reset-to-auto button. */
  trailing?: React.ReactNode;
}

export function RegAssignChips({ teams, value, onToggle, disabled, trailing }: RegAssignChipsProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {teams.map((t) => {
        const selected = value.includes(t.number);
        return (
          <button
            key={t.number}
            type="button"
            disabled={disabled}
            onClick={(e) => {
              // Chips may render inside a <label> row (the step-3 device
              // picker) - don't let the click toggle the row's checkbox.
              e.preventDefault();
              e.stopPropagation();
              onToggle(t.number);
            }}
            className={`px-2 py-0.5 rounded-full border text-xs transition disabled:opacity-50 disabled:cursor-not-allowed ${
              selected
                ? 'border-[var(--pg-accent-line)] bg-[var(--pg-accent-tint)] text-[var(--pg-accent-bright)]'
                : 'border-[var(--pg-line)] bg-[var(--pg-surface-2)] text-[var(--pg-text-dim)] hover:border-[var(--pg-line-strong)]'
            }`}
          >
            {t.name}
          </button>
        );
      })}
      {trailing}
    </div>
  );
}
