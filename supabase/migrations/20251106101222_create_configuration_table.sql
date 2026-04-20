/*
  # Create Configuration Table

  1. New Tables
    - `configuration`
      - `id` (uuid, primary key)
      - `key` (text, unique) - Configuration key (e.g., 'usb_port')
      - `value` (text) - Configuration value
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
  
  2. Security
    - Enable RLS on `configuration` table
    - Add policy for public read access (configuration is shared for all users)
    - Add policy for public write access (anyone can update configuration)
*/

CREATE TABLE IF NOT EXISTS configuration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  value text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE configuration ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read configuration"
  ON configuration
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Anyone can insert configuration"
  ON configuration
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Anyone can update configuration"
  ON configuration
  FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anyone can delete configuration"
  ON configuration
  FOR DELETE
  TO anon, authenticated
  USING (true);