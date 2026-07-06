# Eden assistant (bundled template)

Eden's built-in, project-level authoring assistant, defined as an eve project. This is the
FIXED, Eden-owned layer bundled into the control-plane image and built into a shared
`eden-assistant:<hash>` Docker image. Do NOT deploy or edit this as a
user repo — the per-project user layer (instructions / skills / schedules / model) is
materialized at container boot by `entrypoint.sh` + `bootstrap.mjs` from the project's published
`.eden/assistant/**` config. The `VERSION`/content hash is the release identity.
