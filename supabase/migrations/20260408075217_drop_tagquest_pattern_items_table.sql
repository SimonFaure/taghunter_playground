/*
  # Drop tagquest_pattern_items table

  ## Purpose
  Pattern items are now read directly from the pattern JSON files stored in
  Supabase Storage (resources bucket, patterns/{game_type}/ folder), keyed by
  the pattern uniqid stored in launched_game_meta. The tagquest_pattern_items
  database table is no longer needed and is being removed.

  ## Changes
  - Drops the `tagquest_pattern_items` table and all associated indexes and policies
*/

DROP TABLE IF EXISTS tagquest_pattern_items;
