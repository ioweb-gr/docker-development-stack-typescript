# IOWEB TypeScript development stack

Project-neutral Docker and native DDEV runtime support for Node.js 24+
applications. This is an infrastructure layer, not an application starter.

It supports Next.js, React, Encore.ts, generic Node/TypeScript services,
single-package applications, and npm workspace monorepos. Consumers own
framework configuration, application commands, routes, health semantics,
environment variables, and any extra services.

## Requirements

- Docker Desktop with Linux containers for development on Windows or Docker
  Engine for Linux/macOS and production.
- Current DDEV for local development. DDEV's generic project type is used; DDEV
  supplies Node.js and npm inside its web container.
- Node.js 24 is the stack default. `.nvmrc` and `stack.config.json` hold the
  stack version; the Docker build accepts the `NODE_VERSION` build argument.

## Install in a consumer

Run in the application repository root:

```powershell
docker-bootstrap --project-type typescript
ddev start
ddev describe
```

Bootstrap installs this source as `docker/typescript`, creates a native DDEV
`generic` project without a local database, and renders DDEV process, routing,
Mutagen, and volume configuration. It does not provision Commons or add a
database, Redis, queue, or proxy.

The starter process list is empty by design. Add the consumer's server command
and listener port in `.ddev/ioweb-typescript.json` before expecting `ddev launch`
to open an application page.

The same bootstrap command can be run again after updating the pinned stack
submodule. Consumer process settings are stored in
`.ddev/ioweb-typescript.json`; bootstrap preserves that file. Review stack
updates before advancing the consumer's `docker/typescript` submodule pointer.

## Windows, WebStorm, PowerShell, and DDEV

Keep the consumer checkout on its normal Windows drive and edit it directly in
WebStorm. DDEV starts Linux containers through Docker Desktop and manages the
Mutagen session itself. No separate Mutagen installation or start/stop command
is part of the stack workflow.

```powershell
ddev start
ddev launch
ddev stop
ddev restart
ddev ssh
ddev describe
```

Run npm commands in the DDEV web container:

```powershell
ddev npm install
ddev npm run build
ddev npm run typecheck
ddev npm test
```

Use `ddev exec <command>` for commands that do not have a DDEV shortcut. DDEV
reads `.nvmrc`, `.node-version`, and Node version declarations in
`package.json` engine settings. The generated project config pins the stack
default at Node 24. A consumer can override `node_version` in its consumer
manifest or `nodejs_version` in `.ddev/config.local.yaml`, then run
`ddev restart`.

## npm workspaces

Run npm from the consumer root so npm sees the root `package.json` and
`package-lock.json`. The runtime does not assume one package or a framework
layout. A common monorepo can look like:

```text
apps/
  web/
  api/
packages/
  types/
  ui/
package.json
package-lock.json
```

For example, use `npm run dev --workspace=@example/web` as a process command.
Add package-specific `node_modules` or generated directories to
`volume_paths` in the consumer manifest when those paths have high I/O.

## Processes and ports

Edit `.ddev/ioweb-typescript.json`. Bootstrap writes an empty `processes` list
because applications choose their own processes and commands. Each daemon
contains a name, command, and optional project-relative working directory.
To expose an HTTP service, add all three DDEV routing ports:

```json
{
  "name": "web",
  "command": "npm run dev --workspace=@example/web -- --hostname 0.0.0.0",
  "directory": "apps/web",
  "container_port": 3000,
  "http_port": 80,
  "https_port": 443
}
```

For another service, choose distinct router ports, for example HTTP 8099 and
HTTPS 8499 for an API listening on container port 4000. A background worker
needs only `name` and `command`. Network services must bind to `0.0.0.0` inside
the container. After editing the manifest, render and restart:

```powershell
node .\docker\typescript\src\cli.js render-runtime --project-root .
ddev restart
```

The generated `.ddev/config.ioweb-typescript-runtime.yaml` uses DDEV's
`web_extra_daemons` and `web_extra_exposed_ports` mechanisms. DDEV exposes
services on the project hostname and selected router ports.

## Healthchecks

Consumers declare liveness or readiness endpoints in the `healthchecks` list
of `.ddev/ioweb-typescript.json`:

```json
{ "name": "web-ready", "process": "web", "path": "/ready" }
```

The default expected response is HTTP 200. Set `expected_statuses` or `port`
when the application contract needs a different status or an internal port.
The stack supplies a generic probe:

