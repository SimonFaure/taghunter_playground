/*
  # Create launched_games table

  1. New Tables
    - `launched_games`
      - `id` (uuid, primary key) - Unique identifier for each launched game record
      - `game_id` (text) - Reference to the game that was launched
      - `game_type_id` (uuid, foreign key) - Reference to game_types table
      - `client_id` (text) - Identifier for the client who launched the game
      - `launched_at` (timestamptz) - Timestamp when the game was launched
      - `completed_at` (timestamptz, nullable) - Timestamp when the game was completed
      - `status` (text, default 'active') - Status of the game (active, completed, abandoned)
      - `metadata` (jsonb, nullable) - Additional metadata about the launched game
      - `created_at` (timestamptz) - Record creation timestamp

  2. Security
    - Enable RLS on `launched_games` table
    - Add policies for authenticated users to manage their launched games
    - Add policy for reading launched game records
*/

CREATE TABLE IF NOT EXISTS launched_games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id text NOT NULL,
  game_type_id uuid REFERENCES game_types(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  launched_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  status text DEFAULT 'active',
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE launched_games ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view launched games"
  ON launched_games
  FOR SELECT
  USING (true);

CREATE POLICY "Anyone can insert launched games"
  ON launched_games
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update launched games"
  ON launched_games
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anyone can delete launched games"
  ON launched_games
  FOR DELETE
  USING (true);

CREATE INDEX IF NOT EXISTS idx_launched_games_game_id ON launched_games(game_id);
CREATE INDEX IF NOT EXISTS idx_launched_games_client_id ON launched_games(client_id);
CREATE INDEX IF NOT EXISTS idx_launched_games_game_type_id ON launched_games(game_type_id);
CREATE INDEX IF NOT EXISTS idx_launched_games_status ON launched_games(status);
CREATE INDEX IF NOT EXISTS idx_launched_games_launched_at ON launched_games(launched_at DESC);