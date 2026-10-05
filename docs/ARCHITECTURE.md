# DeployHub Architecture

## Purpose and scope

This document describes the checked-in DeployHub MVP and proposes a path from it
to the architecture in `UML Report.pdf`. The migration runner, deployment-state
migrations, and PostgreSQL-backed deployment job worker are implemented. Actual
repository execution and cloud infrastructure remain disabled/out of scope.

The MVP consists of an existing React/Vite frontend, a Node.js/Express API, and
PostgreSQL. The API and frontend are served together in production. Docker
Compose runs PostgreSQL, the API, and (for VM hosting) Caddy. DeployHub itself
is currently hosted as a Compose application; the VM is not the Kubernetes
target for user applications.

## Current architecture

```text
User browser
    | HTTPS / same-origin API requests
    v
Caddy (VM Compose deployment; local development can use Vite)
    |-----------------------> React/Vite static frontend
    |                              |
    |                              | /api requests
    v                              v
                    Express API (server/app.js)
                      |          |
                 auth/API    PostgreSQL <----- Deployment worker
                      |          |             (server/worker.js)
                      v          |                    |
                  JWT/API key    +--- deployment_jobs |
                                                   orchestrator
                                               (execution disabled)
```

`deployflow-frontend-main/src/utils/api.js` centralizes browser API calls.
`server/app.js` contains authentication middleware, route handlers, validation
calls, and response shaping. It queries PostgreSQL with parameterized SQL.
`server/schema.sql` is the retained current-schema reference. The immutable
`server/migrations/0001_baseline.sql` is byte-for-byte identical to it.
`server/migrate.js` runs separately from API startup, verifies/adopts a matching
existing baseline or applies it to a fresh database, records SHA-256 checksums,
and serializes migration runners with a PostgreSQL advisory lock. API and worker startup require migrations through `0006` and fail clearly if
they have not run. API startup does not mutate active deployments.
`server/jobQueue.js` owns only durable internal job state and claims;
`server/deploymentOrchestrator.js` owns deployment lifecycle transitions.
The API routes and deployment orchestration are not yet split into the full
service/repository architecture pictured in the UML.

### Current persistence model

```text
users 1 ───── * projects 1 ───── * deployments 1 ───── * deployment_logs
                                          |
                                          └──────────── * deployment_jobs 1 ───── * deployment_executions
  |                                  |
  └──────────── * api_keys            └── user_id (ownership)
```

The UML's four principal entities are represented as follows:

| UML entity | Current PostgreSQL representation | Notes |
|---|---|---|
| User | `users` | UUID, unique email, password hash, full name, notification preferences, creation time. There is no `username` column. |
| Project | `projects` | UUID, owner, name, description, GitHub URL, branch, creation time. |
| Deployment | `deployments` | UUID, project and user owner, status, stage, branch, detected stack, image, live URL, error, creation/update times. |
| DeploymentLog | `deployment_logs` | Bigserial ID, deployment, level, message, creation time. The API exposes the timestamp as `createdAt`; the UML calls it `timestamp`. |
| Deployment job | `deployment_jobs` | Durable internal queue row; not part of the public deployment response. |
| Deployment execution | `deployment_executions` | One provider execution per job lease generation, including provider correlation, bounded result, cleanup state, and recovery metadata. |

API keys are an additional current entity, not part of the UML's core model.
Project and deployment records are ownership-scoped in API queries.

## Current deployment behavior

`POST /api/projects/:id/deployments` validates the authenticated user's project
and optional branch, then commits the Deployment, initial log, and one
`deployment_jobs` row in a single transaction. It returns `202 Accepted` only
after commit. Repeated POST requests intentionally create distinct attempts.
The worker runs separately from the API and claims from PostgreSQL with
`FOR UPDATE SKIP LOCKED`, leases, heartbeats, and a fencing generation.

