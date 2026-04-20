/*
  # Allow public access to scenarios

  1. Changes
    - Drop existing restrictive policies
    - Add new policies allowing public access for all operations
    - This allows the web app to work without authentication

  2. Security Notes
    - Public access is intentional for this use case
    - Users can upload, view, update, and delete scenarios without authentication
*/

DROP POLICY IF EXISTS "Authenticated users can insert scenarios" ON scenarios;
DROP POLICY IF EXISTS "Authenticated users can update scenarios" ON scenarios;
DROP POLICY IF EXISTS "Authenticated users can delete scenarios" ON scenarios;

CREATE POLICY "Anyone can insert scenarios"
  ON scenarios
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update scenarios"
  ON scenarios
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anyone can delete scenarios"
  ON scenarios
  FOR DELETE
  USING (true);
