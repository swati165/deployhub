# DeployHub API Contract

## Status and scope

This is the contract implemented by `deployflow-frontend-main/server/app.js`.
It records current paths, authorization, response shapes, and error behavior.
Deployment responses use uppercase canonical statuses; legacy lowercase rows
are normalized during the compatibility window.

All endpoints are rooted at `/api`. Requests and responses use JSON unless
noted otherwise. User-specific endpoints accept a JWT bearer token or an
unrevoked DeployHub API key in the `Authorization: Bearer <token>` header.
Every project, deployment, and log query is scoped to the authenticated user.

The API uses a 32 KiB JSON request-body limit, parameterized SQL, CORS restricted
to the configured frontend origin, security headers, and rate limits. The
authentication endpoints have an additional rate limit.

## Common error responses

Errors use this shape:

```json
{ "error": "Human-readable explanation." }
```

| HTTP status | Current meaning |
|---|---|
| `400` | Invalid JSON, field validation error, invalid query parameter, or unsupported GitHub URL/branch. |
| `401` | Missing, invalid, expired, or revoked bearer credential; or deleted account. |
| `404` | Route, project, deployment, or API key not found (including resources not owned by the caller). |
| `409` | Duplicate registration email, duplicate project repository for the user, or duplicate email update. |
| `500` | Unexpected server/database error; response is generic and details are logged server-side. |

Malformed JSON returns `400`. There is no standardized error `code`, request
correlation ID, or pagination envelope in the current API.

## Authentication

### `POST /api/auth/register`

Unauthenticated. Creates an account and returns a signed-in session.

Request:

```json
{ "email": "person@example.com", "password": "at-least-12-bytes" }
```

Email is trimmed/lowercased. Password size must be 12–72 UTF-8 bytes.
The database stores a bcrypt hash. UML mentions `username`; the current
registration contract does not accept it.

Response `201 Created`:

```json
{
  "user": { "id": "uuid", "email": "person@example.com" },
  "token": "jwt"
}
```

Duplicate email returns `409`.

### `POST /api/auth/login`

Unauthenticated.

Request: `{ "email": "person@example.com", "password": "..." }`

Response `200 OK`: same `{ "user": ..., "token": ... }` shape as registration.
Invalid credentials return `401` with a generic message.

### `GET /api/auth/me`

Authenticated. Response `200 OK`: `{ "user": { "id": "uuid", "email": "..." } }`.

There is no server-side logout endpoint. The frontend logs out by removing its
stored token. JWT lifetime is 12 hours.

### API keys

- `GET /api/settings/api-keys` returns `{ "apiKeys": [...] }`; the secret is
  never returned for existing keys.
- `POST /api/settings/api-keys` with `{ "name": "automation" }` returns `201`
  and `{ "apiKey": { "id", "name", "maskedKey", "createdAt", "lastUsedAt",
  "key" } }`. The full key is returned only once; the database stores its
  SHA-256 hash.
- `DELETE /api/settings/api-keys/:id` revokes the caller-owned key and returns
  `204 No Content`.

## Projects

### `GET /api/projects`

Authenticated. Returns `{ "projects": [project, ...] }`, newest first.

Project fields:

```json
{
  "id": "uuid",
  "name": "Website",
  "description": "",
  "repoUrl": "https://github.com/owner/repo.git",
  "branch": "main",
  "status": "idle",
  "stack": null,
  "deploymentsCount": 0,
  "lastDeployed": null,
  "createdAt": "timestamp"
}
```

`status` and `stack` summarize the most recent deployment when one exists.

### `POST /api/projects`

Authenticated. Creates a project.

Request:

```json
{
  "name": "Website",
  "description": "Optional description",
  "repoUrl": "https://github.com/owner/repo",
  "branch": "main"
}
```

