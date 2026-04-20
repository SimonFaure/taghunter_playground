/*
  # Drop scenarios table

  1. Changes
    - Drop scenario_files table (depends on scenarios)
    - Drop scenarios table
    - Keep game_types table intact

  2. Security
    - Removes all RLS policies associated with dropped tables
*/

DROP TABLE IF EXISTS scenario_files CASCADE;
DROP TABLE IF EXISTS scenarios CASCADE;
