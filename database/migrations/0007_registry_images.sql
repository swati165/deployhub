CREATE TABLE deployment_registry_images (
  execution_id TEXT PRIMARY KEY
    REFERENCES deployment_executions (id) ON DELETE CASCADE,
  job_id UUID NOT NULL,
  deployment_id UUID NOT NULL,
  lease_generation BIGINT NOT NULL CHECK (lease_generation > 0),
  provider_name TEXT NOT NULL CHECK (provider_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  registry TEXT NOT NULL CHECK (octet_length(registry) <= 253),
  repository TEXT NOT NULL CHECK (octet_length(repository) <= 255),
  pushed_tag TEXT NOT NULL CHECK (pushed_tag ~ '^dh-[a-f0-9]{64}$'),
  local_image_reference TEXT NOT NULL CHECK (local_image_reference ~ '^deployhub-app:[a-f0-9]{24}$'),
  local_image_digest TEXT NOT NULL CHECK (local_image_digest ~ '^sha256:[a-fA-F0-9]{64}$'),
  source_commit_sha TEXT NOT NULL CHECK (source_commit_sha ~ '^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$'),
  registry_digest TEXT NOT NULL CHECK (registry_digest ~ '^sha256:[a-fA-F0-9]{64}$'),
  immutable_image TEXT NOT NULL CHECK (octet_length(immutable_image) <= 768),
  pushed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT deployment_registry_images_job_deployment_fk
    FOREIGN KEY (job_id, deployment_id)
    REFERENCES deployment_jobs (id, deployment_id) ON DELETE CASCADE,
  CONSTRAINT deployment_registry_images_tag_unique UNIQUE (registry, repository, pushed_tag)
);

CREATE INDEX deployment_registry_images_deployment_idx
  ON deployment_registry_images (deployment_id, pushed_at DESC);
