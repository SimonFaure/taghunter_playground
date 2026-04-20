/*
  # Add constraints and index to pattern_balises

  ## Changes
  - Adds unique constraint on (pattern_id, image, position) — one station per position per image per pattern
  - Adds unique constraint on (pattern_id, balise_id) — each station used only once per pattern
  - Adds index on pattern_id for efficient lookups
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'pattern_balises'
      AND constraint_name = 'pattern_balises_pattern_image_position_unique'
  ) THEN
    ALTER TABLE pattern_balises
      ADD CONSTRAINT pattern_balises_pattern_image_position_unique
      UNIQUE (pattern_id, image, position);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'pattern_balises'
      AND constraint_name = 'pattern_balises_pattern_balise_unique'
  ) THEN
    ALTER TABLE pattern_balises
      ADD CONSTRAINT pattern_balises_pattern_balise_unique
      UNIQUE (pattern_id, balise_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pattern_balises_pattern_id_idx
  ON pattern_balises (pattern_id);
