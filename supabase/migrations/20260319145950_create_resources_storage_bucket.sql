/*
  # Create resources storage bucket

  ## Purpose
  Creates a public Supabase Storage bucket called "resources" to store uploaded files
  for the web version of the app. This replaces localStorage for patterns, layouts, and cards.

  ## Bucket Structure
  - resources/
    - scenarios/{uniqid}/          → scenario game-data.json and CSV files
    - patterns/{game_type}/        → pattern JSON/CSV files (one folder per game type)
    - layouts/                     → layout JSON files
    - cards/                       → card CSV files

  ## Security
  - Public read access so the app can fetch files without auth
  - Public insert/update/delete so the app can write files without auth
    (this app does not use auth for uploads — same policy as game-media bucket)
*/

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'resources',
  'resources',
  true,
  52428800,
  ARRAY[
    'application/json',
    'text/csv',
    'text/plain',
    'application/octet-stream'
  ]
)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
    AND tablename = 'objects'
    AND policyname = 'Public read access for resources'
  ) THEN
    CREATE POLICY "Public read access for resources"
      ON storage.objects
      FOR SELECT
      TO public
      USING (bucket_id = 'resources');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
    AND tablename = 'objects'
    AND policyname = 'Public insert access for resources'
  ) THEN
    CREATE POLICY "Public insert access for resources"
      ON storage.objects
      FOR INSERT
      TO public
      WITH CHECK (bucket_id = 'resources');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
    AND tablename = 'objects'
    AND policyname = 'Public update access for resources'
  ) THEN
    CREATE POLICY "Public update access for resources"
      ON storage.objects
      FOR UPDATE
      TO public
      USING (bucket_id = 'resources')
      WITH CHECK (bucket_id = 'resources');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
    AND tablename = 'objects'
    AND policyname = 'Public delete access for resources'
  ) THEN
    CREATE POLICY "Public delete access for resources"
      ON storage.objects
      FOR DELETE
      TO public
      USING (bucket_id = 'resources');
  END IF;
END $$;
