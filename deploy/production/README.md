# Maintainer production deployment

> **This is maintainer infrastructure for the canonical hosted Eden instance.** It is not a
> requirement or replacement for the supported OSS self-host setup. Self-hosters should use the
> [single-VPS Docker Compose runbook](../vps/README.md), which does not require Swarm, GHCR, or
> access to Eden's deployment secrets.

The root [`docker-stack.production.yml`](../../docker-stack.production.yml) and
[`deploy.yml`](../../.github/workflows/deploy.yml) implement continuous deployment for
`zero8ai/eden`. A push to `main` (or a manual workflow dispatch) runs the same typecheck and tests as
CI, builds immutable runtime and migration images, pushes them to GHCR, applies migrations, and
updates the `eden` Swarm stack on the maintained VPS. The deploy job is guarded by the canonical
repository name and uses secrets scoped to GitHub's `production` Environment, so forks cannot deploy
to this host.

## Production topology

Swarm manages only the services that the deployment workflow replaces:

- `eden`: one replica on the manager, attached to Docker's predefined host network and mounting the
  Docker socket. Host networking is required because deployed agent instance URLs use loopback.
- `postgres`: one replica on the manager with its data bind-mounted from
  `/opt/eden/volumes/postgres`. It also uses the host network and listens only on
  `127.0.0.1:5442` and `172.17.0.1:5442`.

nginx and certbot remain ordinary Docker Compose containers from `deploy/vps`. Keeping them outside
Swarm preserves the existing certificate volumes, ACME webroot flow, and renewal cron. nginx
continues to reach Eden and the traffic splitter at `127.0.0.1:3000` and `127.0.0.1:8787`.

Swarm cannot safely publish a service port to selected host IP addresses: stack deployment ignores
the IP portion and publishes it on every interface. Postgres therefore joins the host network and
binds the two required addresses itself. Do not replace that with a Swarm `ports` entry; Docker's
iptables rules can expose the database even when ufw appears to block it.

Eden is intentionally single-process and owns fixed host ports, so its update policy uses one
replica with `order: stop-first`. Expect a short control-plane interruption during each rollout.
Health-check failure triggers Swarm rollback to the previous service specification, but there cannot
be a start-first, zero-downtime handoff until Eden supports multiple control-plane replicas.

## One-time host provisioning

These steps assume Docker Engine and the Compose plugin are already installed using the
[self-host runbook](../vps/README.md), and that nginx/TLS is working. Run them as the SSH user the
workflow will use.

1. Give the deploy user access to the Docker daemon, then log out and back in so the new group takes
   effect:

   ```bash
   sudo usermod -aG docker "$USER"
   docker version
   ```

2. Initialize the single-node Swarm if the host is not already a manager:

   ```bash
   docker info --format '{{.Swarm.LocalNodeState}}'
   docker swarm init
   docker node ls
   ```

3. Create the server-side deployment directory. The workflow writes the stack file here, so the
   deploy user must own it.

   ```bash
   sudo install -d -m 0750 -o "$USER" -g "$(id -gn)" /opt/eden
   sudo install -d -m 0750 -o "$USER" -g "$(id -gn)" /opt/eden/volumes
   sudo install -d -m 0700 -o "$USER" -g "$(id -gn)" /opt/eden/volumes/postgres
   ```

4. Copy the maintained instance's existing environment file to the path consumed by the stack.
   Keep the file on the host and out of git.

   ```bash
   sudo install -m 0600 -o "$USER" -g "$(id -gn)" \
     ~/apps/eden/deploy/vps/.env /opt/eden/production.env
   ```

   It uses the same variables documented in [`deploy/vps/env.example`](../vps/env.example),
   including `EDEN_PG_PASSWORD` and a `DATABASE_URL` that points to
   `postgres://eden:<password>@localhost:5442/eden`. Back up `EDEN_SECRETS_KEY` separately; a
   database restore is not useful without it.

## GitHub production Environment

Create an Environment named exactly `production` under **Repository settings → Environments** and
add these Environment secrets:

| Secret             | Value                                                      |
| ------------------ | ---------------------------------------------------------- |
| `PROD_VPS_HOST`    | DNS name or IP address of the maintained VPS               |
| `PROD_VPS_USER`    | SSH user provisioned above                                 |
| `PROD_VPS_SSH_KEY` | Private key for that user, including its header and footer |

