# DeployHub

DeployHub is a React dashboard and Express API for connecting GitHub projects, tracking deployment jobs, and viewing their logs. Project, deployment, and log data is persisted in PostgreSQL. Deployments are **not simulated**: without the isolated build runner, image registry, and Kubernetes configuration, a requested deployment is recorded as failed with the exact missing prerequisites.

## Requirements

- Node.js 20.19+ (or 22+) and npm
- PostgreSQL 13+
- For real deployments only: a dedicated isolated worker with Git, Docker CLI, kubectl, an authenticated container registry, and a Kubernetes cluster with an Ingress controller and TLS secret

## Local development

1. Copy `.env.example` to `.env` and set `JWT_SECRET` to a random value of at least 32 bytes (for example, `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`). The Compose database credentials are for local development only.
2. Start PostgreSQL first, then run the one-shot migration command from this
   directory. API startup does not create or change schema:

   ```bash
   docker compose up -d db
   node server/migrate.js
   ```

   The command creates/adopts the baseline and applies all pending migrations
   (`0001`–`0007`). The state backfill stops safely if existing deployment data
   contains unknown values or inconsistent state/URL combinations; review such
   rows before proceeding. API and worker startup require migration `0007`:

   ```bash
   npm run backend:up
   ```

   The complete app is available at `http://localhost:5000`; check
   `http://localhost:5000/api/health` for readiness. Compose waits until
   PostgreSQL is healthy before starting the API. Stop the services with
   `npm run backend:down`.
3. For frontend development with hot reload, leave the API/database running, then in another terminal run:

   ```bash
   npm install
   npm run dev
   ```

   Open `http://localhost:5173`. Vite proxies `/api` requests to the local backend. To run the API directly without Docker, start PostgreSQL yourself, set `.env`, then run `npm run server`.

## Deploying the DeployHub app to Render

The repository includes a Render Blueprint at `../render.yaml`. Push the selected branch to GitHub, then sign in to Render, choose **New → Blueprint**, connect `swati165/deployhub`, and select `swati165-deployhub-mvp`. Render will provision a Node web service and PostgreSQL database, build the Vite app, serve the frontend and API from one HTTPS origin, and generate `JWT_SECRET`. The migration runner is separate from API startup: before starting the updated API against an existing or fresh Render database, run `node server/migrate.js` once against that service's `DATABASE_URL`. The current Blueprint does not define that pre-deploy step; configure/run the migration as an explicit release operation before deploying the new API.

The current Render Blueprint does not define a worker service. Until a separate worker is deployed and pointed at the same PostgreSQL database, API-created deployment jobs will remain queued; do not use deployment requests on that hosted instance expecting them to execute.

The Blueprint starts on Render's free plans and Singapore region, so no paid resource is intentionally selected. **Free Render PostgreSQL is temporary and expires after 30 days**, and the free web service can spin down when idle. Treat this as a demo deployment, not durable production hosting; upgrade to a paid PostgreSQL plan before storing data you need to keep. No Render account is connected to this workspace, so you must approve creation in your Render dashboard after pushing the branch.

## Deploying to an Ubuntu VM

The Compose stack includes Caddy as an HTTPS reverse proxy. Set `APP_DOMAIN` in the Compose `.env` file to a DNS hostname pointing to the VM, and allow inbound TCP ports 80 and 443 in the cloud firewall/security group. The API and PostgreSQL ports must remain private; the Compose configuration only binds them to loopback. Caddy automatically requests and renews the TLS certificate. Start the database, API, and proxy with `npm run app:up`.

For a temporary demo hostname only, a service such as `sslip.io` can map a name derived from the VM's public IP. Prefer a domain you control for a persistent deployment.

The dashboard, project list, project details, deployment list/detail, and log viewer use the API. A deployment request atomically persists its deployment, initial log, and durable job before returning `202`. Compose runs a separate trusted worker using the same backend image and PostgreSQL database. When a provider is explicitly selected, the worker can resolve a GitHub branch to an immutable commit SHA through GitHub's authenticated API and fence that pin in PostgreSQL before passing it to the provider. With the isolated executor explicitly enabled, the trusted supervisor fetches source and the isolated runtime checks out and verifies only that persisted SHA before building. Deployment statuses use the uppercase lifecycle contract (`QUEUED`, `VALIDATING`, `CLONING`, `BUILDING`, `PUSHING_IMAGE`, `DEPLOYING`, `RUNNING`, `FAILED`); the frontend still normalizes legacy values during the compatibility period.

