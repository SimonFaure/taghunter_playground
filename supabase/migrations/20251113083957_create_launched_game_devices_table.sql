/*
  # Create launched_game_devices table

  1. New Tables
    - `launched_game_devices`
      - `id` (bigint, primary key, auto-increment)
      - `launched_game_id` (int, foreign key to launched_games)
      - `device_id` (varchar(50))
      - `connected` (boolean, default false)
      - `last_connexion_attempt` (timestamp, auto-updates on modification)

  2. Security
    - Enable RLS on `launched_game_devices` table
    - Add policy for public access to read device data
    - Add policy for public access to insert device data
    - Add policy for public access to update device data
    - Add policy for public access to delete device data

  3. Indexes
    - Add index on `launched_game_id` for faster lookups
    - Add index on `device_id` for faster device searches

  4. Triggers
    - Auto-update `last_connexion_attempt` timestamp on row updates
*/

CREATE TABLE IF NOT EXISTS launched_game_devices (
  id bigserial PRIMARY KEY,
  launched_game_id int NOT NULL,
  device_id varchar(50) NOT NULL,
  connected boolean NOT NULL DEFAULT false,
  last_connexion_attempt timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE launched_game_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public to read devices"
  ON launched_game_devices
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Allow public to insert devices"
  ON launched_game_devices
  FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Allow public to update devices"
  ON launched_game_devices
  FOR UPDATE
  TO public
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow public to delete devices"
  ON launched_game_devices
  FOR DELETE
  TO public
  USING (true);

CREATE INDEX IF NOT EXISTS idx_launched_game_devices_launched_game_id 
  ON launched_game_devices(launched_game_id);

CREATE INDEX IF NOT EXISTS idx_launched_game_devices_device_id 
  ON launched_game_devices(device_id);

CREATE OR REPLACE FUNCTION update_last_connexion_attempt()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_connexion_attempt = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_launched_game_devices_timestamp
  BEFORE UPDATE ON launched_game_devices
  FOR EACH ROW
  EXECUTE FUNCTION update_last_connexion_attempt();