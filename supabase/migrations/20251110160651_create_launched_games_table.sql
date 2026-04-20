/*
  # Create launched_games table

  1. New Tables
    - `launched_games`
      - `id` (bigint, primary key, auto-increment) - Unique identifier for each launched game
      - `game_uniqid` (text) - Unique identifier for the game
      - `name` (text) - Name of the launched game
      - `number_of_teams` (integer) - Number of teams playing
      - `game_type` (text) - Type of game being played
      - `start_time` (timestamptz) - When the game started
      - `ended` (boolean, default false) - Whether the game has ended
      - `started` (boolean, default false) - Whether the game has started
      - `duration` (integer) - Duration of the game in minutes
      - `created_at` (timestamptz) - Record creation timestamp

  2. Security
    - Enable RLS on `launched_games` table
    - Add policies for public read and write access (matching original phpMyAdmin structure)

  3. Indexes
    - Primary key on `id`
    - Index on `game_uniqid` for faster lookups
    - Index on `start_time` for time-based queries
*/

CREATE TABLE IF NOT EXISTS launched_games (
  id bigserial PRIMARY KEY,
  game_uniqid text NOT NULL,
  name text NOT NULL,
  number_of_teams integer NOT NULL,
  game_type text NOT NULL,
  start_time timestamptz NOT NULL,
  ended boolean NOT NULL DEFAULT false,
  started boolean NOT NULL DEFAULT false,
  duration integer NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_launched_games_game_uniqid ON launched_games(game_uniqid);
CREATE INDEX IF NOT EXISTS idx_launched_games_start_time ON launched_games(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_launched_games_game_type ON launched_games(game_type);