/*
  # Add media storage for scenarios

  1. New Tables
    - `scenario_media`
      - `id` (uuid, primary key)
      - `scenario_uniqid` (text, foreign key to scenarios.uniqid)
      - `filename` (text, not null) - Name of the media file
      - `media_type` (text, not null) - Type: 'image', 'sound', or 'video'
      - `data` (text, not null) - Base64 encoded media data
      - `created_at` (timestamptz) - Creation timestamp

  2. Security
    - Enable RLS on scenario_media table
    - Add policy for public read access
    - Add policy for authenticated users to insert/update/delete media

  3. Indexes
    - Index on scenario_uniqid for faster lookups
    - Index on media_type for filtering
*/

CREATE TABLE IF NOT EXISTS scenario_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_uniqid text NOT NULL REFERENCES scenarios(uniqid) ON DELETE CASCADE,
  filename text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('image', 'sound', 'video')),
  data text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(scenario_uniqid, filename, media_type)
);

ALTER TABLE scenario_media ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view scenario media"
  ON scenario_media
  FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can insert scenario media"
  ON scenario_media
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update scenario media"
  ON scenario_media
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete scenario media"
  ON scenario_media
  FOR DELETE
  TO authenticated
  USING (true);

CREATE INDEX IF NOT EXISTS idx_scenario_media_scenario_uniqid ON scenario_media(scenario_uniqid);
CREATE INDEX IF NOT EXISTS idx_scenario_media_media_type ON scenario_media(media_type);
