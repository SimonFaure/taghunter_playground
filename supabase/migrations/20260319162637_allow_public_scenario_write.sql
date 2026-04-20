/*
  # Allow public write access to scenarios table

  The scenarios table previously restricted INSERT/UPDATE/DELETE to authenticated users.
  This app does not use Supabase Auth — uploads happen via the anon key without a session.
  This migration drops the auth-restricted write policies and replaces them with public ones,
  matching the same pattern used for storage.objects (resources bucket).

  ## Changes
  - Drop "Authenticated users can insert scenarios"
  - Drop "Authenticated users can update scenarios"
  - Drop "Authenticated users can delete scenarios"
  - Add "Public users can insert scenarios"
  - Add "Public users can update scenarios"
  - Add "Public users can delete scenarios"
*/

DROP POLICY IF EXISTS "Authenticated users can insert scenarios" ON scenarios;
DROP POLICY IF EXISTS "Authenticated users can update scenarios" ON scenarios;
DROP POLICY IF EXISTS "Authenticated users can delete scenarios" ON scenarios;

CREATE POLICY "Public users can insert scenarios"
  ON scenarios
  FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Public users can update scenarios"
  ON scenarios
  FOR UPDATE
  TO public
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Public users can delete scenarios"
  ON scenarios
  FOR DELETE
  TO public
  USING (true);
