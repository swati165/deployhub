# DeployHub project handoff

**Status date:** 2026-10-05  
**Repository:** `swati165/deployhub` (`https://github.com/swati165/deployhub.git`)  
**Current worktree branch:** `swati165-deployhub-mvp`  
**Application directory:** `deployflow-frontend-main/`

This document records the observed repository/worktree state and recent local
validation. There is substantial uncommitted work in this checkout; a fresh
clone will not automatically contain those changes.

## 1. Purpose and architecture

DeployHub is a React/Vite dashboard and Node.js/Express API for connecting
GitHub projects, requesting deployments, and viewing deployment state and
logs. PostgreSQL stores users, projects, deployments, logs, durable deployment
jobs, and execution correlation. The API accepts and validates user requests;
a separate worker claims jobs, manages leases/retries, and owns deployment
state transitions.

The intended build path pins a requested GitHub branch/ref to an immutable
commit SHA, executes a narrowly supported build in a disposable isolated
container, creates a local application image, and (Phase 4D, in progress)
publishes that image to a configured registry. Kubernetes/kOps and AWS
deployment are not implemented. A local or registry image is not a live
deployment; until Kubernetes is implemented, the orchestrator must not report
success or a live URL.

## 2. Repository and branch

- Git remote: `https://github.com/swati165/deployhub.git`
- Current local branch: `swati165-deployhub-mvp`
- Git worktree root: the repository root; frontend/backend application files
  are under `deployflow-frontend-main/`.
- Current worktree includes many modified and untracked files (listed below).
  Do not replace them with a clean checkout or assume they are already on the
  remote branch.

## 3. Phase 4A — durable jobs and trusted orchestration

**Status: implemented in this worktree.** The API transaction creates a
Deployment, initial log, and durable `deployment_jobs` row. The separate worker
claims jobs with PostgreSQL row locks, leases, heartbeats, and lease-generation
fencing. Automatic retries use bounded exponential backoff and a capped
attempt count; worker restart/recovery and dead-letter handling are present.
Deployment state transitions and logs are persisted by the trusted
orchestrator, not by the executor.

The public deployment API remains separate from internal job/execution state.
The frontend normalizes legacy deployment states during compatibility.

## 4. Phase 4B — immutable source and isolated execution

**Status: implemented and previously validated locally; execution remains
disabled by default.**

- A trusted GitHub source resolver validates repository/ref input, resolves a
  commit SHA, and persists/verifies that immutable SHA under the active worker
  lease. The requested branch remains separate from the pinned SHA.
- `IsolatedVmExecutionProvider` and `IsolatedVmSupervisor` coordinate
  provisioning, start, monitoring, cancellation, cleanup, and abandoned
  execution reconciliation through the existing provider contracts.
- The Docker runtime runs a disposable build container, checks out and verifies
  only the persisted SHA, and enforces the available resource/time/output
  restrictions. It uses `--network=none`, a read-only root, non-root UID
  `1000:1000`, dropped capabilities, no-new-privileges, tmpfs workspaces, and
  no host binds or Docker socket in the customer container.
- The dedicated runtime image is separate from `Dockerfile.api`. Its documented
  pinned Node base is
  `docker.io/library/node@sha256:2c752226d477b4a886378baa95b9af252be59301b725fdb0b7e15208131505a8`.
  The prior local integration validation used
  `deployhub/isolated-node@sha256:a1daef19191bc95080c5a930235e5c46ff53450a050d907523fc40ab249c4ef5`.
  That runtime digest is machine/local-environment specific; it is not a
  registry image guaranteed to be available on another machine.
- The Phase 4B real Docker integration test previously passed using the
  locally available pinned runtime image and synthetic test data only. It did
  not execute a customer repository.

Docker containers share the host kernel and are not equivalent to disposable
VMs. The trusted worker would need Docker CLI/daemon access to create
containers; customer workloads must never receive that access.

## 5. Phase 4C — local application image

**Status: implemented; local Docker integration was previously validated.**
Support is intentionally limited to **dependency-free static Node/npm
applications** satisfying all of these conditions:

- `package.json` contains a nonempty `build` script.
- `package-lock.json` uses npm lockfile version 3.
- The package manager is npm (when declared).
- No declared or locked external dependencies exist. The runtime's npm cache is
  empty; dependency-bearing projects fail with
  `DEPENDENCY_CACHE_UNAVAILABLE`.
