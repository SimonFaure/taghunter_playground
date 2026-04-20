/*
  # Create team_punch_responses table

  ## Summary
  Stores the full JSON response from each card punch processing event during a TagQuest game.
  This replaces the in-memory punch console UI with persistent, queryable per-team records.

  ## New Tables

  ### team_punch_responses
  - `id` — auto-incrementing primary key
  - `launched_game_id` — FK to launched_games, identifies which game session
  - `team_id` — FK to teams (nullable — punch may not resolve to a team if chip is unrecognized)
  - `team_name` — denormalized name for quick display
  - `chip_id` — the card/chip ID that was read
  - `status` — punch result status (ok, chip_not_recognized, team_already_finished, cheat_detected, error)
  - `result_json` — full PunchResult JSON for complete auditability
  - `punched_at` — timestamp of the punch event

  ## Security
  - RLS enabled
  - Public read/write allowed (same pattern as other game tables in this project)

  ## Indexes
  - `(launched_game_id)` for listing all punches in a game
  - `(team_id)` for filtering by team
  - `(punched_at)` for chronological ordering
*/

CREATE TABLE IF NOT EXISTS team_punch_responses (
  id bigserial PRIMARY KEY,
  launched_game_id bigint NOT NULL REFERENCES launched_games(id) ON DELETE CASCADE,
  team_id bigint REFERENCES teams(id) ON DELETE SET NULL,
  team_name text NOT NULL DEFAULT '',
  chip_id bigint,
  status text NOT NULL DEFAULT '',
  result_json jsonb NOT NULL DEFAULT '{}',
  punched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_punch_responses_launched_game_id_idx ON team_punch_responses(launched_game_id);
CREATE INDEX IF NOT EXISTS team_punch_responses_team_id_idx ON team_punch_responses(team_id);
CREATE INDEX IF NOT EXISTS team_punch_responses_punched_at_idx ON team_punch_responses(punched_at);

ALTER TABLE team_punch_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read punch responses"
  ON team_punch_responses FOR SELECT
  USING (true);

CREATE POLICY "Public can insert punch responses"
  ON team_punch_responses FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Public can update punch responses"
  ON team_punch_responses FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Public can delete punch responses"
  ON team_punch_responses FOR DELETE
  USING (true);
