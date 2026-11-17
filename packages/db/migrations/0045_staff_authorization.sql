CREATE TABLE staff_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  learner_id TEXT NOT NULL REFERENCES harbor_learners(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('tenant-administrator', 'assessment-manager', 'invigilator', 'scorer')),
  assignment_id TEXT REFERENCES assignments(id) ON DELETE CASCADE,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((role IN ('tenant-administrator', 'assessment-manager') AND assignment_id IS NULL)
    OR (role IN ('invigilator', 'scorer') AND assignment_id IS NOT NULL))
);
CREATE INDEX staff_grants_identity_idx ON staff_grants(tenant_id, learner_id);

CREATE TABLE staff_access_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  actor_id TEXT,
  actor_role TEXT,
  operation TEXT NOT NULL,
  resource_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'completed', 'failed')),
  response_status INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX staff_access_events_tenant_idx ON staff_access_events(tenant_id, created_at);
