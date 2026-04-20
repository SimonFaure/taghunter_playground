/*
  # Add RLS Policies for Public Read Access

  1. Security
    - Add policies for game_types table to allow public read access
    - Add policies for scenarios table to allow public read access
    - All users can view game types and scenarios without authentication
  
  2. Notes
    - Since this is a game browser, all game data should be publicly readable
    - No write permissions needed as data is managed by admins
*/

-- Game types policies
CREATE POLICY "Anyone can view game types"
  ON game_types FOR SELECT
  TO public
  USING (true);

-- Scenarios policies
CREATE POLICY "Anyone can view scenarios"
  ON scenarios FOR SELECT
  TO public
  USING (true);