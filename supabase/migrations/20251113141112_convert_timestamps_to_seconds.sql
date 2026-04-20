/*
  # Convert timestamp columns from milliseconds to seconds

  1. Changes
    - Update `teams` table `start_time` and `end_time` columns to store Unix timestamps in seconds
    - Convert existing millisecond timestamps to seconds by dividing by 1000
  
  2. Notes
    - This migration converts all existing millisecond timestamps to seconds
    - Future timestamps will be stored in seconds (Unix timestamp format)
    - This ensures consistency with MySQL database which uses int/bigint for seconds
*/

-- Convert existing millisecond timestamps to seconds in teams table
UPDATE teams 
SET start_time = FLOOR(start_time / 1000)
WHERE start_time IS NOT NULL AND start_time > 10000000000;

UPDATE teams 
SET end_time = FLOOR(end_time / 1000)
WHERE end_time IS NOT NULL AND end_time > 10000000000;