/*
  # Create launched_game_meta table

  1. New Tables
    - `launched_game_meta`
      - `id` (integer, primary key, auto-increment)
      - `meta_name` (text, not null) - The name of the metadata field
      - `meta_value` (text, nullable) - The value of the metadata field
      - `launched_game_id` (integer, not null) - Foreign key to launched_games table
      - `created_at` (timestamptz) - Timestamp when the record was created
  
  2. Security
    - Enable RLS on `launched_game_meta` table
    - Add policy for public read access (matching launched_games pattern)
    - Add policy for public insert access
    - Add policy for public update access
    - Add policy for public delete access
  
  3. Relationships
    - Foreign key constraint to `launched_games` table with cascade delete
*/

CREATE TABLE IF NOT EXISTS launched_game_meta (
  id serial PRIMARY KEY,
  meta_name text NOT NULL,
  meta_value text DEFAULT NULL,
  launched_game_id integer NOT NULL,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT fk_launched_game
    FOREIGN KEY (launched_game_id)
    REFERENCES launched_games(id)
    ON DELETE CASCADE
);

ALTER TABLE launched_game_meta ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access to launched_game_meta"
  ON launched_game_meta
  FOR SELECT
  USING (true);

CREATE POLICY "Allow public insert access to launched_game_meta"
  ON launched_game_meta
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow public update access to launched_game_meta"
  ON launched_game_meta
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow public delete access to launched_game_meta"
  ON launched_game_meta
  FOR DELETE
  USING (true);

CREATE INDEX IF NOT EXISTS idx_launched_game_meta_launched_game_id 
  ON launched_game_meta(launched_game_id);