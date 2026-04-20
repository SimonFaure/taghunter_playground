/*
  # Drop unique constraint on team_completed_quests (team_id, quest_number)

  ## Reason
  In "score" victory mode, the same quest can be completed multiple times by the
  same team (each re-scan scores the quest again). The unique constraint incorrectly
  blocks this. Race-condition deduplication is now handled in application logic
  based on the victoryType meta value instead.
*/

ALTER TABLE team_completed_quests
  DROP CONSTRAINT IF EXISTS team_completed_quests_team_quest_unique;
