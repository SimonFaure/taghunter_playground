/*
  # Add unique constraint on team_completed_quests (team_id, quest_number)

  ## Problem
  Concurrent punch processing for the same chip can cause the same quest to be
  inserted twice into team_completed_quests, inflating the score.

  ## Changes
  - Remove duplicate rows (keep earliest per team_id + quest_number)
  - Add a unique constraint on (team_id, quest_number) to prevent future duplicates

  ## Notes
  - The constraint uses ON CONFLICT DO NOTHING semantics in application code
  - Existing duplicate rows are cleaned up before the constraint is applied
*/

-- Remove duplicate completed quests, keeping the one with the lowest id per (team_id, quest_number)
DELETE FROM team_completed_quests
WHERE id NOT IN (
  SELECT MIN(id)
  FROM team_completed_quests
  GROUP BY team_id, quest_number
);

-- Add unique constraint
ALTER TABLE team_completed_quests
  DROP CONSTRAINT IF EXISTS team_completed_quests_team_quest_unique;

ALTER TABLE team_completed_quests
  ADD CONSTRAINT team_completed_quests_team_quest_unique
  UNIQUE (team_id, quest_number);
