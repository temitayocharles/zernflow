-- Runtime credentials are owned by Vault/External Secrets and must never live
-- in operator-readable Supabase rows.
UPDATE workspaces
SET late_api_key_encrypted = NULL,
    ai_api_key = NULL,
    webhook_secret = NULL;

UPDATE channels SET webhook_secret = NULL;

ALTER TABLE workspaces
  DROP COLUMN IF EXISTS late_api_key_encrypted,
  DROP COLUMN IF EXISTS ai_api_key,
  DROP COLUMN IF EXISTS webhook_secret;

ALTER TABLE channels
  DROP COLUMN IF EXISTS webhook_secret;
