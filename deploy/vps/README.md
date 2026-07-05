# Deploying Eden to a VPS

This is the supported production topology for self-hosted Eden today: **one Linux VPS runs
everything** — the Eden dashboard, Postgres, every deployed agent instance, and their sandbox
containers. That co-residency is by design (the `local-docker` deploy target addresses agent
instances over loopback), so don't split these across machines; scale the box instead.

```
                        ┌─────────────────────────── your VPS ───────────────────────────┐
 https://eden.example.com                                                                 │
   │                    │  nginx (host, TLS via Let's Encrypt)                            │
   ├── /e/… ────────────┼──► splitter :8787 ──► agent instance containers (127.0.0.1:*)   │
   └── everything else ─┼──► Eden :3000 ─────► Docker socket (builds images, runs agents) │
                        │                └────► Postgres :5442 (control plane + worlds)   │
                        └─────────────────────────────────────────────────────────────────┘
```

No installer script — the steps below are the deployment. Budget ~1 hour the first time,
most of it in the GitHub App and WorkOS dashboards.

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
sudo mkdir -p /opt/eden && sudo chown $USER /opt/eden
git clone https://github.com/<your-fork-or-org>/eden.git /opt/eden
cd /opt/eden
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

## 5. Build and start the stack

```bash
cd /opt/eden
docker compose -f deploy/vps/docker-compose.yml up -d --build
docker compose -f deploy/vps/docker-compose.yml run --rm migrate   # apply DB schema
docker compose -f deploy/vps/docker-compose.yml logs -f eden       # watch it boot
```

Eden now serves plain HTTP on `127.0.0.1:3000` (host networking) — not publicly reachable
until nginx fronts it. Verify from the VPS:

```bash
curl -sI http://127.0.0.1:3000 | head -1   # expect HTTP/1.1 200 or a 30x to /login
```

## 6. Nginx + Let's Encrypt

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/vps/nginx-eden.conf /etc/nginx/sites-available/eden
sudo sed -i 's/eden.example.com/<your-domain>/g' /etc/nginx/sites-available/eden
sudo ln -s /etc/nginx/sites-available/eden /etc/nginx/sites-enabled/eden
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d <your-domain>        # obtains the cert, rewrites the site for TLS
```

Certbot installs a systemd timer for renewal; `sudo certbot renew --dry-run` verifies it.

The site config proxies `/e/…` (agent channel traffic) to the splitter on `:8787` and
everything else to Eden on `:3000`, with buffering off — Eden streams (assistant, playground),
and buffered SSE looks like a hang.

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
cd /opt/eden && git pull
docker compose -f deploy/vps/docker-compose.yml up -d --build
docker compose -f deploy/vps/docker-compose.yml run --rm migrate
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
