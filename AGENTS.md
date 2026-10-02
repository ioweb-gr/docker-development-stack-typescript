# TypeScript Docker stack instructions

Keep this repository project-neutral. Consumer domains, credentials, source
code, environment values, process commands, and application health semantics
belong in the consumer checkout.

Work directly on `master` and push stack commits to `origin/master` before
updating the umbrella submodule pointer. Do not create a local Compose or
Mutagen lifecycle for DDEV development; use DDEV's generic project, managed
Mutagen support, and generated runtime fragments.

Validate changes with `npm test`. Production Docker must not depend on DDEV or
Mutagen. The standalone stack CLI is the source of consumer process and volume
runtime fragments; keep generated files marked and preserve the consumer
manifest.
