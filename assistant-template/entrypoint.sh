#!/bin/sh
# Assistant instance boot (docs/ASSISTANT.md §4). Materialize the published user config layer,
# then — only if a user layer exists — recompile with `eve build` (eve discovers
# instructions/skills/schedules at build time), then hand off to `eve start` (which also prewarms
# the sandbox template). A missing/empty user layer takes the fast path: the fixed layer is
# already compiled into this image, so we boot straight into `eve start`.
set -e

node bootstrap.mjs || true

# Per-project model override (bundle assistant.json) takes precedence over the deploy-env default.
if [ -f .eden-assistant-env ]; then
  . ./.eden-assistant-env
  export EDEN_ASSISTANT_MODEL
fi

if [ -f .eden-user-layer ]; then
  echo "[assistant] recompiling with the user config layer…"
  node_modules/.bin/eve build
fi

exec node_modules/.bin/eve start
