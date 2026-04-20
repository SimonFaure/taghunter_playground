/*
  # Remove created_at column from teams table

  1. Changes
    - Drop `created_at` column from `teams` table
  
  2. Notes
    - This column is not needed for the teams functionality
    - Removing unnecessary columns keeps the schema clean
*/

ALTER TABLE teams DROP COLUMN IF EXISTS created_at;
