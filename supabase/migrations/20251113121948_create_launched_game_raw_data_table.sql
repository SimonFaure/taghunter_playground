/*
  # Create launched_game_raw_data table

  1. New Tables
    - `launched_game_raw_data`
      - `id` (bigint, primary key, auto-increment)
      - `launched_game_id` (integer, references launched_games)
      - `device_id` (text, the computer/device name)
      - `raw_data` (jsonb, stores the card punch data)
      - `created_at` (timestamptz, default now())
      - `updated_at` (timestamptz, default now())

  2. Security
    - Enable RLS on `launched_game_raw_data` table
    - Add policy for public read access (consistent with other tables)
    - Add policy for public insert access
    - Add policy for public update access

  3. Indexes
    - Add index on launched_game_id for faster queries
    - Add index on device_id for filtering by device
*/

CREATE TABLE IF NOT EXISTS launched_game_raw_data (
  id bigserial PRIMARY KEY,
  launched_game_id integer NOT NULL,
  device_id text NOT NULL,
  raw_data jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_launched_game_raw_data_launched_game_id 
  ON launched_game_raw_data(launched_game_id);

CREATE INDEX IF NOT EXISTS idx_launched_game_raw_data_device_id 
  ON launched_game_raw_data(device_id);

-- Enable RLS
ALTER TABLE launched_game_raw_data ENABLE ROW LEVEL SECURITY;

-- Create policies for public access (consistent with other tables in the system)
CREATE POLICY "Allow public read access to launched_game_raw_data"
  ON launched_game_raw_data
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Allow public insert access to launched_game_raw_data"
  ON launched_game_raw_data
  FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Allow public update access to launched_game_raw_data"
  ON launched_game_raw_data
  FOR UPDATE
  TO public
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow public delete access to launched_game_raw_data"
  ON launched_game_raw_data
  FOR DELETE
  TO public
  USING (true);