- Build output is a regular-file-only `dist/` directory containing
  `index.html`, bounded to 10,000 files and 64 MiB.

Customer Dockerfiles and customer `start` scripts are not used. The trusted
builder generates a Dockerfile using the pinned Node base, copies only
validated static output and the trusted static server, and sets a fixed
non-root command. The created OCI image is local to the Docker daemon and is
not by itself a deployment.

## 6. Local Docker/Compose setup

The Compose file is `deployflow-frontend-main/compose.yaml`:

- `db`: PostgreSQL `16-alpine`, named volume `deployhub-postgres`, port bound
  to `127.0.0.1:5432`.
- `api`: built from `Dockerfile.api`, port bound to `127.0.0.1:5000`.
- `worker`: separate Node process using the API image and the same database.
- `caddy`: optional HTTPS reverse proxy for the app/VM setup.

Useful commands from `deployflow-frontend-main/`:

```bash
docker compose up -d db
node server/migrate.js
npm run backend:up
npm run backend:down
npm run app:up
```

`backend:up` starts `db`, `api`, and `worker`; `app:up` also starts Caddy.
Migration execution is explicit; API startup does not apply migrations. The
worker image/Compose definition currently has no Docker socket mount, and
`Dockerfile.api` does not install the Docker CLI. Thus the Compose worker is not
ready to run the isolated Docker executor merely by changing its enable flag.
Do not add daemon access to customer containers to bridge that gap.

## 7. Local URLs

- Vite frontend: `http://localhost:5173`
- API: `http://localhost:5000`
- Health: `http://localhost:5000/api/health`
- Registration route: `POST /api/auth/register` (there is no `/api/register`
  route in the current API).

The API CORS implementation is in `server/app.js`; `server/index.js` reads
`FRONTEND_ORIGIN`. Compose now configures the API with the exact local origin
`http://localhost:5173` (no wildcard). The API container was recreated and
verified healthy after that change. Preflight and POST probes from this origin
returned `Access-Control-Allow-Origin: http://localhost:5173`.

## 8. Database and worker setup

PostgreSQL is required. Apply migrations from `deployflow-frontend-main/` with
`node server/migrate.js` before starting API/worker. The migration runner
checksums and serializes migrations. The current migration files are
`0001_baseline.sql` through `0007_registry_images.sql`; `0001`–`0005` are
immutable. API and worker source currently require schema version `0006` at
startup. Phase 4D adds migration `0007`, but the database-dependent migration
tests were skipped in the latest test run, so applying and validating `0007`
against a real disposable PostgreSQL database remains necessary.

The worker uses PostgreSQL leases/heartbeats to coordinate work and retries.
Compose provides job polling/lease/retry variables. A separate worker must be
running for queued jobs to progress; API health alone does not indicate worker
health.

## 9. Important environment variables and defaults

Values below are configuration names/defaults from `.env.example` and Compose;
secrets are intentionally not reproduced here.

| Variable | Current safe default / purpose |
|---|---|
| `FRONTEND_ORIGIN` | `http://localhost:5173` for the local API CORS allowlist |
| `EXECUTION_PROVIDER` | `disabled` |
| `ISOLATED_EXECUTOR_ENABLED` | `false` |
| `ISOLATED_EXECUTOR_IMAGE` | blank in `.env.example`; real runtime requires a digest-pinned reference |
| `SOURCE_RESOLVER` | `disabled` |
| `GITHUB_SOURCE_TOKEN` | blank; configure only in trusted worker environment if needed |
| `REGISTRY_PUSH_ENABLED` | `false` |
| `REGISTRY_PROVIDER` | `disabled` |
| `REGISTRY_HOST`, `REGISTRY_REPOSITORY` | blank; operator-controlled destination only |
| `REGISTRY_TAGS_IMMUTABLE` | `false`; real publisher fails closed unless operator attests immutable tags |
| `REGISTRY_USERNAME`, `REGISTRY_PASSWORD` | blank; trusted worker secrets only |
| `DATABASE_URL`, `JWT_SECRET` | required backend secrets/configuration; never pass to customer build containers |
| `JOB_POLL_INTERVAL_MS` | `1000` |
| `JOB_LEASE_MS` | `30000` |
| `JOB_HEARTBEAT_INTERVAL_MS` | `10000` |
| `JOB_RETRY_BASE_MS` / `JOB_RETRY_MAX_MS` | `5000` / `300000` |

