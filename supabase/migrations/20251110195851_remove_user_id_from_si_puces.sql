/*
  # Remove user_id column from si_puces table

  1. Changes
    - Remove `user_id` column from `si_puces` table
  
  2. Notes
    - This is a non-destructive column removal
    - The column was nullable and not used in the application
*/

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'si_puces' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE si_puces DROP COLUMN user_id;
  END IF;
END $$;