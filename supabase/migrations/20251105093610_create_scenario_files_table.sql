/*
  # Create scenario_files table for storing CSV file contents

  1. New Tables
    - `scenario_files`
      - `id` (uuid, primary key)
      - `scenario_id` (uuid, foreign key to scenarios)
      - `file_name` (text) - Name of the CSV file (e.g., game.csv, game_enigmas.csv)
      - `file_content` (text) - The CSV file content
      - `created_at` (timestamptz)
      
  2. Security
    - Enable RLS on `scenario_files` table
    - Add policy for public read access
    - Add policy for public insert access
*/

CREATE TABLE IF NOT EXISTS scenario_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid REFERENCES scenarios(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE scenario_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read scenario files"
  ON scenario_files
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Public can insert scenario files"
  ON scenario_files
  FOR INSERT
  TO public
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_scenario_files_scenario_id ON scenario_files(scenario_id);
CREATE INDEX IF NOT EXISTS idx_scenario_files_file_name ON scenario_files(file_name);
