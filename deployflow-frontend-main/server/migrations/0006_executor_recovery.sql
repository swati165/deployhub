ALTER TABLE deployment_jobs
  ADD COLUMN source_commit_sha TEXT,
  ADD COLUMN source_resolved_at TIMESTAMPTZ,
  ADD CONSTRAINT deployment_jobs_source_commit_sha_check
    CHECK (source_commit_sha IS NULL OR source_commit_sha ~ '^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$'),
  ADD CONSTRAINT deployment_jobs_source_resolution_pair_check
    CHECK ((source_commit_sha IS NULL) = (source_resolved_at IS NULL)),
  ADD CONSTRAINT deployment_jobs_id_deployment_unique
    UNIQUE (id, deployment_id);

CREATE TABLE deployment_executions (
  id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  job_id UUID NOT NULL,
  deployment_id UUID NOT NULL,
  lease_generation BIGINT NOT NULL CHECK (lease_generation > 0),
  provider_name TEXT NOT NULL CHECK (provider_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  provider_execution_id TEXT CHECK (
    provider_execution_id IS NULL OR provider_execution_id ~ '^[A-Za-z0-9._:-]{1,200}$'
  ),
  status TEXT NOT NULL DEFAULT 'PROVISIONED'
    CHECK (status IN (
      'PROVISIONED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'RETRYABLE_FAILURE',
      'TIMED_OUT', 'CANCELLED', 'ABANDONED'
    )),
  cleanup_state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (cleanup_state IN ('NOT_REQUIRED', 'PENDING', 'FAILED', 'CLEANED')),
  result JSONB CHECK (result IS NULL OR pg_column_size(result) <= 131072),
  last_error TEXT CHECK (last_error IS NULL OR octet_length(last_error) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT deployment_executions_job_generation_unique UNIQUE (job_id, lease_generation),
  CONSTRAINT deployment_executions_job_deployment_fk
    FOREIGN KEY (job_id, deployment_id)
    REFERENCES deployment_jobs (id, deployment_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX deployment_executions_provider_id_unique_idx
  ON deployment_executions (provider_name, provider_execution_id)
  WHERE provider_execution_id IS NOT NULL;

CREATE INDEX deployment_executions_recovery_idx
  ON deployment_executions (updated_at, id)
  WHERE cleanup_state IN ('PENDING', 'FAILED')
     OR status IN ('PROVISIONED', 'RUNNING');
