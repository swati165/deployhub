# Trusted registry publishing

Registry publishing is a separate worker-side capability, downstream of the
Phase 4C local OCI image builder. It does not change the supported application
build scope and does not deploy an image to Kubernetes.

The safe defaults are:

```dotenv
EXECUTION_PROVIDER=disabled
ISOLATED_EXECUTOR_ENABLED=false
REGISTRY_PUSH_ENABLED=false
REGISTRY_PROVIDER=disabled
```

To enable a trusted Docker-compatible registry, configure these variables only
in the trusted worker environment:

```dotenv
REGISTRY_PUSH_ENABLED=true
REGISTRY_PROVIDER=docker
REGISTRY_HOST=registry.example.test
REGISTRY_REPOSITORY=team/deployhub-app
REGISTRY_TAGS_IMMUTABLE=true
REGISTRY_USERNAME=<trusted-publisher>
REGISTRY_PASSWORD=<secret-from-your-secret-store>
```

`REGISTRY_HOST` and `REGISTRY_REPOSITORY` are operator-owned configuration;
project owners cannot choose or override a destination. `REGISTRY_PASSWORD`
must be injected from a secret manager, not committed to `.env.example` or
source control. The deployment is intentionally marked failed after a
successful push until Kubernetes deployment is implemented.

The base Compose configuration does not give the worker Docker access. For a
trusted local development machine only, the optional
`compose.worker-docker.yaml` override installs Docker CLI in the worker image
and mounts the configured host Docker socket into the worker service only.
Set `DOCKER_SOCKET_PATH` to the host socket path and `DOCKER_SOCKET_GID` to its
numeric group ID, then start the stack with both Compose files:

```sh
docker compose -f compose.yaml -f compose.worker-docker.yaml up --build -d db api worker
```

The socket
grants effectively host-administrator control of that Docker daemon; use this
only on a machine where the worker is fully trusted, not in a shared or
multi-tenant deployment. The isolated customer container is not given the
socket, Docker CLI, or host bind mounts. The override does not change the
disabled execution or registry defaults.

The real provider checks that the local image exists and matches its recorded
image ID, authenticates through Docker CLI password stdin, then tags and pushes
from the trusted worker. It uses a short-lived private Docker config directory
and removes it after the operation. Its Docker child process gets a minimal
environment; registry credentials are not added to the source checkout,
generated Docker build context, application image, or isolated customer
container. Provider output is bounded and errors are sanitized before they are
stored or logged.

Each tag is `dh-` followed by the SHA-256 hash of deployment ID, execution ID,
and immutable source commit SHA. The tag is only an idempotency/convenience
reference. A pre-existing remote tag is reused only if its manifest config
digest matches the local image ID; a conflicting image fails with
`DUPLICATE_EXECUTION`. The configured registry must independently enforce tag
immutability to close the race between the preflight check and push.
`REGISTRY_TAGS_IMMUTABLE=true` is an explicit operator attestation; DeployHub
cannot verify the registry's server-side policy. Do not enable publishing
unless immutable tags are enforced for the configured repository.

The returned registry manifest digest is stored as the authoritative
`registry/repository@sha256:...` identity in `deployment_registry_images`,
along with the local image reference and image ID, registry/repository/tag,
deployment/job/execution IDs, lease generation, source SHA, provider, and push
timestamp. Migration `0007` adds this metadata table without changing the
public deployment API or immutable migrations `0001`–`0005`. Writes and
idempotent reads require the matching active job lease and persisted source
SHA. A second execution cannot overwrite another execution's metadata or tag
reservation.

Tests use a deterministic fake provider or a mocked Docker command runner.
They do not contact an external registry or push an image. The Docker runtime
integration test covers only the isolated build and local application image;
no registry or Kubernetes integration service is provisioned by this
repository.
