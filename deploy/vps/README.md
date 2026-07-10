# Deploying Eden to a VPS

This is the supported production topology for self-hosted Eden today: **one Linux VPS runs
everything** — the Eden dashboard, Postgres, every deployed agent instance, and their sandbox
containers. That co-residency is by design (the `local-docker` deploy target addresses agent
instances over loopback), so don't split these across machines; scale the box instead.

```
                        ┌─────────────────────────── your VPS ───────────────────────────┐
 https://eden.example.com                                                                 │
   │                    │  nginx (container, TLS via Let's Encrypt)                       │
   ├── /e/… ────────────┼──► splitter :8787 ──► agent instance containers (127.0.0.1:*)   │
   └── everything else ─┼──► Eden :3000 ─────► Docker socket (builds images, runs agents) │
                        │                └────► Postgres :5442 (control plane + worlds)   │
                        └─────────────────────────────────────────────────────────────────┘
```

No installer script — the steps below *are* the deployment: an ordered sequence meant to be run
top to bottom exactly as written, whether you follow it yourself or hand it to a coding agent
you've given SSH access to the box. Everything an install needs is in this directory (this
runbook plus the compose, nginx, and env templates). Budget ~1 hour the first time, most of it in
the GitHub App and WorkOS dashboards.

## 0. What you need before starting

- A VPS running **Ubuntu 24.04 LTS** (other systemd distros work; commands below are apt).
  Sizing: **2 vCPU / 4 GB RAM / 40 GB disk minimum** — agent image builds are the peak load,
  and every agent version keeps an image on disk.
- A **domain** (or subdomain) with an **A record** pointing at the VPS, e.g. `eden.example.com`.
  Needed before the TLS step, and by GitHub/WorkOS for callbacks.
- A **WorkOS** account (auth & tenancy) — you'll configure a production environment.
- A **GitHub App** (repo access) — you'll create or reconfigure one to point at your domain.
- An **Anthropic API key** (the authoring assistant) and a model key for deployed agents
  (set later in the product UI, not in the env file).

All commands below assume a sudo-capable user on the VPS.

## 1. Firewall

```bash
sudo apt update && sudo apt install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

> **Docker bypasses ufw.** Docker programs iptables directly, so a container port published as
> `-p 5442:5432` is reachable from the internet *no matter what ufw says*. The compose file in
> this directory avoids that by publishing Postgres only on `127.0.0.1` and `172.17.0.1`
> (the docker bridge), and agent instances are already loopback-only. If you ever edit port
> mappings, keep explicit bind addresses.

## 2. Install Docker Engine

Follow [Docker's apt instructions](https://docs.docker.com/engine/install/ubuntu/), or condensed:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" |
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER   # then log out and back in
docker run --rm hello-world     # verify
```

## 3. Clone Eden

```bash
mkdir -p ~/apps
git clone https://github.com/<your-fork-or-org>/eden.git ~/apps/eden
cd ~/apps/eden
```

## 4. Configure the environment

```bash
cp deploy/vps/env.example deploy/vps/.env
```

Fill in every value (`deploy/vps/.env` is gitignored). Notes per section:

- **Postgres** — invent a strong `EDEN_PG_PASSWORD` and write the same password into
  `DATABASE_URL` (env-file values are literal; no variable expansion).
- **`EDEN_SECRETS_KEY`** — `openssl rand -hex 32`. This encrypts every secret your users store
  in Eden; **back it up** somewhere that isn't this VPS.