Jobs allow three automatic attempts. Retryable failures enter `RETRY_WAIT` with
bounded exponential backoff and jitter; permanent failures or exhausted
attempts become `DEAD_LETTER` and set the Deployment to `FAILED` at its current
stage. User retries create a new Deployment and job. Job state is internal and
never appears in deployment API responses. If a worker crashes, a later worker
reclaims its expired lease; API restart alone does not change Deployment state.

The worker/orchestrator validates the repository URL and can resolve a
configured public GitHub branch ref to an immutable commit SHA using a bounded,
authenticated GitHub API request. It persists that pin only under the active
worker lease, preserves `deployments.branch` as the user's requested ref, and
passes the exact persisted SHA to the provider. A missing resolver/token,
unavailable ref, stale lease, or mismatched pin fails closed before provider
start. Configure `SOURCE_RESOLVER=github` and `GITHUB_SOURCE_TOKEN` on the
trusted worker only; the credential is not included in execution input.
`EXECUTION_PROVIDER=disabled` and `ISOLATED_EXECUTOR_ENABLED=false` remain the
defaults. When explicitly enabled with a digest-pinned runtime image, the local
supervisor obtains Git objects without checking out or running customer code
on the host, imports them into a disposable Docker tmpfs workspace, checks out
and verifies the persisted SHA inside the container, then runs a locked offline
Node.js build. Docker containers run with no network, no host mounts, a
read-only root, dropped capabilities, non-root UID, CPU/memory/swap/PID and
storage limits, a hard timeout, and bounded output. Unsupported egress policy
or Docker configurations fail closed. Docker shares the host kernel and its
daemon is privileged infrastructure, so this local runtime is not an equivalent
to a dedicated disposable VM. Registry, Kubernetes, and cloud actions remain
disabled. Migration `0006` adds nullable `source_commit_sha` and
`source_resolved_at` to the internal job. `deployment_executions` stores one
execution per job lease generation so automatic retries can retain distinct
execution history.

Actual customer-repository execution is high risk. A repository's Dockerfile,
package lifecycle scripts, or build script can execute arbitrary code. The
existing `BUILD_RUNNER_ISOLATED=true` setting is an operator assertion, not an
isolation control. The worker must remain disabled unless it is run in a
disposable, resource-limited environment with a dedicated Docker daemon and
least-privilege registry and Kubernetes credentials.

## UML comparison: implemented and outstanding

| UML requirement | Current state |
|---|---|
| Authentication: register and login | Implemented with bcrypt password hashes and 12-hour JWTs. Bearer API keys are also supported. There is no server-side logout endpoint; frontend logout discards its token. |
| User has username, email, password hash | Email and password hash exist; the current `full_name` is not the UML `username`. |
| User owns projects; project has deployment attempts | Implemented with PostgreSQL foreign keys and owner-scoped API access. |
| Project stores GitHub repository URL | Implemented. Only public GitHub HTTPS repository URLs are accepted. |
| Validate repository before deployment | The URL is validated at project creation and by the trusted worker. When configured, the worker resolves a public GitHub branch to an immutable SHA; it does not clone the repository. |
| Clone repository | Not implemented; repository checkout remains disabled. |
| Detect technology | A basic detector exists, but it is not run against submitted repository contents. |
| Install dependencies and build | Not implemented; customer dependency or build commands are not executed. |
| Build/push Docker image | Not implemented; Docker and registry operations remain disabled. |
| Kubernetes Deployment, Service, Ingress and live URL | Not implemented; Kubernetes and cloud operations remain disabled. |
| Persist deployment status and logs | Implemented in PostgreSQL using the approved uppercase status contract and detailed stage vocabulary; API responses normalize legacy values during compatibility. |
| Frontend displays deployments and logs | The dashboard, project/deployment views, and log viewer use the API. Settings and Monitoring include demo/mock portions. |
| Service-oriented API layers and database access layer | Partially implemented. The route/controller and pipeline files provide some separation, but there is no dedicated repository/DAO layer or independent service modules matching all UML components. |
| Durable asynchronous execution | Implemented with a custom PostgreSQL job table and separate worker process. |
| Local Kubernetes development | Not included in the checked-in Compose stack. |
| AWS and kOps | Not implemented and explicitly out of scope until local workflow and Kubernetes design are approved. |

