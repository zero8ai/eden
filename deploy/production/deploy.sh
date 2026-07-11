#!/usr/bin/env bash

set -Eeuo pipefail

readonly DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/eden}"
readonly STACK_NAME="${STACK_NAME:-eden}"
readonly DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-120}"
readonly STACK_FILE="${DEPLOY_ROOT}/docker-stack.production.yml"
readonly ENV_FILE="${DEPLOY_ROOT}/production.env"
readonly IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required}"
readonly RUNTIME_IMAGE="ghcr.io/zero8ai/eden:${IMAGE_TAG}"
readonly MIGRATION_IMAGE="${RUNTIME_IMAGE}-migrate"
readonly EDEN_SERVICE="${STACK_NAME}_eden"
readonly POSTGRES_SERVICE="${STACK_NAME}_postgres"

diagnostics_enabled=false

log() {
  printf '[deploy] %s\n' "$*"
}

dump_service_diagnostics() {
  local service="$1"
  local container_id

  docker service inspect "$service" >/dev/null 2>&1 || return 0
  printf '\n[deploy] %s tasks\n' "$service" >&2
  docker service ps --no-trunc "$service" >&2 || true
  printf '\n[deploy] %s service logs (last 100 lines)\n' "$service" >&2
  docker service logs --raw --tail 100 "$service" >&2 || true

  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    printf '\n[deploy] container %s logs (last 100 lines)\n' "$container_id" >&2
    docker logs --tail 100 "$container_id" >&2 || true
  done < <(
    docker ps --all --quiet \
      --filter "label=com.docker.swarm.service.name=${service}" 2>/dev/null || true
  )
}

on_error() {
  local exit_code=$?
  local line_number="${1:-unknown}"
  trap - ERR
  printf '[deploy] failed at line %s (exit %s)\n' "$line_number" "$exit_code" >&2
  if [[ "$diagnostics_enabled" == true ]]; then
    dump_service_diagnostics "$EDEN_SERVICE"
    dump_service_diagnostics "$POSTGRES_SERVICE"
  fi
  exit "$exit_code"
}
trap 'on_error "$LINENO"' ERR

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '[deploy] required command not found: %s\n' "$1" >&2
    return 1
  }
}

