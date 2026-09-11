CREATE TABLE IF NOT EXISTS appdynamics_connection_state (
  integration_tool_name TEXT PRIMARY KEY,
  controller_url TEXT,
  account_name TEXT,
  auth_mode TEXT,
  connection_status TEXT NOT NULL DEFAULT 'disconnected',
  connected_user_display_name TEXT,
  token_expires_at TIMESTAMPTZ,
  last_successful_sync TIMESTAMPTZ,
  last_failed_sync TIMESTAMPTZ,
  last_error TEXT,
  response_time_ms INTEGER,
  last_checked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
