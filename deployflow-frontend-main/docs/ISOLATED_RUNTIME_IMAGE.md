# Isolated runtime image

The isolated Docker supervisor uses a dedicated image that is separate from
`Dockerfile.api`. Build it from the `server/executors/runtime-image` directory;
the build context contains no DeployHub application or worker source:

```powershell
docker build --platform linux/amd64 `
  --file server/executors/runtime-image/Dockerfile `
  --tag deployhub/isolated-node:dev `
  server/executors/runtime-image
```

The Dockerfile pins the official Node image's **linux/amd64 manifest**:

- Repository: `docker.io/library/node`
- Base digest: `sha256:2c752226d477b4a886378baa95b9af252be59301b725fdb0b7e15208131505a8`
- Official Node image source: `https://github.com/nodejs/docker-node`
- Node.js major: 22
- Git package: Alpine `git=2.54.0-r0`
- Git runtime dependency packages are also version-pinned in the Dockerfile.
- Verified versions for this build: Node.js `v22.23.3`, npm `10.9.9`,
  Git `2.54.0`

The digest was obtained from Docker's manifest metadata for the official
`node:22-alpine` image, selecting the `linux/amd64` manifest (the build
environment's architecture). It is a content digest, not a tag. Git is
installed from the Alpine 3.24 package repository with exact versions for Git
and its runtime dependencies; the build fails rather than silently selecting
different package versions if these are unavailable. Node/npm versions are
properties of the pinned base image. Check the built image's versions before
approving or rebuilding:

```powershell
docker run --rm --entrypoint /bin/sh deployhub/isolated-node:dev -c `
  'id; node --version; npm --version; git --version; /bin/sleep 1'
```

The image contains Node.js, npm, Git, Alpine's `/bin/sh` and `/bin/sleep`, and
an empty, UID-1000-readable/writable `/opt/deployhub/npm-cache`. Unneeded
Corepack/Yarn files from the base are removed. It contains no DeployHub source,
application secrets, credentials, Docker client/socket, or deployment tooling.
The container defaults to UID/GID 1000 and does not need privileged mode, host
networking, or host filesystem mounts.

## Offline dependency scope

The integration test uses no external npm packages. It verifies `npm ci
--offline` for a synthetic dependency-free lockfile, but there are no customer
build fixtures or approved package-cache seed set in this repository.
Consequently, the image cache is deliberately empty. The supervisor's
`npm ci --offline --ignore-scripts --cache /opt/deployhub/npm-cache` will fail
for lockfiles whose package tarballs and metadata are not already cached. This
image currently supports only a dependency-free install smoke test; it does
**not** claim support for arbitrary npm dependencies or customer builds.

Before supporting a build dependency set, prepare an explicit, reviewed cache
seed from its lockfile using trusted tooling (never run package lifecycle
scripts while seeding), verify package integrity against lockfile integrity
fields, and build a new image with that seed. Record the exact seed/lockfile
scope and image digest. Network access remains disabled for the build
container; an empty/missing cache must fail rather than fall back to online
installation.

## Pinning the locally built runtime

After building, inspect the actual local repository digest and versions:

```powershell
docker image inspect deployhub/isolated-node:dev `
  --format 'id={{.Id}} repoDigests={{json .RepoDigests}}'
docker run --rm --entrypoint /bin/sh deployhub/isolated-node:dev -c `
  'id; node --version; npm --version; git --version; test -r /opt/deployhub/npm-cache; test -w /opt/deployhub/npm-cache'
```

The supervisor accepts only a repository reference ending in a 64-hex
`@sha256:` digest. Configure the locally built image using an actual digest
reported by Docker and supported by the local daemon, for example:

```text
ISOLATED_EXECUTOR_IMAGE=repository@sha256:<actual-image-digest>
```

Do not put a machine-specific runtime digest in `.env.example` or commit it.
Do not use a tag such as `latest` for the supervisor. Do not push this local
development image to a registry as part of this phase.
