/*
  # Create layouts table

  1. New Tables
    - `layouts`
      - `id` (bigint, primary key, auto-increment)
      - `game_type` (text) - Type of game (e.g., 'tagquest', 'mystery')
      - `version` (text) - Layout version (e.g., '6.6')
      - `name` (text) - Display name for the layout
      - `config` (jsonb) - Layout configuration data
      - `is_active` (boolean) - Whether this is the active layout for the game type
      - `created_at` (timestamptz) - Creation timestamp
      - `updated_at` (timestamptz) - Last update timestamp
  
  2. Security
    - Enable RLS on `layouts` table
    - Add policies for public read access
    - Add policies for authenticated insert/update
*/

CREATE TABLE IF NOT EXISTS layouts (
  id bigserial PRIMARY KEY,
  game_type text NOT NULL,
  version text NOT NULL,
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(game_type, version)
);

ALTER TABLE layouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view layouts"
  ON layouts FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Authenticated users can insert layouts"
  ON layouts FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update layouts"
  ON layouts FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete layouts"
  ON layouts FOR DELETE
  TO authenticated
  USING (true);

CREATE INDEX IF NOT EXISTS idx_layouts_game_type ON layouts(game_type);
CREATE INDEX IF NOT EXISTS idx_layouts_is_active ON layouts(game_type, is_active) WHERE is_active = true;