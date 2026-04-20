/*
  # Drop csv_* columns from scenarios table

  ## Summary
  Removes the six CSV storage columns from the `scenarios` table. Game data is now
  stored as structured JSON in the `game_data_json` column instead of raw CSV text.

  ## Changes
  - `scenarios` table: drops `csv_game`, `csv_enigmas`, `csv_media_images`,
    `csv_meta`, `csv_sounds`, `csv_user_meta` columns

  ## Notes
  - The `game_data_json` (jsonb) column already exists and replaces these columns
  - No other data is modified or dropped
*/

ALTER TABLE scenarios
  DROP COLUMN IF EXISTS csv_game,
  DROP COLUMN IF EXISTS csv_enigmas,
  DROP COLUMN IF EXISTS csv_media_images,
  DROP COLUMN IF EXISTS csv_meta,
  DROP COLUMN IF EXISTS csv_sounds,
  DROP COLUMN IF EXISTS csv_user_meta;
