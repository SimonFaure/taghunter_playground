/*
  # Add game_data_json column to scenarios table

  ## Summary
  Adds a JSONB column `game_data_json` to the `scenarios` table to store the full
  game data structure (including quests for tagquest scenarios) as returned by the
  external API. This enables the web (Supabase) path to access quest data that was
  previously only available in the Electron local file path.

  ## Changes
  - `scenarios` table: adds `game_data_json` (jsonb, nullable, default null)

  ## Notes
  - No data is dropped or modified
  - Existing rows will have NULL for this column until updated
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'scenarios' AND column_name = 'game_data_json'
  ) THEN
    ALTER TABLE scenarios ADD COLUMN game_data_json jsonb DEFAULT NULL;
  END IF;
END $$;
