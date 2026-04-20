/*
  # Alter teams.pattern column from integer to text

  ## Problem
  The `pattern` column was defined as `integer NOT NULL`, but the application stores
  pattern uniqids (strings like "ado_adultes") in this column. This type mismatch
  caused all team INSERT operations to fail silently, resulting in "no teams" being
  saved when launching a game.

  ## Changes
  - `teams.pattern`: changed from `integer NOT NULL` to `text NOT NULL DEFAULT ''`
*/

ALTER TABLE teams ALTER COLUMN pattern TYPE text USING pattern::text;
ALTER TABLE teams ALTER COLUMN pattern SET DEFAULT '';