## Implemented deployment state and stage contract

The UML class diagram's enum is coarse, while its state machine/activity
diagrams show individual operations. Keep those separate: `status` is the
deployment lifecycle state; `stage` is the **current activity**; logs are the
timestamped history of milestones and events.

### Deployment status values

```text
QUEUED
VALIDATING
CLONING
BUILDING
PUSHING_IMAGE
DEPLOYING
RUNNING
FAILED
```

`QUEUED` is persisted on the Deployment while accepted work waits for a worker.
Internal job states (for example, waiting, running, retrying, or dead-lettered)
are separate worker/queue concerns and must never be returned as
`Deployment.status`. `RUNNING` and `FAILED` are terminal for one deployment
attempt; there is no separate `COMPLETED` status.

### Deployment stage values

`QUEUED` and `RUNNING` are included as initial/successful terminal stages. A
failed Deployment retains the stage of the activity that failed; there is no
generic `FAILED` stage and no separate `failedStage` field.

| Status | Allowed current stage values, in order |
|---|---|
| `QUEUED` | `QUEUED` |
| `VALIDATING` | `VALIDATING_REPOSITORY` |
| `CLONING` | `CLONING_REPOSITORY` |
| `BUILDING` | `DETECTING_TECHNOLOGY`, `INSTALLING_DEPENDENCIES`, `BUILDING_APPLICATION`, `CREATING_IMAGE` |
| `PUSHING_IMAGE` | `AUTHENTICATING_REGISTRY`, `PUSHING_IMAGE` |
| `DEPLOYING` | `APPLYING_KUBERNETES_DEPLOYMENT`, `CREATING_SERVICE`, `CREATING_INGRESS`, `VERIFYING_ROLLOUT`, `GENERATING_LIVE_URL` |
| `RUNNING` | `RUNNING` |
| `FAILED` | Preserve the stage at which the failure occurred. |

There is deliberately no persisted `CLONE_COMPLETED` stage. While cloning,
the current stage is `CLONING_REPOSITORY`. After clone succeeds, record
`Repository cloned successfully` as a deployment log event, then transition to
`status=BUILDING, stage=DETECTING_TECHNOLOGY`. The stage describes what is
happening now; logs retain completed milestones.

### Status transitions

Only the following forward transitions and failure transitions are valid:

```text
QUEUED -> VALIDATING -> CLONING -> BUILDING -> PUSHING_IMAGE -> DEPLOYING -> RUNNING
   |          |           |          |              |             |
   +----------+-----------+----------+--------------+-------------+-----> FAILED
```

Expanded failure edges are `QUEUED -> FAILED`, `VALIDATING -> FAILED`,
`CLONING -> FAILED`, `BUILDING -> FAILED`, `PUSHING_IMAGE -> FAILED`, and
`DEPLOYING -> FAILED`. No other transition is permitted. In particular,
terminal statuses cannot transition back to active states.

Stages advance in their listed order within each lifecycle status. The status
and stage change together; a milestone log records completed work. If an
operation fails, change status to `FAILED` and retain the current stage as the
failed activity. A failure before a worker claims work uses `FAILED` with
`stage=QUEUED`, rather than implying validation began.

### Retry and failure rules

A user-requested retry creates a new Deployment record and a new job; it never
reopens a failed attempt. Internal bounded retries for transient infrastructure
errors may reuse the same job and Deployment, which remains at the activity
being retried. Exhausted retries transition to `FAILED`; deterministic errors
such as invalid repositories or unsupported build configurations should not be
retried automatically.

Persist a bounded, sanitized error message and safe diagnostic context, such as
the deployment ID, stage, timestamps, and non-sensitive error category. Do not
persist credentials, tokens, environment secrets, raw output that may contain
secrets, or submitted source contents. A separate `failedStage` field is not
needed because `stage` remains at the failed activity.