- **WorkOS** — in the [WorkOS dashboard](https://dashboard.workos.com), use a *production*
  environment: copy the API key and client ID, generate a cookie password
  (`openssl rand -base64 32`), and register the redirect URI
  `https://eden.example.com/callback` under *Redirects*.
- **GitHub App** — create one at *Settings → Developer settings → GitHub Apps* (or repoint an
  existing one):
  - **Webhook URL**: `https://eden.example.com/api/github/webhook`, with a
    **webhook secret** you generate (`openssl rand -hex 20`) and copy into the env file.
  - **Setup URL**: `https://eden.example.com/connect` (check "Redirect on update").
  - **Permissions**: Contents (R/W), Pull requests (R/W), Administration (R/W — repo creation),
    Metadata (R).
  - **Events**: Push, Pull request.
  - Generate a **private key** (PEM) and a **client secret**; copy the App ID, slug, client ID,
    client secret, and key into the env file. The PEM can be pasted as one line with `\n`
    escapes.
- **Discord app (optional)** — for the one-click Discord channel (issue #32), register **one**
  Discord application for this installation at
  [discord.com/developers/applications](https://discord.com/developers/applications):
  - **OAuth2 → Redirects**: add `https://eden.example.com/discord/callback`.
  - The **Interactions Endpoint URL** needs no portal setup: Eden sets it to
    `https://eden.example.com/api/discord/interactions` via Discord's API the first time a user
    runs Connect Discord (and re-asserts it on every connect, so a portal edit heals itself).
  - Copy the **Application ID** → `EDEN_DISCORD_APPLICATION_ID`, the **Public Key** →
    `EDEN_DISCORD_PUBLIC_KEY`, and a **Bot** token → `EDEN_DISCORD_BOT_TOKEN`. The bot token
    stays on the control plane and is never shipped to agent instances. Users then connect
    servers from each agent's Deployment tab — nothing else to configure per agent.

## 5. Build and start the stack

The compose file is gitignored so you can tweak it — start from the tracked template (same
copy-and-tweak pattern as `env.example` above):

```bash
cd ~/apps/eden
cp deploy/vps/docker-compose.example.yml deploy/vps/docker-compose.yml
docker compose -f deploy/vps/docker-compose.yml up -d --build eden  # brings up postgres too
docker compose -f deploy/vps/docker-compose.yml run --rm --build migrate  # apply DB schema
docker compose -f deploy/vps/docker-compose.yml logs -f eden        # watch it boot
```

(This starts Postgres and Eden but not nginx — nginx needs a TLS cert first, which step 6
sets up.)

Eden now serves plain HTTP on port `3000`. Because it uses host networking, it binds all
interfaces (`0.0.0.0:3000`), not just loopback — so it's the **firewall** (step 1, which never
opens 3000) that keeps it off the internet, not the bind address. nginx terminates TLS and
proxies to it locally. Verify from the VPS:

```bash
curl -sI http://127.0.0.1:3000 | head -1   # expect HTTP/1.1 200 or a 30x to /login
```

## 6. Nginx + TLS (both containerized)

nginx and certbot run as containers in this same compose stack (the `nginx` service and the
`certbot` tool service) — nothing TLS-related is installed on the host. nginx terminates TLS and
proxies `/e/…` (agent channel traffic) to the splitter on `:8787` and everything else to Eden on
`:3000`, with buffering off — Eden streams (assistant, playground), and buffered SSE looks like a
hang.

Point the site config at your domain:

```bash
cd ~/apps/eden
sed -i 's/eden.example.com/<your-domain>/g' deploy/vps/nginx-eden.conf
```

The config has a TLS server block, so nginx won't start until a certificate exists — a
chicken-and-egg. Break it with a throwaway self-signed cert, boot nginx, then replace it with the
real one over the ACME **webroot** (the same method the renewal cron uses):

```bash
CO="docker compose -f deploy/vps/docker-compose.yml"

# 1. Placeholder cert (1-day self-signed) so nginx can boot.
$CO run --rm --entrypoint sh certbot -c '
  mkdir -p /etc/letsencrypt/live/<your-domain> &&
  openssl req -x509 -newkey rsa:2048 -days 1 -nodes -subj "/CN=<your-domain>" \
    -keyout /etc/letsencrypt/live/<your-domain>/privkey.pem \
    -out    /etc/letsencrypt/live/<your-domain>/fullchain.pem'

# 2. Start nginx (serves :80 ACME challenges + :443 with the placeholder).
$CO up -d nginx

# 3. Drop the placeholder, obtain the real cert via the webroot, then reload nginx.
#    (nginx keeps serving the old cert from open handles until the reload.)
$CO run --rm --entrypoint sh certbot -c '
  rm -rf /etc/letsencrypt/live/<your-domain> \
         /etc/letsencrypt/archive/<your-domain> \
         /etc/letsencrypt/renewal/<your-domain>.conf'
$CO run --rm certbot certonly --webroot -w /var/www/certbot -d <your-domain> \
  --agree-tos -m you@example.com --no-eff-email
docker exec eden-nginx nginx -s reload
```

Confirm TLS from anywhere:

```bash
curl -sI https://<your-domain> | head -1   # expect HTTP/2 200 (or a 30x to /login)
```

**Renewal** is a weekly host cron entry — certbot's own systemd timer isn't in play here since
it's containerized. Add it with `crontab -e`:

```
17 3 * * 1 cd ~/apps/eden/deploy/vps && docker compose run --rm certbot renew --quiet && docker exec eden-nginx nginx -s reload
```

## 7. First login & smoke test

1. Open `https://<your-domain>` — you should land on the WorkOS sign-in.
2. Sign in / sign up (creates your workspace).
3. In **Settings**, set the workspace **model key** — this is what deployed agents use to call
   models; without it, deploys come up but every turn fails.
4. **Connect** a repo (the GitHub App install flow should round-trip through your domain and
   land back on `/connect`).
5. Create or open an agent, **Ship** it, and talk to it in the **Playground**. The first ship
   builds a full agent image (several minutes). The deploy itself is usually seconds — but an
   agent with skills or a sandbox `bootstrap()` prewarms its sandbox template on first boot
   (pulls `ghcr.io/vercel/eve`, runs bootstrap, snapshots an `eve-sbx-tpl-*` image), which can
   add several more minutes the first time. Eden waits up to 10 minutes before calling a
   deploy failed; later deploys and wakes reuse the cached template and are fast.

If Ship fails at the build step, `docker compose … logs eden` has the real error. A deploy-step
failure includes the agent container's own log tail in the UI's failure detail (a broken
sandbox `bootstrap()` shows up there).

## 8. Operations

**Updating Eden**

```bash
cd ~/apps/eden && git pull
docker compose -f deploy/vps/docker-compose.yml up -d --build
docker compose -f deploy/vps/docker-compose.yml run --rm --build migrate
```

The `--build` on the `migrate` step is **not** optional. The `migrate` service is behind the
`tools` profile, so the preceding `up -d --build` does *not* rebuild its image — without `--build`
here, `run --rm migrate` executes whatever image a *previous* deploy built, which is missing any
migration files added since. drizzle-kit then finds nothing new and prints `migrations applied
successfully!` while the new migration is silently skipped.

Verify the migration actually landed — the row count in `drizzle.__drizzle_migrations` should match
the number of entries in `drizzle/meta/_journal.json`:

```bash
docker exec eden-postgres psql -U eden eden -tAc \
  'select count(*) from drizzle.__drizzle_migrations'                 # DB rows
grep -c '"idx"' drizzle/meta/_journal.json                            # journal entries
```

Agent instances keep running through an Eden update (they're independent containers); an
update never rebuilds or restarts them.

**Backups** — two things matter: Postgres (all control-plane + agent session state) and
`EDEN_SECRETS_KEY` (without it, a restored DB's secrets are unreadable).

```bash
# e.g. in cron, daily:
docker exec eden-postgres pg_dump -U eden eden | gzip > /var/backups/eden-$(date +%F).sql.gz
```

**Disk** — agent builds accumulate images. Reclaim space with a *filtered* prune:

```bash
docker image prune -f          # dangling layers only — safe
```

Do **not** run `docker system prune -a` or `docker volume prune`: agent version images (reused
for instant rollback), `eve-sbx-tpl-*` sandbox template images (a RUNNING instance whose
template is pruned loses its bash tools until the instance restarts and re-prewarms), and
`eden-home-*` volumes (each agent's persistent `/workspace/home`) all look "unused" to Docker
whenever the agent isn't running, and pruning them destroys rollbacks and agent state.

**Logs** — `docker compose … logs eden` for the control plane; agent containers are named
`eden-inst-<deploymentId>` (`docker logs <name>`) and sandbox containers carry the
`eve.sandbox=1` label.

## Security notes

- Eden's container mounts the **Docker socket** — that is root-equivalent on this host. It's
  what lets Eden build and run agent containers (and lets agents get real Docker sandboxes),
  and it's the standard trade-off of the single-box topology. Don't co-host unrelated services.
- Agent sandbox containers run with the images and network policy eve requests; they are for
  the agents' *own* code and shell use. Treat the whole box as the trust boundary.
- Postgres is reachable only from the host and the docker bridge (see the firewall note);
  the only public ports are 22/80/443.

## Known limitations (deliberate, for now)

- **Single host only.** The control plane, instances, and worlds must co-reside — the deploy
  target stores loopback instance URLs. Multi-host (and Cloudflare/Vercel targets) live behind
  the same `DeployTarget` seam, later.
- **No horizontal scaling of Eden itself** — in-process job worker, splitter, and caches assume
  one process. One box, one Eden.
- Run-ingest from agents deployed *elsewhere* (BYO instances posting back to
  `/api/ingest/runs`) needs your public URL configured on that side; nothing on the VPS blocks it.