`name` is required (1–60 allowed Unicode letters/numbers/spaces/dot/underscore/
hyphen and must start with a letter or number). `description` is optional and
up to 500 characters. `branch` defaults to `main`. `repoUrl` must be a public
GitHub HTTPS repository URL; it is normalized to the `.git` URL. Response
`201 Created`: `{ "project": project }`. A duplicate repository for the same
user returns `409`.

### `GET /api/projects/:id`

Authenticated and owner-scoped. Response `200 OK`: `{ "project": project }`.
Invalid IDs and missing/not-owned projects return `404`.

There are no project update or delete endpoints in the current API.

## Deployments

### `POST /api/projects/:id/deployments`

Authenticated and owner-scoped. Starts an **asynchronous** deployment attempt
for the project's saved repository and either its saved branch or an optional
override.

Request: `{}` or `{ "branch": "main" }`

Response `202 Accepted`:

```json
{ "deployment": { "id": "uuid", "status": "QUEUED", "stage": "QUEUED" } }
```

The API commits the Deployment row, initial `Deployment queued.` log, and one
durable internal job in a single PostgreSQL transaction. It returns `202` only
after that transaction commits; it does not wait for worker execution. Repeated
POST requests create separate Deployment attempts and jobs. Internal job state,
worker identity, attempts, and lease details are never returned.

This path differs from the UML sequence example `POST /projects/deploy`.
The current project-scoped endpoint is the implemented contract. The UML
example is not an implemented alias and no synchronous deployment response is
provided.

### `GET /api/projects/:id/deployments`

Authenticated and owner-scoped. Returns up to the latest 100:
`{ "deployments": [deployment, ...] }`.

### `GET /api/deployments`

Authenticated. Returns up to the latest 100 deployments owned by the caller:
`{ "deployments": [deployment, ...] }`.

### `GET /api/deployments/:id`

Authenticated and owner-scoped. Response `200 OK`:

```json
{
  "deployment": {
    "id": "uuid",
    "projectId": "uuid",
    "project": "Website",
    "branch": "main",
    "status": "BUILDING",
    "stage": "CREATING_IMAGE",
    "stack": "Node.js",
    "image": null,
    "liveUrl": null,
    "error": null,
    "author": "person@example.com",
    "createdAt": "timestamp",
    "updatedAt": "timestamp",
    "logs": [
      {
        "id": 1,
        "type": "info",
        "text": "Build started.",
        "createdAt": "timestamp"
      }
    ]
  }
}
```

`logs` is included on deployment detail. List endpoints provide deployment
fields without the detailed `logs` array. `liveUrl` is populated only after the
worker reports a successful Kubernetes rollout. Missing deployment IDs return
`404`.

### Status values and polling

The PostgreSQL contract and API use:

```text
QUEUED | VALIDATING | CLONING | BUILDING | PUSHING_IMAGE | DEPLOYING | RUNNING | FAILED
```

The frontend understands both this vocabulary and legacy lowercase values
during migration compatibility. API response shaping converts legacy states to
the canonical uppercase representation. The frontend polls
`GET /api/deployments/:id` while a recognized active status is present and
stops for `RUNNING` or `FAILED`. Unknown statuses render neutrally and are never
treated as success. There is no server-sent events or WebSocket endpoint. No
`Retry-After`, polling interval, or idempotency-key contract is specified.

## Logs

### `GET /api/logs`

Authenticated. Returns the latest 200 caller-owned deployment logs:
`{ "logs": [...] }`.

Optional query parameters:

- `projectId=<uuid>` filters to a project.
- `level=info|success|error` filters by level. `level=all` is equivalent to no
  level filter.

Each row contains `id`, `type` (stored log level), `text` (stored message),
`createdAt`, `projectId`, `project`, and `deploymentId`. Invalid project IDs or
levels return `400`. Records are newest-first here; logs in deployment detail
are oldest-first.

The UML uses `step`, `message`, and `timestamp`; current API names are
`type`, `text`, and `createdAt`. There is no separate structured `step` field
in the current `deployment_logs` table.

## Dashboard and settings

