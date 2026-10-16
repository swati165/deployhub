CREATE TABLE deployment_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'WAITING'
    CHECK (state IN ('WAITING', 'CLAIMED', 'RUNNING', 'RETRY_WAIT', 'COMPLETED', 'DEAD_LETTER')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts = 3),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  worker_id TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (attempts <= max_attempts),
  CHECK (
    (state IN ('CLAIMED', 'RUNNING')
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND worker_id IS NOT NULL)
    OR
    (state NOT IN ('CLAIMED', 'RUNNING')
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL
      AND worker_id IS NULL)
  ),
  CHECK (
    (state IN ('COMPLETED', 'DEAD_LETTER') AND completed_at IS NOT NULL)
    OR (state NOT IN ('COMPLETED', 'DEAD_LETTER') AND completed_at IS NULL)
  )
);

CREATE INDEX deployment_jobs_due_idx
  ON deployment_jobs (available_at, created_at, id)
  WHERE state IN ('WAITING', 'RETRY_WAIT');

CREATE INDEX deployment_jobs_expired_lease_idx
  ON deployment_jobs (lease_expires_at, id)
  WHERE state IN ('CLAIMED', 'RUNNING');
