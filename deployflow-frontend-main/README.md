# DeployHub

DeployHub is a React dashboard and Express API for connecting GitHub projects, tracking deployment jobs, and viewing their logs. Project, deployment, and log data is persisted in PostgreSQL. Deployments are **not simulated**: without the isolated build runner, image registry, and Kubernetes configuration, a requested deployment is recorded as failed with the exact missing prerequisites.

## Requirements

- Node.js 20.19+ (or 22+) and npm
- PostgreSQL 13+
- For real deployments only: a dedicated isolated worker with Git, Docker CLI, kubectl, an authenticated container registry, and a Kubernetes cluster with an Ingress controller and TLS secret

## Local development

1. Copy `.env.example` to `.env` and set `JWT_SECRET` to a random value of at least 32 bytes (for example, `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`). The Compose database credentials are for local development only.
2. Start the PostgreSQL database and API container:

   ```bash
   npm run backend:up
   ```

   The complete app is available at `http://localhost:5000`; check `http://localhost:5000/api/health` for readiness. Compose waits until PostgreSQL is healthy before starting the API. Stop the services with `npm run backend:down`.
3. For frontend development with hot reload, leave the API/database running, then in another terminal run:

   ```bash
   npm install
   npm run dev
   ```

   Open `http://localhost:5173`. Vite proxies `/api` requests to the local backend. To run the API directly without Docker, start PostgreSQL yourself, set `.env`, then run `npm run server`.

## Deploying the DeployHub app to Render

The repository includes a Render Blueprint at `../render.yaml`. Push the selected branch to GitHub, then sign in to Render, choose **New → Blueprint**, connect `swati165/deployhub`, and select `swati165-deployhub-mvp`. Render will provision a Node web service and PostgreSQL database, build the Vite app, serve the frontend and API from one HTTPS origin, run schema migrations, and generate `JWT_SECRET`.

The Blueprint starts on Render's free plans and Singapore region, so no paid resource is intentionally selected. **Free Render PostgreSQL is temporary and expires after 30 days**, and the free web service can spin down when idle. Treat this as a demo deployment, not durable production hosting; upgrade to a paid PostgreSQL plan before storing data you need to keep. No Render account is connected to this workspace, so you must approve creation in your Render dashboard after pushing the branch.

## Deploying to an Ubuntu VM

The Compose stack includes Caddy as an HTTPS reverse proxy. Set `APP_DOMAIN` in the Compose `.env` file to a DNS hostname pointing to the VM, and allow inbound TCP ports 80 and 443 in the cloud firewall/security group. The API and PostgreSQL ports must remain private; the Compose configuration only binds them to loopback. Caddy automatically requests and renews the TLS certificate. Start the database, API, and proxy with `npm run app:up`.

For a temporary demo hostname only, a service such as `sslip.io` can map a name derived from the VM's public IP. Prefer a domain you control for a persistent deployment.

The dashboard, project list, project details, deployment list/detail, and log viewer use the API. A deployment request is persisted before its worker starts. If deployment integrations are not configured, its status becomes `failed` and its logs explain what is missing.

## Enabling real deployments

The worker clones public GitHub repositories with Git arguments (no shell), shallow depth, and a timeout; detects common stacks; builds and pushes a container image; applies Kubernetes Deployment, Service, and TLS-enabled Ingress resources; and waits for Kubernetes rollout readiness before returning a live URL. Node.js repositories without a Dockerfile need a `start` script in `package.json` and listen on port `3000`; their dependencies and optional build script run inside the generated container build. Other stacks must include a Dockerfile.

Repository Dockerfiles, package lifecycle scripts, and build scripts are untrusted code. Do not run this worker on a developer machine, a production Docker host, or a worker that has access to production secrets. Use a dedicated disposable runner and isolated Docker daemon with strict CPU, memory, disk, and time limits, and only then set the following on that worker:

```dotenv
DEPLOYMENT_EXECUTOR=isolated-docker
BUILD_RUNNER_ISOLATED=true
DOCKER_REGISTRY=registry.example.com
KUBE_NAMESPACE=deployhub
DEPLOYMENT_DOMAIN=apps.example.com
KUBE_TLS_SECRET=deployhub-tls
DEPLOYMENT_HEALTH_PATH=/
KUBECONFIG=/secure/path/to/kubeconfig
```

The runner's Docker CLI must already be authenticated to the registry, and its Kubernetes identity must be scoped to the deployment namespace. Create the namespace and TLS secret first, configure DNS and a working Ingress controller for `DEPLOYMENT_DOMAIN`, and ensure the cluster can pull images from the registry. Kubernetes checks the configured `DEPLOYMENT_HEALTH_PATH` (default `/`) on port `3000` before a deployment is marked live. The worker intentionally does not accept credentials from project form inputs or log raw command output. `BUILD_RUNNER_ISOLATED=true` is an operator assertion, not an isolation mechanism.

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