- `GET /api/dashboard`: authenticated. Returns `stats` (`totalProjects`,
  `activeDeployments`, `successRate`, `failedDeployments`) and up to five
  `recentDeployments`.
- `GET /api/settings/profile`: `{ "profile": { "fullName", "email" } }`.
- `PATCH /api/settings/profile`: accepts `fullName` (up to 80 characters)
  and/or `email`; returns the updated `profile`.
- `GET /api/settings/notifications`: `{ "preferences": { ... } }`.
- `PATCH /api/settings/notifications`: accepts `{ "preferences": { ... } }`
  with boolean values for `deploySuccess`, `deployFailed`, `podCrash`, and
  `weeklyReport`; returns the merged preferences.

## Health

### `GET /api/health`

Unauthenticated. Checks database connectivity with `SELECT 1`. Returns
`200 OK` with `{ "status": "ok" }` when successful.

## UML-aligned API mapping

Do not add a second `POST /projects/deploy` API. Retain the current resource-
oriented endpoints and document them as the supported form of the UML action:

| UML operation | Current endpoint / proposed interpretation |
|---|---|
| Register / Login | `POST /api/auth/register` / `POST /api/auth/login`; keep the current JSON token response. A `username` requirement would need an explicit approved contract and migration. |
| Create project with repository URL | `POST /api/projects`; URL shape is checked here. |
| Validate repository and deploy project | `POST /api/projects/:id/deployments`; resolve the repository from the owned project, persist the attempt, return `202`, then validate/clone/build asynchronously. |
| View project/deployment status | `GET /api/projects/:id`, `/api/projects/:id/deployments`, `/api/deployments`, and `/api/deployments/:id`. |
| View deployment logs | `GET /api/deployments/:id` or `GET /api/logs`. |
| Access live application URL | Read `deployment.liveUrl` after status is `RUNNING` (future canonical value); current status is `live`. |

### Approved response/status contract (implemented)

Keep the asynchronous resource-oriented API and `202 Accepted`. The approved
future `status` values are uppercase:

```text
QUEUED | VALIDATING | CLONING | BUILDING | PUSHING_IMAGE | DEPLOYING | RUNNING | FAILED
```

Legacy status values are normalized and backfilled using:

```text
queued    -> QUEUED
cloning   -> CLONING
building  -> BUILDING
pushing   -> PUSHING_IMAGE
deploying -> DEPLOYING
live      -> RUNNING
failed    -> FAILED
```

`VALIDATING` is new persisted progress before clone. `QUEUED` remains the
Deployment status while accepted work waits. Internal job/queue values such as
`WAITING`, `RUNNING`, `RETRYING`, and `DEAD_LETTERED` are not Deployment
statuses and must not be exposed as the `status` field.

`stage` describes the current activity; it is not a list of completed steps.
The target stages, ordered within their statuses, are:

```text
QUEUED:
  QUEUED
VALIDATING:
  VALIDATING_REPOSITORY
CLONING:
  CLONING_REPOSITORY
BUILDING:
  DETECTING_TECHNOLOGY
  INSTALLING_DEPENDENCIES
  BUILDING_APPLICATION
  CREATING_IMAGE
PUSHING_IMAGE:
  AUTHENTICATING_REGISTRY
  PUSHING_IMAGE
DEPLOYING:
  APPLYING_KUBERNETES_DEPLOYMENT
  CREATING_SERVICE
  CREATING_INGRESS
  VERIFYING_ROLLOUT
  GENERATING_LIVE_URL
RUNNING:
  RUNNING
FAILED:
  retain the stage of the failed activity
```

There is no persisted `CLONE_COMPLETED` stage. When clone succeeds, write
`Repository cloned successfully` as a deployment log event; change status to
`BUILDING` and stage to `DETECTING_TECHNOLOGY`. The detailed state transitions
and retry/failure rules are defined in `ARCHITECTURE.md`.

Deployment detail uses this representation:

