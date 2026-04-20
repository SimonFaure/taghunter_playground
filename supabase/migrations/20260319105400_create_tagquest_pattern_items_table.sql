/*
  # Create tagquest_pattern_items table

  ## Purpose
  Stores TagQuest pattern station assignments. Each row maps a quest (item_index)
  and an image slot (assignment_type, e.g. "image_1", "image_2") to a physical
  station key number (station_key_number).

  ## New Tables
  - `tagquest_pattern_items`
    - `id` (uuid, primary key)
    - `pattern_id` (uuid, FK → patterns.id)
    - `item_index` (integer) — quest row number (1–6)
    - `assignment_type` (text) — image column identifier, e.g. "image_1"
    - `station_key_number` (integer) — station balise number for this cell
    - `created_at` (timestamptz)

  ## Security
  - RLS enabled
  - Public SELECT policy (pattern data is read-only reference data)
  - Authenticated INSERT/UPDATE/DELETE
*/

CREATE TABLE IF NOT EXISTS tagquest_pattern_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id uuid NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  item_index integer NOT NULL,
  assignment_type text NOT NULL,
  station_key_number integer NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE tagquest_pattern_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read tagquest pattern items"
  ON tagquest_pattern_items FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can insert tagquest pattern items"
  ON tagquest_pattern_items FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update tagquest pattern items"
  ON tagquest_pattern_items FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete tagquest pattern items"
  ON tagquest_pattern_items FOR DELETE
  TO authenticated
  USING (true);

CREATE INDEX IF NOT EXISTS idx_tagquest_pattern_items_pattern_id
  ON tagquest_pattern_items(pattern_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tagquest_pattern_items_unique
  ON tagquest_pattern_items(pattern_id, item_index, assignment_type);