Only `RUNNING` should include a live URL, and only after rollout/readiness
verification and URL generation succeed.

The `0003` data migration converts existing stored statuses and stages:

```text
queued   -> QUEUED
cloning  -> CLONING
building -> BUILDING
pushing  -> PUSHING_IMAGE
deploying-> DEPLOYING
live     -> RUNNING
failed   -> FAILED
```

The migration maps status and stage independently. It fails closed for
unexpected/NULL values, URL anomalies, and status-stage combinations that
cannot satisfy the final contract. Failed legacy rows keep their mapped
activity stage; a legacy `failed/live` pair requires manual review because it
would produce the invalid `FAILED/RUNNING` combination.

## Proposed service boundaries

Retain the existing frontend. When backend modularization is approved, move
responsibilities deliberately rather than maintaining a second API:

```text
HTTP routes/controllers
    ├── Auth service ─────────────── PostgreSQL repositories
    ├── Project service ──────────── PostgreSQL repositories
    └── Deployment orchestrator ─── PostgreSQL repositories
            ├── Repository validation / GitHub adapter
            ├── Stack detection and build adapter
            ├── Docker / registry adapter
            └── Kubernetes adapter
```

Controllers should validate/translate HTTP input and output; orchestration and
integration logic should remain in services. A repository/data-access boundary
should own SQL and transactions. This allows tests to exercise business
behavior without coupling it to Express or a live cluster. Keep the current
directory layout until a separately approved migration identifies all imports,
Docker contexts, scripts, and deployment configuration that need updating.

## Implemented migration foundation and future database approach

The current API uses `pg` and parameterized SQL; there is no ORM. For this
project, continue with explicit SQL migrations rather than adding an ORM:
existing data access is already SQL-based, the core model is small, and a new
ORM would add a second abstraction and dependency without removing the need to
review schema changes.

Implemented in Phases 2A and 2B:

1. `server/migrations/0001_baseline.sql` preserves the current `schema.sql`
   byte-for-byte. `schema.sql` remains in place; it is not executed on startup.
2. `server/migrate.js` discovers versioned SQL files in lexical order, hashes
   exact bytes using SHA-256, and rejects missing, changed, or out-of-order
   applied migrations.
3. For a fresh database, the baseline SQL and its history row commit together.
   For an existing database without history, the runner verifies a catalog
   fingerprint of the existing baseline and records adoption without rerunning
   the baseline DDL. It refuses partial or mismatched schemas.
4. The runner obtains one dedicated `pg` client and uses that same connection
   for the PostgreSQL advisory lock, history reads, migration transactions, and
   unlock. Each migration and its history row are committed in one transaction;
   a failure rolls back and stops the sequence.
5. Migrations `0002`–`0004` expand the status check, validate and backfill
   legacy state data, then enforce uppercase statuses, approved stages,
   status/stage consistency, and URL invariants. Each migration and history row
   commits atomically. Migration `0005` adds durable deployment jobs; migration
   `0006` adds source-SHA metadata and per-generation executor correlation,
   result, and cleanup records. API and worker startup require `0006`.
6. During the compatibility window, API responses and the frontend understand
   both lowercase legacy values and uppercase canonical values; new writes use
   uppercase values only.

The job table is application-owned; no pg-boss or other queue dependency is
used. Continue using ordered immutable SQL migrations and `pg`; no ORM is used.

Before production deployment, run the migration as an explicit release
operation against the intended database and verify backup/restore procedures.
The current Render Blueprint does not yet automate this release operation.

## Durable worker and job lifecycle

Migration `0005_deployment_jobs.sql` creates one internal job per Deployment.
The API inserts the Deployment, initial log, and `WAITING` job atomically. The
job lifecycle is `WAITING -> CLAIMED -> RUNNING`, optionally
`RUNNING -> RETRY_WAIT -> WAITING`, and finally `COMPLETED` or `DEAD_LETTER`.
These values are not Deployment statuses and are never returned through the API.