validate_inputs() {
  require_command docker
  require_command curl

  [[ "$DEPLOY_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || {
    printf '[deploy] DEPLOY_TIMEOUT must be a positive integer\n' >&2
    return 1
  }
  [[ "$IMAGE_TAG" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || {
    printf '[deploy] IMAGE_TAG is not a valid container tag\n' >&2
    return 1
  }
  [[ -r "$STACK_FILE" ]] || {
    printf '[deploy] stack file is missing or unreadable: %s\n' "$STACK_FILE" >&2
    return 1
  }
  [[ -r "$ENV_FILE" ]] || {
    printf '[deploy] environment file is missing or unreadable: %s\n' "$ENV_FILE" >&2
    return 1
  }

  local swarm_state
  swarm_state="$(docker info --format '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}')"
  [[ "$swarm_state" == "active true" ]] || {
    printf '[deploy] this host must be an active Docker Swarm manager (got: %s)\n' \
      "$swarm_state" >&2
    return 1
  }
}

deploy_stack() {
  local replicas="$1"
  log "deploying stack ${STACK_NAME} with Eden replicas=${replicas}"
  (
    cd "$DEPLOY_ROOT"
    export IMAGE_TAG EDEN_PG_PASSWORD
    export EDEN_REPLICAS="$replicas"
    docker stack deploy \
      --with-registry-auth \
      --resolve-image always \
      --detach=true \
      --compose-file "$STACK_FILE" \
      "$STACK_NAME"
  )
}

service_update_state() {
  docker service inspect \
    --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' "$1"
}

assert_update_not_failed() {
  local service="$1"
  local state
  state="$(service_update_state "$service")"
  case "$state" in
    paused|rollback_started|rollback_paused|rollback_completed)
      printf '[deploy] %s entered failed update state: %s\n' "$service" "$state" >&2
      return 1
      ;;
  esac
}

wait_for_postgres() {
  local deadline=$((SECONDS + DEPLOY_TIMEOUT))
  local desired container_id container_ids health current_state

  log "waiting for ${POSTGRES_SERVICE} to converge and become healthy"
  while ((SECONDS < deadline)); do
    if docker service inspect "$POSTGRES_SERVICE" >/dev/null 2>&1; then
      assert_update_not_failed "$POSTGRES_SERVICE"
      desired="$(docker service inspect \
        --format '{{.Spec.Mode.Replicated.Replicas}}' "$POSTGRES_SERVICE")"
      container_ids="$(docker ps --quiet \
        --filter "label=com.docker.swarm.service.name=${POSTGRES_SERVICE}")"
      container_id="${container_ids%%$'\n'*}"
      if [[ "$desired" == "1" && -n "$container_id" ]]; then
        current_state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
        health="$(docker inspect \
          --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
          "$container_id")"
        if [[ "$current_state" == "running" && "$health" == "healthy" ]]; then
          log "Postgres is healthy"
          return 0
        fi
      fi
    fi
    sleep 2
  done

  printf '[deploy] timed out waiting for %s\n' "$POSTGRES_SERVICE" >&2
  return 1
}

run_migrations() {
  log "running database migrations from ${MIGRATION_IMAGE}"
  docker run --rm \
    --network host \
    --env-file "$ENV_FILE" \
    --entrypoint npx \
    "$MIGRATION_IMAGE" \
    drizzle-kit migrate
}

requested_image_is_running() {
  local spec_image="$1"
  local task_image task_state
  local running_total=0
  local running_requested=0

  while IFS='|' read -r task_image task_state; do
    [[ -n "$task_image" ]] || continue
    if [[ "$task_state" == Running* ]]; then
      running_total=$((running_total + 1))
      if [[ "$task_image" == "$RUNTIME_IMAGE" || "$task_image" == "$RUNTIME_IMAGE@"* ]]; then
        running_requested=$((running_requested + 1))
      fi
    fi
  done < <(
    docker service ps \
      --no-trunc \
      --filter desired-state=running \
      --format '{{.Image}}|{{.CurrentState}}' \
      "$EDEN_SERVICE"
  )

  [[ "$spec_image" == "$RUNTIME_IMAGE" || "$spec_image" == "$RUNTIME_IMAGE@"* ]] &&
    [[ "$running_total" -eq 1 && "$running_requested" -eq 1 ]]
}

wait_for_eden() {
  local deadline=$((SECONDS + DEPLOY_TIMEOUT))
  local desired spec_image update_state

  log "waiting for ${EDEN_SERVICE} to run ${RUNTIME_IMAGE}"
  while ((SECONDS < deadline)); do
    if docker service inspect "$EDEN_SERVICE" >/dev/null 2>&1; then
      assert_update_not_failed "$EDEN_SERVICE"
      desired="$(docker service inspect \
        --format '{{.Spec.Mode.Replicated.Replicas}}' "$EDEN_SERVICE")"
      spec_image="$(docker service inspect \
        --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$EDEN_SERVICE")"
      update_state="$(service_update_state "$EDEN_SERVICE")"

      if [[ "$desired" == "1" ]] &&
        [[ -z "$update_state" || "$update_state" == "completed" ]] &&
        requested_image_is_running "$spec_image"; then
        log "Eden rollout completed"
        return 0
      fi
    fi
    sleep 2
  done

  printf '[deploy] timed out waiting for %s to converge\n' "$EDEN_SERVICE" >&2
  return 1
}

validate_inputs
diagnostics_enabled=true

log "pulling migration image"
docker pull "$MIGRATION_IMAGE"

# Let Docker parse the env file. It is Compose-style input and must never be
# sourced as shell code. The password is captured for stack interpolation and
# is intentionally never written to stdout or command arguments.
EDEN_PG_PASSWORD="$(
  docker run --rm \
    --env-file "$ENV_FILE" \
    --entrypoint node \
    "$MIGRATION_IMAGE" \
    -e 'const required=["EDEN_PG_PASSWORD","DATABASE_URL"]; const missing=required.filter((name)=>!process.env[name]); if (missing.length) { console.error(`missing required environment: ${missing.join(", ")}`); process.exit(1); } process.stdout.write(process.env.EDEN_PG_PASSWORD)'
)"
readonly EDEN_PG_PASSWORD
[[ -n "$EDEN_PG_PASSWORD" ]] || {
  printf '[deploy] EDEN_PG_PASSWORD is missing from %s\n' "$ENV_FILE" >&2
  exit 1
}

if ! docker service inspect "$POSTGRES_SERVICE" >/dev/null 2>&1; then
  log "Postgres service is absent; starting the one-time bootstrap"
  deploy_stack 0
fi

wait_for_postgres
run_migrations
deploy_stack 1
wait_for_eden

log "smoke-checking Eden on localhost:3000"
curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:3000/ >/dev/null

log "removing dangling images older than seven days"
docker image prune --force --filter 'until=168h'
log "deployment completed successfully"