```json
{
  "deployment": {
    "id": "uuid",
    "projectId": "uuid",
    "project": "Website",
    "branch": "main",
    "status": "QUEUED",
    "stage": "QUEUED",
    "stack": null,
    "image": null,
    "liveUrl": null,
    "error": null,
    "createdAt": "timestamp",
    "updatedAt": "timestamp",
    "logs": []
  }
}
```

**Queued:** `POST /api/projects/:id/deployments` returns `202 Accepted` with
the deployment ID and a snapshot showing `status=QUEUED`, `stage=QUEUED`, null
`liveUrl`, and null `error`. Work may be claimed before the response reaches
the client; `GET /api/deployments/:id` is authoritative for current state.
The response never contains internal job/queue state.

**Active near completion:** detail returns `200 OK`, `status=DEPLOYING`, the
current stage, and no live URL until success:

```json
{
  "deployment": {
    "id": "uuid",
    "projectId": "uuid",
    "project": "Website",
    "branch": "main",
    "status": "DEPLOYING",
    "stage": "VERIFYING_ROLLOUT",
    "stack": "Node.js",
    "image": "registry.example/deployhub/uuid:tag",
    "liveUrl": null,
    "error": null,
    "createdAt": "timestamp",
    "updatedAt": "timestamp",
    "logs": []
  }
}
```

**Failed:** the existing deployment resource returns `200 OK`; failure is a
persisted deployment outcome, not a failure of the GET request. Preserve the
stage where the operation failed and return a safe message:

```json
{
  "deployment": {
    "id": "uuid",
    "projectId": "uuid",
    "project": "Website",
    "branch": "main",
    "status": "FAILED",
    "stage": "BUILDING_APPLICATION",
    "stack": "Node.js",
    "image": null,
    "liveUrl": null,
    "error": "Application build failed; review the build logs.",
    "createdAt": "timestamp",
    "updatedAt": "timestamp",
    "logs": [
      {
        "id": 1,
        "type": "error",
        "text": "Application build failed; review the build logs.",
        "createdAt": "timestamp"
      }
    ]
  }
}
```

Do not add a `failedStage` field; `stage` remains the failed activity. Do not
include secrets or unsafe raw process output in `error` or user-visible logs.

**Completed successfully:** “Completed” is descriptive, not a status value.
The successful terminal response is `200 OK` with `status=RUNNING`,
`stage=RUNNING`, non-null `liveUrl`, and null `error`. The POST remains
asynchronous and returns `202`; it does not hold the request open through
build or Kubernetes rollout.

The API and frontend ship as a compatibility release. The database accepts
legacy values only between migrations `0002` and `0004`; the application writes
uppercase values and normalizes legacy reads. Unknown statuses render neutrally
rather than as success.

## Proposed request/response behavior for asynchronous deployments

The current request and `202` response should remain the architectural model:

1. Validate authorization, project ownership, and branch synchronously.
2. Persist the `QUEUED` Deployment, initial log, and durable job atomically.
3. Return a deployment ID and initial queued state; do not block the HTTP
   request on repository builds or Kubernetes readiness.
4. The caller polls the detail endpoint for persisted status/stage/logs.
5. Return `liveUrl` only once readiness and ingress checks succeed; persist
   failure reason and last stage when any prerequisite or execution step fails.

The deployment status can move only through
`QUEUED -> VALIDATING -> CLONING -> BUILDING -> PUSHING_IMAGE -> DEPLOYING ->
RUNNING`, with a transition to `FAILED` allowed from every nonterminal status.
`RUNNING` and `FAILED` are terminal for that attempt. A user retry creates a
new Deployment record; bounded internal retries for transient failures may
reuse the same job and Deployment without changing its lifecycle status.

The durable job queue is PostgreSQL-backed and implemented separately from the
Deployment lifecycle. Repository execution remains disabled until a separately
approved isolated executor exists. Kubernetes infrastructure, AWS, and kOps
remain out of scope.
