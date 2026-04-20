/*
  # Drop unique constraint on team_completed_quests permanently

  ## Summary
  Removes the unique constraint on (team_id, quest_number) from team_completed_quests.
  Duplicate protection is handled at the application level via a 5-second debounce
  on the USB card reader, which is sufficient for normal operation.
  Score mode requires allowing the same quest to be punched multiple times by the
  same team, which this constraint would block.
*/

ALTER TABLE team_completed_quests
  DROP CONSTRAINT IF EXISTS team_completed_quests_team_quest_unique;