Do not include values from a developer's `.env` in this handoff or in source
control.

## 10. Security boundaries that must not be weakened

- Keep `EXECUTION_PROVIDER=disabled` and
  `ISOLATED_EXECUTOR_ENABLED=false` by default. Registry publishing also stays
  off unless explicitly configured.
- Customer code is untrusted. Do not run it on the host, interpolate it into a
  shell, or allow it to update Deployment state.
- Customer build containers must never receive Docker socket/API access, host
  filesystem mounts, database/JWT/GitHub/registry/cloud credentials, or
  arbitrary host environment variables.
- Preserve immutable-SHA-only checkout, active lease/generation fencing,
  execution correlation, bounded resources/output/time, cancellation, and
  cleanup/reconciliation.
- Registry destinations must be operator-configured/allowlisted; tags are
  convenience references only. Persist and use the immutable registry digest
  as image identity. Never log credentials or put them in source/build/image
  artifacts.
- Fail closed when runtime, network restrictions, credentials, registry
  destination, lease, or required safety configuration is unavailable.
- No Kubernetes/kOps or AWS work until the appropriate approved phase.

## 11. Current validation and known issues

Validation was run from `deployflow-frontend-main/` on 2026-10-05:

| Command | Result |
|---|---|
| `npm run test` | **Not fully passing:** 101 passed, 1 failed, 2 skipped. The failing assertion is `server/executionProvider.test.js` expecting the old registry/Kubernetes-disabled message; the orchestrator currently reports that registry publishing is not configured. The skipped tests require PostgreSQL. |
| `npm run lint` | Exit 0; two warnings remain for unused `Bell` and `Key` imports in `src/pages/Settings.jsx`. |
| `npm run build` | Passed. |
| Focused executor tests | The direct command including registry provider tests was **not passing:** 44 passed, 10 failed. Failures include `DockerRegistryProvider` constructor errors reading `this.#config.registry` before `this.#config` is assigned. These need fixing before Phase 4D can be considered validated. |
| Phase 4B/4C Docker integration | Previously passed with the locally available pinned runtime image and synthetic fixture; no external registry was involved. |
| `git diff --check` | Passed for the previous Compose CORS-only edit; rerun at the end of future changes. |

No external registry push or Kubernetes deployment was performed for this
handoff. The test results above are not a claim that current Phase 4D code is
ready to enable.

## 12. Current uncommitted work

The full worktree has uncommitted changes. Preserve them all. Current Git
status includes:

- Modified under `deployflow-frontend-main/`: `.env.example`, `README.md`,
  `compose.yaml`, `package.json`; backend `server/app.js`, `app.test.js`,
  `db.js`, `index.js`, `pipeline.js`, `pipeline.test.js`; UI components
  `DeploymentRow.jsx`, `DeploymentTimeline.jsx`, `ProjectCard.jsx`; pages
  `DeploymentDetails.jsx`, `ProjectDetails.jsx`, `deployments.jsx`.
- Untracked root docs: `docs/API_CONTRACT.md`, `docs/ARCHITECTURE.md`, and this
  handoff document.
- Untracked under `deployflow-frontend-main/docs/`:
  `ISOLATED_RUNTIME_IMAGE.md`, `REGISTRY_PUBLISHING.md`.
- Untracked backend implementation/tests: `server/deploymentOrchestrator.js`,
  `deploymentOrchestrator.sourceResolver.test.js`, `deploymentStates.js`,
  `deploymentStates.test.js`, `executionProvider.test.js`,
  `executionReconciliation.js`, `executionReconciliation.test.js`,
  `executorExecutionStore.js`, `executorExecutionStore.test.js`,
  `isolatedVmExecutionProvider.test.js`, `jobQueue.js`, `jobQueue.test.js`,
  `migrate.js`, `migrate.test.js`, `registryOrchestration.test.js`,
  `sourceResolver.test.js`, `worker.js`, and `workerRuntime.js`.
- Untracked `deployflow-frontend-main/server/executors/`: `DockerCliRuntime.js`,
  `DockerRegistryProvider.js`, `ExecutionProvider.js`,
  `FakeExecutionProvider.js`, `FakeRegistryProvider.js`, `FakeSupervisor.js`,
  `GitSourceFetcher.js`, `isolatedRuntime.integration.test.js`,
  `IsolatedVmExecutionProvider.js`, `IsolatedVmSupervisor.js`,
  `IsolatedVmSupervisor.test.js`, `RegistryProvider.js`,
  `RegistryProvider.test.js`, `SourceResolver.js`,
  `staticAppServer.mjs`, `StaticNodeApplicationBuilder.js`,
  `StaticNodeApplicationBuilder.test.js`, `boundedCommand.js`, and
  `runtime-image/`.
