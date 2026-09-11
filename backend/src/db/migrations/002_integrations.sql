CREATE TABLE IF NOT EXISTS integrations (
  id BIGSERIAL PRIMARY KEY,
  tool_name TEXT NOT NULL UNIQUE,
  base_url TEXT,
  account_identifier TEXT,
  encrypted_credentials TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'not_connected' CHECK (status IN ('connected', 'not_connected', 'error')),
  last_tested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integrations_tool_name ON integrations(tool_name);
