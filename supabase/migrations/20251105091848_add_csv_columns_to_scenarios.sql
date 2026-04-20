/*
  # Add CSV columns to scenarios table

  1. Changes
    - Add `uniqid` column (text, unique) to store the unique identifier from CSV
    - Add `slug` column (text) to store the URL-friendly version of the title
    - Add `origin` column (text) to store the source/origin of the scenario
    - Add `updated_at` column (timestamptz) to track last update time
    
  2. Notes
    - The `uniqid` column will be unique to ensure no duplicate scenarios
    - Nullable initially to accommodate existing records, can be made NOT NULL after data migration
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'scenarios' AND column_name = 'uniqid'
  ) THEN
    ALTER TABLE scenarios ADD COLUMN uniqid text UNIQUE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'scenarios' AND column_name = 'slug'
  ) THEN
    ALTER TABLE scenarios ADD COLUMN slug text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'scenarios' AND column_name = 'origin'
  ) THEN
    ALTER TABLE scenarios ADD COLUMN origin text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'scenarios' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE scenarios ADD COLUMN updated_at timestamptz DEFAULT now();
  END IF;
END $$;