- Untracked migration files under `deployflow-frontend-main/server/migrations/`:
  `0001_baseline.sql` through `0007_registry_images.sql`.
- Untracked frontend state helper: `deployflow-frontend-main/src/utils/deploymentStates.js`.

There are also untracked root-level docs as listed above. Do not stage, discard,
or rewrite any of these files as part of unrelated work.

## 13–15. Current phase, next objective, and limitations

**Current phase: Phase 4D — registry integration, in progress and not
validated.**

**Exact next objective:** finish the registry integration for the Phase 4C
local OCI image. Resolve the focused provider constructor failures and the
remaining existing-suite assertion mismatch, then verify the provider
boundary, trusted-only authentication, allowlisted destination, deterministic
tag, digest retrieval, lease-fenced persistence/retries, and secret-free
logging. Run the full tests, lint, build, and `git diff --check`. If a local
registry is used, make its configuration explicit and test it safely; do not
push to an external registry by default.

Current limitations include: no real registry integration has been validated;
no registry credentials are configured here for a real push; the current app
runtime supports only dependency-free static Node/npm projects; there is no
Kubernetes/kOps, Service/Ingress, live URL, or AWS deployment; the Compose
worker image does not include Docker CLI/daemon wiring; and the latest full
test run has one failure and two PostgreSQL-dependent skips.

Phase 4E should begin only after Phase 4D is complete and reviewed. Its scope
would be Kubernetes/kOps deployment by immutable registry digest, with
trusted-only credentials, least privilege, durable/fenced lifecycle, and
Service/Ingress/live URL handling. Do not start that work as part of finishing
Phase 4D.

## 16. Important files and directories

- `deployflow-frontend-main/src/` — React/Vite UI.
- `deployflow-frontend-main/server/app.js` — Express routes, auth middleware,
  CORS, and API response shaping.
- `deployflow-frontend-main/server/jobQueue.js`,
  `workerRuntime.js`, `worker.js` — durable work and worker process.
- `deployflow-frontend-main/server/deploymentOrchestrator.js`,
  `deploymentStates.js` — trusted deployment lifecycle.
- `deployflow-frontend-main/server/executors/` — provider contracts,
  source resolver, isolated Docker runtime/supervisor, static image builder,
  and Phase 4D registry provider work.
- `deployflow-frontend-main/server/executorExecutionStore.js` —
  lease-fenced execution and registry metadata persistence.
- `deployflow-frontend-main/server/migrations/` — additive PostgreSQL
  migrations; never edit immutable migrations `0001`–`0005`.
- `deployflow-frontend-main/compose.yaml`,
  `Dockerfile.api`, `.env.example` — local services and configuration examples.
- `deployflow-frontend-main/docs/ISOLATED_RUNTIME_IMAGE.md` and
  `REGISTRY_PUBLISHING.md` — runtime image and current registry design notes.
- `docs/ARCHITECTURE.md`, `docs/API_CONTRACT.md` — repository-level architecture
  and API notes; both are currently untracked worktree files.

## 17. Rules for future Copilot agents

- Do not reset, revert, clean, or overwrite existing worktree changes.
- Do not modify the frontend unnecessarily for backend phases.
- Preserve fail-closed execution and lease/source-SHA fencing.
- Do not enable repository execution or registry push by default.
- Never expose a Docker socket/API or host credentials to customer workloads.
- Do not implement Kubernetes/kOps or AWS until the appropriate phase.
- Do not commit or push unless explicitly requested.

## How to continue from another machine/account

Clone the repository and read this document first:

```bash
git clone https://github.com/swati165/deployhub.git
cd deployhub
```

Then inspect `git branch -a` and check out the intended branch if it is
available. The current worktree branch is `swati165-deployhub-mvp`, but the
current changes (including this handoff) are uncommitted; a clone will not
contain them unless that work is separately transferred or published. Do not
assume that the local runtime image, Docker state, `.env`, PostgreSQL data, or
registry credentials exist on the other machine.