```powershell
ddev exec node docker/typescript/src/cli.js check-health --project-root /var/www/html
docker-bootstrap --doctor
```

Doctor runs configured probes from the web container. With no declared health
endpoints, it reports that application readiness has not been configured.
The stack does not assign meaning to `/health` or `/ready`.

## Persistent data and filesystem performance

The default consumer manifest treats `data` as persistent application data and
puts common high-churn root paths (`node_modules`, `.next`, `dist`, `build`,
`coverage`, `.cache`, `.turbo`, and `.vite`) in Docker-managed volumes. Add
consumer paths to `persistent_paths` or `volume_paths`; do not store generated
files in source control.

The umbrella defaults to `performance_mode: mutagen` and adds DDEV
`upload_dirs` and Mutagen exclusions for those paths. Set
`IOWEB_DDEV_PERFORMANCE_MODE=global` or `none` in the consumer's ignored
`docker/.env.local` to change the DDEV-managed mode, then rerun bootstrap and
restart DDEV.
DDEV owns synchronization, while the generated Compose fragment mounts Docker
volumes over dependency, cache, build, and persistent-data directories. This
keeps routine Node filesystem activity in the Linux container filesystem and
source edits on the Windows checkout. After changing local Mutagen overrides,
use DDEV's `ddev mutagen reset` and restart.

## Environment variables

DDEV injects application variables from `.ddev/.env.web` (team-shared,
non-secret defaults) and `.ddev/.env.web.local` (local secrets, ignored by
DDEV). DDEV 1.25.4+ ignores `.local` files by default. Applications can also
continue using their own framework dotenv files. The stack does not reserve
application variable names or pass a fixed allowlist; any DDEV web environment
variable can be used.

Production Compose optionally reads consumer-owned `.env.production` from the
consumer project root; point `APP_ENV_FILE` elsewhere to change it. This
passes arbitrary application variables into the container. Keep secrets in the
deployment secret manager or an ignored environment file, never in this
repository or a committed Compose override.

## Production Docker

DDEV and Mutagen are development-only. Build and run using the Dockerfile and
Compose foundation from the application root:

```powershell
$env:NODE_VERSION = '24'
$env:APP_CONTAINER_PORT = '3000'
$env:APP_HOST_PORT = '3000'
$env:APP_HEALTHCHECK_URL = 'http://127.0.0.1:3000/ready'
docker compose --project-directory . -f .\docker\typescript\compose.production.yaml up --build
```

The Dockerfile uses a Node 24 build stage, runs `npm ci` at the root (including
npm workspaces), executes the consumer's optional build script, prunes
development dependencies, and copies into a non-root Node runtime image. It
contains no DDEV or Mutagen tooling. Its Dockerfile-specific
`Dockerfile.dockerignore` keeps generated and local-secret files out of the
build context. Override `APP_COMMAND`, ports, health URL,
and persistent mounts for the application. Add extra Compose services or
replicas in a consumer-owned production Compose overlay; this base does not
install databases, Redis, queues, or other stateful services.

## Extension and troubleshooting

- Add application processes, ports, health endpoints, persistent paths, and
  runtime volumes in `.ddev/ioweb-typescript.json`.
- Add stateful services only in a consumer-owned DDEV/production overlay or by
  using the Commons adapter when the consumer needs allocated shared services.
- `ddev describe` shows service URLs and port routing; `ddev logs -s web`
  shows daemon startup errors.
- Check that each daemon command runs in the configured directory and binds to
  `0.0.0.0`; test it manually with `ddev ssh` before enabling auto-start.
- Run `node docker/typescript/src/cli.js validate --project-root .` to validate
  the process manifest and `render-runtime` after editing it.
- If Node dependencies or generated files are unexpectedly synced, check
  `volume_paths`, then reset the DDEV Mutagen session and restart.
- If the production image cannot install dependencies, verify the consumer
  committed the root `package-lock.json` and Docker build context includes all
  workspace package manifests and sources.

## Reference links

- [DDEV generic project configuration](https://docs.ddev.com/en/stable/users/configuration/config/)
- [DDEV daemons and exposed ports](https://docs.ddev.com/en/stable/users/extend/customization-extendibility/)
- [DDEV filesystem performance and upload directories](https://docs.ddev.com/en/stable/users/install/performance/)
- [DDEV environment variables and local secrets](https://docs.ddev.com/en/stable/users/configuration/environment-variables/)
