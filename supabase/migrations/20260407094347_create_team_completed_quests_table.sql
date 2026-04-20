/*
  # Create team_completed_quests table

  ## Purpose
  Tracks which quests have already been scored for each team in a TagQuest game.
  This allows the punch processing pipeline to efficiently detect previously-scored
  quests with a single indexed lookup instead of re-parsing all historical raw data.

  ## New Tables
  - `team_completed_quests`
    - `id` (bigserial, primary key)
    - `launched_game_id` (bigint) — the active game session
    - `team_id` (bigint) — FK to teams.id
    - `teammate_chip_id` (bigint) — the chip ID of the teammate whose card triggered the completion
    - `quest_id` (text) — the quest's ID from game_data_json
    - `quest_number` (text) — human-readable quest number
    - `points_awarded` (integer) — points added to the team score for this quest
    - `completed_at` (timestamptz) — when the completion was recorded

  ## Indexes
  - `(team_id, quest_id)` — fast "has this team already done this quest?" lookup
  - `(launched_game_id)` — fast game-level queries

  ## Security
  - RLS enabled
  - Public read/insert/update/delete (consistent with other tables in this project)
*/

CREATE TABLE IF NOT EXISTS team_completed_quests (
  id bigserial PRIMARY KEY,
  launched_game_id bigint NOT NULL,
  team_id bigint NOT NULL,
  teammate_chip_id bigint NOT NULL,
  quest_id text NOT NULL,
  quest_number text NOT NULL DEFAULT '',
  points_awarded integer NOT NULL DEFAULT 0,
  completed_at timestamptz DEFAULT now()
);

ALTER TABLE team_completed_quests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access to team_completed_quests"
  ON team_completed_quests FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Allow public insert access to team_completed_quests"
  ON team_completed_quests FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Allow public update access to team_completed_quests"
  ON team_completed_quests FOR UPDATE
  TO public
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow public delete access to team_completed_quests"
  ON team_completed_quests FOR DELETE
  TO public
  USING (true);

CREATE INDEX IF NOT EXISTS idx_tcq_team_quest
  ON team_completed_quests(team_id, quest_id);

CREATE INDEX IF NOT EXISTS idx_tcq_launched_game_id
  ON team_completed_quests(launched_game_id);
