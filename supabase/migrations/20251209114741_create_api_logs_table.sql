/*
  # Create API Logs Table

  1. New Tables
    - `api_logs`
      - `id` (bigint, primary key) - Unique identifier for each log entry
      - `endpoint` (text) - API endpoint called (e.g., /check_email.php)
      - `method` (text) - HTTP method used (GET, POST, etc.)
      - `request_params` (jsonb) - Parameters sent with the request
      - `response_data` (jsonb) - Response data received from API
      - `status_code` (integer) - HTTP status code
      - `error_message` (text, nullable) - Error message if request failed
      - `created_at` (timestamptz) - When the API call was made

  2. Security
    - Enable RLS on `api_logs` table
    - Add policy for public read access (logs are for monitoring purposes)
*/

CREATE TABLE IF NOT EXISTS api_logs (
  id bigserial PRIMARY KEY,
  endpoint text NOT NULL,
  method text NOT NULL DEFAULT 'GET',
  request_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_data jsonb,
  status_code integer NOT NULL,
  error_message text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE api_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read API logs"
  ON api_logs
  FOR SELECT
  USING (true);

CREATE POLICY "Anyone can insert API logs"
  ON api_logs
  FOR INSERT
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON api_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_endpoint ON api_logs(endpoint);
