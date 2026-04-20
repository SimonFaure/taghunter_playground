/*
  # Make team start_time and end_time nullable

  1. Changes
    - Alter `teams` table to make `start_time` column nullable
    - Alter `teams` table to make `end_time` column nullable
  
  2. Notes
    - Teams may not have started or ended yet, so these fields should be optional
    - This allows inserting teams without timestamps
*/

ALTER TABLE teams 
  ALTER COLUMN start_time DROP NOT NULL,
  ALTER COLUMN end_time DROP NOT NULL;
