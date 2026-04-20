/*
  # Re-add unique constraint on team_completed_quests (team_id, quest_number)

  ## Problem
  When the same simulation card is processed more than once (e.g. duplicate USB reads
  or test re-runs), the same quest can be inserted multiple times for the same team,
  inflating the score.

  ## Solution
  - Clean up any existing duplicate rows (keep earliest by id per team_id + quest_number)
  - Re-add the unique constraint on (team_id, quest_number)

  ## Notes
  - Score mode (where the same quest can be legitimately completed multiple times) is
    handled in application code: inserts in score mode use plain insert and can create
    multiple rows. The score display in the team list sums all rows, so score mode still
    works correctly.
  - Speed mode inserts now use upsert with ignoreDuplicates so concurrent/duplicate
    simulation runs are silently deduplicated at the DB level.
*/

-- Remove duplicate rows, keeping the one with the lowest id per (team_id, quest_number)
DELETE FROM team_completed_quests
WHERE id NOT IN (
  SELECT MIN(id)
  FROM team_completed_quests
  GROUP BY team_id, quest_number
);

-- Re-add the unique constraint
ALTER TABLE team_completed_quests
  DROP CONSTRAINT IF EXISTS team_completed_quests_team_quest_unique;

ALTER TABLE team_completed_quests
  ADD CONSTRAINT team_completed_quests_team_quest_unique
  UNIQUE (team_id, quest_number);
