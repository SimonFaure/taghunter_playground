/*
  # Allow public access to scenario media

  1. Changes
    - Drop existing restrictive policies on scenario_media
    - Add new policies allowing public access for all operations
    - This allows the web app to work without authentication

  2. Security Notes
    - Public access is intentional for this use case
    - Users can upload, view, update, and delete media without authentication
*/

DROP POLICY IF EXISTS "Authenticated users can insert scenario media" ON scenario_media;
DROP POLICY IF EXISTS "Authenticated users can update scenario media" ON scenario_media;
DROP POLICY IF EXISTS "Authenticated users can delete scenario media" ON scenario_media;

CREATE POLICY "Anyone can insert scenario media"
  ON scenario_media
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update scenario media"
  ON scenario_media
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anyone can delete scenario media"
  ON scenario_media
  FOR DELETE
  USING (true);
