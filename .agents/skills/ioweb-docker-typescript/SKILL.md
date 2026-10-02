# IOWEB Docker TypeScript stack

Use this stack as a project-neutral Node.js and TypeScript runtime for consumer
projects. The consumer owns application frameworks, commands, routes, health
semantics, and environment variables. The stack owns DDEV/Docker runtime
plumbing, Node version defaults, Mutagen exclusions, and generated high-I/O
volumes.

Consumer lifecycle commands run from the consumer project root. Do not start
shared Compose files from this submodule. Use `docker-bootstrap` to install or
refresh this stack as `docker/typescript`.

The consumer process manifest is `.ddev/ioweb-typescript.json`. It is consumer
owned; render operations preserve it. Generated DDEV config and Compose files
are managed and can be refreshed with:

```powershell
node .\docker\typescript\src\cli.js render-runtime --project-root .
```

Use DDEV-managed Mutagen; do not create a separate Mutagen lifecycle. Keep app
secrets in `.ddev/.env.web.local` or the consumer's established secret store.
Do not commit secrets, application code, domains, or project data to this
stack repository.
