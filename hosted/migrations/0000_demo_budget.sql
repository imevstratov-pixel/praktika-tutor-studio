CREATE TABLE demo_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_used INTEGER NOT NULL DEFAULT 0 CHECK (total_used BETWEEN 0 AND 20),
  lease_token TEXT,
  lease_expires_at INTEGER,
  CHECK ((lease_token IS NULL AND lease_expires_at IS NULL) OR
         (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
