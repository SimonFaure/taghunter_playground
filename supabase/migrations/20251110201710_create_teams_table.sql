/*
  # Create teams table

  1. New Tables
    - `teams`
      - `id` (bigint, primary key, auto-increment)
      - `launched_game_id` (bigint, foreign key to launched_games)
      - `team_number` (integer, the team number in the game)
      - `team_name` (text, name of the team)
      - `pattern` (integer, pattern identifier)
      - `score` (integer, team score, default 0)
      - `key_id` (bigint, foreign key to si_puces)
      - `start_time` (bigint, timestamp when team started)
      - `end_time` (bigint, timestamp when team ended)
      - `created_at` (timestamptz, auto-generated)

  2. Security
    - Enable RLS on `teams` table
    - Add policy for public read access (authenticated and anon users)
    - Add policy for public insert access
    - Add policy for public update access
    - Add policy for public delete access

  3. Indexes
    - Index on `launched_game_id` for faster queries
    - Index on `key_id` for faster lookups
*/

CREATE TABLE IF NOT EXISTS teams (
  id bigserial PRIMARY KEY,
  launched_game_id bigint NOT NULL,
  team_number integer NOT NULL,
  team_name text NOT NULL,
  pattern integer NOT NULL,
  score integer NOT NULL DEFAULT 0,
  key_id bigint NOT NULL,
  start_time bigint NOT NULL,
  end_time bigint NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_teams_launched_game_id ON teams(launched_game_id);
CREATE INDEX IF NOT EXISTS idx_teams_key_id ON teams(key_id);

-- Enable RLS
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

-- Allow public read access
CREATE POLICY "Allow public read access to teams"
  ON teams FOR SELECT
  TO anon, authenticated
  USING (true);

-- Allow public insert access
CREATE POLICY "Allow public insert access to teams"
  ON teams FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Allow public update access
CREATE POLICY "Allow public update access to teams"
  ON teams FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- Allow public delete access
CREATE POLICY "Allow public delete access to teams"
  ON teams FOR DELETE
  TO anon, authenticated
  USING (true);