Workers claim due jobs in short transactions using row locking and
`SKIP LOCKED`; they do not hold transactions open while orchestrating work.
Claims increment attempts and a fencing generation, and carry a lease renewed
by heartbeat. Expired leases are made claimable again unless attempts are
exhausted. A stale worker cannot renew its lease or advance Deployment state
because those writes are conditional on job, worker, and generation. Retry
backoff is bounded exponential with jitter; max automatic attempts is three.
The worker logs active deployments missing jobs as integrity anomalies without
silently changing their Deployment status.

API startup checks the required migration and serves requests without changing
active deployment rows. Worker recovery operates on job leases; it does not
reopen terminal Deployment states. Graceful shutdown stops new claims and lets
in-flight work finish while heartbeats remain active.

The custom queue module controls internal job state only. The orchestrator
controls the approved Deployment status/stage lifecycle. The current
orchestrator intentionally stops before Git/Docker/registry/Kubernetes
execution and marks the attempt `FAILED` with an explicit isolation-boundary
message. The fail-closed isolated provider reserves and persists execution
correlation only when explicitly selected; its VM supervisor remains an
unavailable stub. A separate reconciliation module and `FakeSupervisor`
exercise recovery and cleanup behavior in tests, but production janitor
scheduling is not wired. Provider/supervisor records never write Deployment
status; only the trusted worker/orchestrator does. Future untrusted build
isolation remains a separate approval.

## Proposed local Kubernetes architecture

After local Compose, database migrations, and an isolated build worker are
reliable, use **kind** (Kubernetes-in-Docker) as the first local Kubernetes
target. It provides a repeatable disposable cluster on a Docker-enabled
development machine. Pin the Kubernetes version, document cluster creation and
cleanup, install one chosen Ingress controller, and provide a local DNS/host
mapping approach. Use a local container registry or explicitly load built
images into the kind nodes. Namespace and RBAC should be scoped to DeployHub's
test deployments, with CPU/memory limits and cleanup procedures.

The future request/data flow would be:

```text
Browser -> React frontend -> Express API -> PostgreSQL
                                      |
                                      +-> durable deployment job
                                               |
                                      isolated build worker
                                      clone -> detect -> build -> image
                                               |
                                         local registry
                                               |
                                      Kubernetes adapter -> kind cluster
                                               |
                                       Service + Ingress -> local URL
```

This does not imply installing kind, creating manifests, or enabling the
worker now. The worker must not execute submitted repository code on the API
host. A future AWS/kOps target should be a separately configured adapter and
environment, designed only after this local workflow has been demonstrated.

## Integration and security considerations

- JWT signing secrets and database credentials belong in environment/secret
  storage, not source control. Never log bearer tokens, API keys, passwords,
  or registry credentials.
- API database queries use parameters and user-specific ownership predicates;
  keep those controls at every new route/repository boundary.
- Public GitHub URL validation is not proof that clone/build content is safe.
  DNS/network egress controls, resource/time/disk limits, disposable workers,
  and credentials isolated from builds are required before enabling arbitrary
  repository execution.
- Never pass repository-derived strings through a shell. Continue using
  argument arrays, strict validation, controlled environment variables, and
  bounded process output/time.
- Registry push and cluster access should use narrowly scoped machine
  identities. Never pass their secrets into untrusted build containers.
- Kubernetes workloads need namespace isolation, non-root/read-only defaults
  where feasible, resource quotas, network policy, and an explicit cleanup
  policy. Ingress exposure must not be treated as safe by default.
- A `RUNNING` state must follow successful readiness/rollout checks. Missing
  configuration, tool errors, timeout, and crash must result in a visible
  `FAILED` state with a safe diagnostic.
- Logs are user-visible persistent data. Bound their size and retention, redact
  secrets, and avoid returning another user's logs.
- The existing single API process and in-memory queue are not a production
  multi-replica job architecture. The current VM hosts DeployHub itself; it
  does not currently provide user-project Kubernetes deployments.
