ALTER TABLE deployments
  DROP CONSTRAINT deployments_status_check;

ALTER TABLE deployments
  ADD CONSTRAINT deployments_status_check
  CHECK (status IN (
    'queued', 'cloning', 'building', 'pushing', 'deploying', 'live', 'failed',
    'QUEUED', 'VALIDATING', 'CLONING', 'BUILDING', 'PUSHING_IMAGE',
    'DEPLOYING', 'RUNNING', 'FAILED'
  ));
