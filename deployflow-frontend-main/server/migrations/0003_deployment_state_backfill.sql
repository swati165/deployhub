DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM deployments
    WHERE status IS NULL
       OR status NOT IN (
         'queued', 'cloning', 'building', 'pushing', 'deploying', 'live', 'failed',
         'QUEUED', 'VALIDATING', 'CLONING', 'BUILDING', 'PUSHING_IMAGE',
         'DEPLOYING', 'RUNNING', 'FAILED'
       )
  ) THEN
    RAISE EXCEPTION 'Deployment state migration found an unmapped or NULL status; no rows were changed.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM deployments
    WHERE stage IS NULL
       OR stage NOT IN (
         'queued', 'cloning', 'building', 'pushing', 'deploying', 'live',
         'QUEUED', 'VALIDATING_REPOSITORY', 'CLONING_REPOSITORY',
         'DETECTING_TECHNOLOGY', 'INSTALLING_DEPENDENCIES',
         'BUILDING_APPLICATION', 'CREATING_IMAGE', 'AUTHENTICATING_REGISTRY',
         'PUSHING_IMAGE', 'APPLYING_KUBERNETES_DEPLOYMENT', 'CREATING_SERVICE',
         'CREATING_INGRESS', 'VERIFYING_ROLLOUT', 'GENERATING_LIVE_URL', 'RUNNING'
       )
  ) THEN
    RAISE EXCEPTION 'Deployment state migration found an unmapped or NULL stage; no rows were changed.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM deployments
    WHERE (status = 'failed' AND live_url IS NOT NULL)
       OR (status = 'FAILED' AND live_url IS NOT NULL)
       OR (status IN ('live', 'RUNNING') AND NULLIF(BTRIM(live_url), '') IS NULL)
  ) THEN
    RAISE EXCEPTION 'Deployment state migration found a URL/status anomaly; manual review is required.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM deployments
    WHERE NOT (
      (status = 'queued' AND stage = 'queued')
      OR (status = 'cloning' AND stage = 'cloning')
      OR (status = 'building' AND stage = 'building')
      OR (status = 'pushing' AND stage = 'pushing')
      OR (status = 'deploying' AND stage = 'deploying')
      OR (status = 'live' AND stage = 'live')
      OR (status = 'failed' AND stage IN ('queued', 'cloning', 'building', 'pushing', 'deploying'))
      OR (status = 'QUEUED' AND stage = 'QUEUED')
      OR (status = 'VALIDATING' AND stage = 'VALIDATING_REPOSITORY')
      OR (status = 'CLONING' AND stage = 'CLONING_REPOSITORY')
      OR (status = 'BUILDING' AND stage IN (
        'DETECTING_TECHNOLOGY', 'INSTALLING_DEPENDENCIES',
        'BUILDING_APPLICATION', 'CREATING_IMAGE'
      ))
      OR (status = 'PUSHING_IMAGE' AND stage IN ('AUTHENTICATING_REGISTRY', 'PUSHING_IMAGE'))
      OR (status = 'DEPLOYING' AND stage IN (
        'APPLYING_KUBERNETES_DEPLOYMENT', 'CREATING_SERVICE', 'CREATING_INGRESS',
        'VERIFYING_ROLLOUT', 'GENERATING_LIVE_URL'
      ))
      OR (status = 'RUNNING' AND stage = 'RUNNING')
      OR (status = 'FAILED' AND stage IN (
        'QUEUED', 'VALIDATING_REPOSITORY', 'CLONING_REPOSITORY',
        'DETECTING_TECHNOLOGY', 'INSTALLING_DEPENDENCIES',
        'BUILDING_APPLICATION', 'CREATING_IMAGE', 'AUTHENTICATING_REGISTRY',
        'PUSHING_IMAGE', 'APPLYING_KUBERNETES_DEPLOYMENT', 'CREATING_SERVICE',
        'CREATING_INGRESS', 'VERIFYING_ROLLOUT', 'GENERATING_LIVE_URL'
      ))
    )
  ) THEN
    RAISE EXCEPTION 'Deployment state migration found an inconsistent status/stage pair; manual review is required.';
  END IF;
END
$migration$;

UPDATE deployments
SET status = CASE status
  WHEN 'queued' THEN 'QUEUED'
  WHEN 'cloning' THEN 'CLONING'
  WHEN 'building' THEN 'BUILDING'
  WHEN 'pushing' THEN 'PUSHING_IMAGE'
  WHEN 'deploying' THEN 'DEPLOYING'
  WHEN 'live' THEN 'RUNNING'
  WHEN 'failed' THEN 'FAILED'
  ELSE status
END,
stage = CASE stage
  WHEN 'queued' THEN 'QUEUED'
  WHEN 'cloning' THEN 'CLONING_REPOSITORY'
  WHEN 'building' THEN 'CREATING_IMAGE'
  WHEN 'pushing' THEN 'PUSHING_IMAGE'
  WHEN 'deploying' THEN 'APPLYING_KUBERNETES_DEPLOYMENT'
  WHEN 'live' THEN 'RUNNING'
  ELSE stage
END
WHERE status IN ('queued', 'cloning', 'building', 'pushing', 'deploying', 'live', 'failed')
   OR stage IN ('queued', 'cloning', 'building', 'pushing', 'deploying', 'live');
