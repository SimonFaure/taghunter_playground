/*
  # Allow Public Layout Management

  1. Changes
    - Drop existing authenticated-only policies for layouts
    - Create new policies allowing public (anonymous) access
    - This enables the web version to upload and manage layouts without authentication

  2. Security
    - Public can now INSERT, UPDATE, and DELETE layouts
    - This is acceptable for a local development tool
*/

-- Drop existing restrictive policies
DROP POLICY IF EXISTS "Authenticated users can insert layouts" ON layouts;
DROP POLICY IF EXISTS "Authenticated users can update layouts" ON layouts;
DROP POLICY IF EXISTS "Authenticated users can delete layouts" ON layouts;

-- Create new public policies
CREATE POLICY "Anyone can insert layouts"
  ON layouts FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Anyone can update layouts"
  ON layouts FOR UPDATE
  TO public
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anyone can delete layouts"
  ON layouts FOR DELETE
  TO public
  USING (true);