The corresponding public key must be in the user's `~/.ssh/authorized_keys`. GHCR authentication
uses the workflow's built-in `GITHUB_TOKEN`; do not create a long-lived package token or put registry
credentials in `production.env`.

Environment protection rules are optional, but any required reviewer turns automatic `main`
deployments into approval-gated deployments. The repository-name guard remains in force for both
push and manual runs.

## One-time Compose-to-Swarm cutover

The maintained instance already has live Postgres data in a Compose-managed mount. Preserve that
data and the old mount until the Swarm deployment has been verified. The commands below deliberately
discover the real source from the container instead of guessing Compose's volume name.

1. From the existing checkout, inspect the Postgres data mount and record its source:

   ```bash
   cd ~/apps/eden
   docker inspect eden-postgres --format \
     '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{printf "%s\t%s\n" .Type .Source}}{{end}}{{end}}'

   POSTGRES_SOURCE="$(docker inspect eden-postgres --format \
     '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}')"
   test -n "$POSTGRES_SOURCE"
   ```

2. Stop only the old Eden and Postgres containers. Leave nginx running in front of them; it will
   return an error during the cutover and reconnect to the same loopback ports when Swarm starts
   Eden.

   ```bash
   docker compose -f deploy/vps/docker-compose.yml stop eden postgres
   ```

3. Confirm the destination is empty, then copy every file, including dotfiles, while preserving
   ownership and modes:

   ```bash
   test -z "$(sudo find /opt/eden/volumes/postgres -mindepth 1 -print -quit)"
   sudo cp -a "$POSTGRES_SOURCE"/. /opt/eden/volumes/postgres/
   sudo chown --reference="$POSTGRES_SOURCE" /opt/eden/volumes/postgres
   sudo chmod --reference="$POSTGRES_SOURCE" /opt/eden/volumes/postgres
   sudo du -sh "$POSTGRES_SOURCE" /opt/eden/volumes/postgres
   ```

   If the emptiness check fails, stop and inspect the directory before copying. Do not merge two
   Postgres data directories.

4. Do **not** run `docker compose down -v`, remove the source volume, or restart the Compose `eden`
   and `postgres` services. Keeping the source intact gives the operator a recovery copy; the old
   services must remain stopped because they would contend for the same host ports and database.

5. Run **Deploy production** from the Actions tab with the `main` branch, or let the next push to
   `main` trigger it. The workflow copies the stack definition to `/opt/eden`, runs the migration
   image against Postgres, deploys the stack, and waits for the services to converge on the new
   image before succeeding.

The existing certbot renewal command remains valid. The old Compose project still owns nginx,
certbot, and their certificate volumes; only its Eden and Postgres services are retired.

## Verification and operations

Inspect service state and recent task history on the host:

```bash
docker stack services eden
docker service ps eden_eden --no-trunc
docker service ps eden_postgres --no-trunc
docker service logs --tail 200 eden_eden
docker service logs --tail 200 eden_postgres
docker logs --tail 200 eden-nginx
```

Confirm Eden is serving nginx locally and Postgres is not listening on a wildcard address:

```bash
curl -sI http://127.0.0.1:3000 | head -1
sudo ss -ltnp | grep ':5442'
```

Port `5442` should appear only on `127.0.0.1` and the Docker bridge address (normally
`172.17.0.1`), never `0.0.0.0` or `[::]`. Finally, use Eden to ship an agent and talk to it in the
Playground. That verifies the host-networked control plane can still reach loopback agent instances
and nginx can still reach the splitter.

Swarm automatically attempts the stack's configured rollback when a new Eden task fails its health
check. To inspect or manually request the retained previous service specification:

```bash
docker service inspect eden_eden --pretty
docker service update --rollback eden_eden
docker service ps eden_eden --no-trunc
```

The deploy transaction applies database migrations before changing Eden. Swarm rolls back the
service specification and image, not an already-applied database migration, so every production
migration must remain compatible with the previous runtime image.

Each deploy retains SHA-tagged images for traceability and rollback. Only perform a filtered dangling
image prune:

```bash
docker image prune -f
```

Never run `docker system prune -a`, `docker image prune -a`, or `docker volume prune`. Old
control-plane and agent-version images, `eve-sbx-tpl-*` sandbox templates, and `eden-home-*` volumes
can all look unused while still being required for rollback or persistent agent state.
