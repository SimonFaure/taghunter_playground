/*
  # Make quest_id nullable in team_completed_quests

  ## Changes
  - `quest_id` column changed from NOT NULL to nullable
    - The punch logic sets quest_id to null (quest identification is done via quest_number)
    - This prevents insert failures when quest_id is not available
*/

ALTER TABLE team_completed_quests ALTER COLUMN quest_id DROP NOT NULL;