## Durable jobs and execution boundary

Jobs use a separate PostgreSQL `deployment_jobs` table and internal states; those states are not exposed by the deployment API. The API inserts the Deployment, initial log, and one `WAITING` job in one transaction. A worker claims due work with PostgreSQL row locks, a lease, heartbeat, and fencing generation. Automatic retries are capped at three with bounded exponential backoff and jitter. A user retry creates a new Deployment/job; transient worker retries reuse the original pair. API restart does not fail active deployments; workers recover expired jobs. Configure `JOB_POLL_INTERVAL_MS`, `JOB_LEASE_MS`, `JOB_HEARTBEAT_INTERVAL_MS`, `JOB_RETRY_BASE_MS`, and `JOB_RETRY_MAX_MS` to tune worker timing.

Execution, image building, registry push, Kubernetes operation, AWS/kOps integration, and arbitrary user-code execution are not enabled by default. `EXECUTION_PROVIDER=disabled` and `ISOLATED_EXECUTOR_ENABLED=false` remain the defaults; registry push also requires `REGISTRY_PUSH_ENABLED=true` and a supported trusted provider. The local Docker runtime is fail-closed unless explicitly enabled with a digest-pinned `ISOLATED_EXECUTOR_IMAGE`; its dedicated runtime image build and offline npm-cache limitations are documented in [docs/ISOLATED_RUNTIME_IMAGE.md](docs/ISOLATED_RUNTIME_IMAGE.md). The currently supported application build is deliberately narrow: a Node/npm project with `package.json`, npm v3 `package-lock.json`, a `build` script, no declared or locked dependencies, and a regular-file-only `dist/` containing `index.html`. Dependency-bearing applications fail with `DEPENDENCY_CACHE_UNAVAILABLE`; arbitrary npm packages are not supported by the runtime's offline cache. Customer `start` scripts and Dockerfiles are not used. The trusted supervisor builds a local OCI image from validated static output using a generated Dockerfile, a digest-pinned Node base, and a fixed non-root static server; no customer Dockerfile or additional Docker build commands are run.

For an enabled execution, source objects are fetched by the trusted supervisor using Git without checkout or customer command execution, copied into a container tmpfs, checked out and SHA-verified there, then built with `--network=none`. The container receives no host mounts, Docker socket, or worker environment. CPU, memory, swap, PID, tmpfs workspace size, storage-layer size, time, and output limits are enforced and verified; startup fails if Docker cannot apply them. `EGRESS_PROXY` is rejected until a restrictive proxy network can be implemented. The supervisor still requires the trusted worker process to have access to the Docker CLI/daemon and Git; do not provide that access to the API or to the build container. Docker containers share a kernel and are not a substitute for a disposable VM against kernel exploits; do not enable this on a production or credential-bearing host. Configure `SOURCE_RESOLVER=github` and `GITHUB_SOURCE_TOKEN` only on the trusted worker to pin source. Registry configuration and credentials are likewise worker-only; see [docs/REGISTRY_PUBLISHING.md](docs/REGISTRY_PUBLISHING.md). Registry tags are deterministic convenience names, while the registry digest is the authoritative image identity. The trusted registry must enforce immutable tags; the application fails closed unless that requirement is explicitly attested in configuration. Migration `0006` adds nullable source-SHA metadata and durable `deployment_executions` correlation/recovery records; migration `0007` adds lease-fenced registry image metadata. A PostgreSQL queue is not a security boundary.

Private GitHub repositories, custom environment variables, automatic TLS provisioning, deployment deletion/rollback, and multi-replica scaling are not part of this MVP.

## Checks

```bash
npm run test:server
npm run lint
npm run build
```

## API overview

- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- `GET, POST /api/projects`, `GET /api/projects/:id`
- `POST /api/projects/:id/deployments`, `GET /api/projects/:id/deployments`
- `GET /api/deployments`, `GET /api/deployments/:id`
- `GET /api/logs`, `GET /api/dashboard`, `GET /api/health`
- `GET, PATCH /api/settings/profile`, `GET, PATCH /api/settings/notifications`
- `GET, POST /api/settings/api-keys`, `DELETE /api/settings/api-keys/:id`

All user-specific routes require a bearer token. API keys are returned only when created, stored as SHA-256 hashes, and can be revoked from Settings. Database queries are parameterized, passwords are hashed with bcrypt, and the API applies JSON body limits, security headers, CORS origin restrictions, and rate limits.
