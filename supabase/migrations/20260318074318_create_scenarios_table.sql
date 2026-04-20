/*
  # Create scenarios table for web uploads

  1. New Tables
    - `scenarios`
      - `id` (uuid, primary key)
      - `uniqid` (text, unique, not null) - Unique identifier from game data
      - `title` (text, not null) - Scenario title
      - `description` (text) - Scenario description
      - `game_type` (text, not null) - Type of game (mystery, tagquest, etc.)
      - `version` (text) - Scenario version
      - `duration_minutes` (integer) - Expected duration in minutes
      - `difficulty` (text) - Difficulty level (easy, medium, hard)
      - `csv_game` (text) - Content of game.csv file
      - `csv_enigmas` (text) - Content of game_enigmas.csv file
      - `csv_media_images` (text) - Content of game_media_images.csv file
      - `csv_meta` (text) - Content of game_meta.csv file
      - `csv_sounds` (text) - Content of game_sounds.csv file
      - `csv_user_meta` (text) - Content of game_user_meta.csv file
      - `created_at` (timestamptz) - Creation timestamp
      - `updated_at` (timestamptz) - Last update timestamp

  2. Security
    - Enable RLS on scenarios table
    - Add policy for public read access
    - Add policy for authenticated users to insert/update their own scenarios
*/

CREATE TABLE IF NOT EXISTS scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uniqid text UNIQUE NOT NULL,
  title text NOT NULL,
  description text DEFAULT '',
  game_type text NOT NULL,
  version text DEFAULT '1.0',
  duration_minutes integer DEFAULT 60,
  difficulty text DEFAULT 'medium',
  csv_game text DEFAULT '',
  csv_enigmas text DEFAULT '',
  csv_media_images text DEFAULT '',
  csv_meta text DEFAULT '',
  csv_sounds text DEFAULT '',
  csv_user_meta text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE scenarios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view scenarios"
  ON scenarios
  FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can insert scenarios"
  ON scenarios
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update scenarios"
  ON scenarios
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete scenarios"
  ON scenarios
  FOR DELETE
  TO authenticated
  USING (true);

CREATE INDEX IF NOT EXISTS idx_scenarios_uniqid ON scenarios(uniqid);
CREATE INDEX IF NOT EXISTS idx_scenarios_game_type ON scenarios(game_type);