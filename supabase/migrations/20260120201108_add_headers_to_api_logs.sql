/*
  # Add Headers to API Logs Table

  1. Changes
    - Add `request_headers` (jsonb) column to store request headers
    - Add `response_headers` (jsonb) column to store response headers
    - Add `request_body` (jsonb) column to store request body data
    
  2. Notes
    - These columns are nullable since not all API calls will have headers/body
    - Using jsonb for efficient storage and querying
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_logs' AND column_name = 'request_headers'
  ) THEN
    ALTER TABLE api_logs ADD COLUMN request_headers jsonb DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_logs' AND column_name = 'response_headers'
  ) THEN
    ALTER TABLE api_logs ADD COLUMN response_headers jsonb DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_logs' AND column_name = 'request_body'
  ) THEN
    ALTER TABLE api_logs ADD COLUMN request_body jsonb DEFAULT '{}'::jsonb;
  END IF;
END $$;
