# Deployment: CanvasSync + Knowdex on Azure for Students

Both frontends run on Vercel. Both backends run on one small Azure setup paid
for by the Azure for Students offer: two VMs and one managed Postgres server,
shared by the two apps the same way the old GCP setup was.

This document explains the architecture, why it looks like this, exactly how
it was built, what it costs, and how to operate it.

---

## 1. Architecture

```
                         Vercel                         Vercel
                    canvassync.tech                    knowdex.me
                          │                                 │
                          ▼ HTTPS / WSS                     ▼
   api.canvassync.tech  ws.canvassync.tech   api.knowdex.me  ws.knowdex.me
                          │  (all four A records → 20.198.86.229)
┌─────────────────────────▼──────────────────────────────────────────────┐
│ App VM  canvas-app   B2ats v2 (x86, 2 vCPU, 1 GB)   public 20.198.86.229│
│                                                     private 10.0.1.4    │
│  Caddy :80/:443  (automatic Let's Encrypt HTTPS for all four hosts)     │
│   ├─ /opt/canvas   (compose project "canvas", default network)          │
│   │    http-backend :3001 · ws-backend :8081 · ai-worker                │
│   └─ /opt/knowdex  (compose project "knowdex", joined via `edge` net)   │
│        knowdex-http :8000 · knowdex-ws :8080                            │
└──────────────┬──────────────────────────────────┬──────────────────────┘
   private VNet│ 6379 (Redis) · 5672 (RabbitMQ)   │ 5432 (TLS)
┌──────────────▼───────────────────────┐ ┌────────▼──────────────────────┐
│ Data VM  canvas-data                 │ │ Azure Postgres Flexible Server │
│ B2pts v2 (ARM, 2 vCPU, 1 GB)         │ │ canvas-pg-b97ffc  B1ms, 32 GB  │
│ private 10.0.1.5 · no public IP      │ │ private access only            │
│ Redis (password) · RabbitMQ          │ │ canvas_db · knowdex_db         │
└──────────────────────────────────────┘ └───────────────────────────────┘
```

### What is shared and how it stays separate

| Shared thing | CanvasSync uses | Knowdex uses | Isolation |
|---|---|---|---|
| Postgres server | `canvas_db` | `knowdex_db` | separate databases, separate Prisma migration tables |
| Redis | keys `canvas:*`, room/presence/chat pub/sub | `crdt:updates:*` pub/sub only | ioredis `keyPrefix` + distinct channel names |
| RabbitMQ | AI generation queue | — | only CanvasSync connects |
| Caddy | `api.` / `ws.canvassync.tech` | `api.` / `ws.knowdex.me` | host-based routing |

### Request routing (Caddyfile)

- `api.<domain>`: WebSocket upgrade requests → ws backend, everything else → http backend.
- `ws.<domain>`: always the ws backend.
- The AI worker never takes public traffic. It consumes jobs from RabbitMQ and
  posts results to `http://http-backend:3001` on its own Docker network.

### Files

| Repo | File | Purpose |
|---|---|---|
| CanvasSync | `docker-compose.prod.yml` | App VM: caddy, http-backend, ws-backend, ai-worker |
| CanvasSync | `docker-compose.data.yml` | Data VM: redis, rabbitmq |
| CanvasSync | `Caddyfile` | HTTPS + routing for both apps |
| CanvasSync | `scripts/azure-vm-setup.sh` | one-time VM bootstrap (Docker, 2 GB swap, dirs, `edge` network) |
| CanvasSync | `.github/workflows/deploy.yml` | CI → build → deploy data VM → deploy app VM → Vercel |
| Knowdex | `docker-compose.prod.yml` | App VM: knowdex-http, knowdex-ws (no published ports) |
| Knowdex | `.github/workflows/deploy.yml` | CI → build → deploy app VM → Vercel |

---

## 2. Why this setup

Constraints: no credit card, a student account, both apps need long-lived
WebSockets, and CanvasSync needs a background worker plus RabbitMQ.

| Option looked at | Outcome |
|---|---|
| Oracle Always Free | Best free tier, but needs a credit card |
| Heroku student credit | Needs a credit card (debit card rejected) |
| Render / Koyeb / HF Spaces | Sleep on idle, single process, or tiny memory; WebSockets and the worker don't fit well |
| Vercel/Netlify functions | No persistent WebSockets or workers |
| **Azure for Students** | **No card, ₹9,555 credit + 12 months of free services → chosen** |

Inside Azure, only resources on the subscription's **Free services** list are
used, so the credit is barely touched:

- Linux VMs: 750 h/month **each** of B2ats v2 and B2pts v2 → two VMs 24/7
- Managed disks: 2 × 64 GB P6 SSD
- PostgreSQL Flexible Server: 750 h/month of B1ms + 32 GB storage + 32 GB backup

Why two VMs and not three: the AI worker only needs ~160 MB and mostly waits
on Gemini, so it runs on the App VM. Redis and RabbitMQ get their own VM so an
app spike can't starve them. Everything uses ~330 MB on the App VM and
~150 MB on the Data VM at idle, plus 2 GB swap on each.

---

## 3. How it was built

Everything was created with the Azure CLI (`az`) in region **Central India**
(the student subscription only allows `centralindia`, `southeastasia`,
`eastasia`, `uaenorth`, `austriaeast`).

### 3.1 One-time Azure resources

```bash
az login                                    # Amity student account
ssh-keygen -t ed25519 -f ~/.ssh/canvas_azure -N ""

az group create -n canvas-rg -l centralindia

# Network. The VM subnet keeps default outbound access so the private
# data VM can pull images (otherwise a paid NAT gateway would be needed).
az network vnet create -g canvas-rg -n canvas-vnet --address-prefix 10.0.0.0/16 \
  --subnet-name vms --subnet-prefix 10.0.1.0/24
az network vnet subnet update -g canvas-rg --vnet-name canvas-vnet -n vms \
  --default-outbound-access true
az network vnet subnet create -g canvas-rg --vnet-name canvas-vnet -n postgres \
  --address-prefixes 10.0.2.0/24 --delegations Microsoft.DBforPostgreSQL/flexibleServers

# Firewall for the App VM: 22, 80, 443 (+ UDP 443 for HTTP/3)
az network nsg create -g canvas-rg -n canvas-app-nsg
az network nsg rule create -g canvas-rg --nsg-name canvas-app-nsg -n allow-ssh-http-https \
  --priority 100 --access Allow --protocol Tcp --direction Inbound --destination-port-ranges 22 80 443

# App VM (x86, public static IP)
az vm create -g canvas-rg -n canvas-app --image Canonical:ubuntu-24_04-lts:server:latest \
  --size Standard_B2ats_v2 --admin-username azureuser --ssh-key-values ~/.ssh/canvas_azure.pub \
  --vnet-name canvas-vnet --subnet vms --private-ip-address 10.0.1.4 \
  --public-ip-sku Standard --public-ip-address-allocation static --nsg canvas-app-nsg \
  --os-disk-size-gb 64 --storage-sku Premium_LRS

# Data VM (ARM, no public IP, no NSG → reachable only inside the VNet)
az vm create -g canvas-rg -n canvas-data --image Canonical:ubuntu-24_04-lts:server-arm64:latest \
  --size Standard_B2pts_v2 --admin-username azureuser --ssh-key-values ~/.ssh/canvas_azure.pub \
  --vnet-name canvas-vnet --subnet vms --private-ip-address 10.0.1.5 \
  --public-ip-address "" --nsg "" --os-disk-size-gb 64 --storage-sku Premium_LRS

# Postgres (private access needs a private DNS zone created up front)
az network private-dns zone create -g canvas-rg -n canvasdb.private.postgres.database.azure.com
az network private-dns link vnet create -g canvas-rg -z canvasdb.private.postgres.database.azure.com \
  -n canvas-vnet-link -v canvas-vnet -e false
az postgres flexible-server create -g canvas-rg -n canvas-pg-b97ffc -l centralindia \
  --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 \
  --admin-user canvasadmin --admin-password '<PG_PASS>' --zonal-resiliency Disabled \
  --backup-retention 7 --vnet canvas-vnet --subnet postgres \
  --private-dns-zone <zone resource id> --yes
```

Generated passwords (Postgres, Redis, RabbitMQ) live in `~/.canvas-azure.env`
on the laptop; the SSH key is `~/.ssh/canvas_azure`. Keep both.

### 3.2 VM bootstrap and databases

```bash
ssh-add ~/.ssh/canvas_azure
ssh azureuser@20.198.86.229 'bash -s' < scripts/azure-vm-setup.sh
ssh -J azureuser@20.198.86.229 azureuser@10.0.1.5 'bash -s' < scripts/azure-vm-setup.sh

# on the App VM
docker run --rm postgres:16-alpine psql \
  "postgresql://canvasadmin:<PG_PASS>@canvas-pg-b97ffc.postgres.database.azure.com:5432/postgres?sslmode=require" \
  -c "CREATE DATABASE canvas_db;" -c "CREATE DATABASE knowdex_db;"
```

### 3.3 DNS

At each registrar, four A records → `20.198.86.229`:

- canvassync.tech (get.tech / orderbox-dns): `api`, `ws`
- knowdex.me (Namecheap): `api`, `ws`

Root and `www` records still point to Vercel. Caddy fetched Let's Encrypt
certificates for all four hosts on its first start.

### 3.4 GitHub secrets and variables

Set with `gh secret set` / `gh variable set`.

| Name | Kind | CanvasSync | Knowdex |
|---|---|---|---|
| `APP_VM_IP` | variable | ✓ | ✓ |
| `DATA_VM_PRIVATE_IP` | variable | ✓ | ✓ |
| `API_HEALTH_URL` | variable | `https://api.canvassync.tech/health` | `https://api.knowdex.me/health` |
| `VM_USER`, `VM_SSH_KEY` | secret | ✓ | ✓ |
| `REDIS_PASS` | secret | ✓ (same value) | ✓ (same value) |
| `DATABASE_URL` | secret | `…/canvas_db?sslmode=require` | `…/knowdex_db?sslmode=require` |
| `RABBITMQ_USER`, `RABBITMQ_PASS` | secret | ✓ | — |
| `GOOGLE_CLIENT_ID/SECRET` | secret | own OAuth client | own OAuth client |
| `JWT_SECRET`, `GEMINI_API_KEY`, `GH_CLIENT_*`, `VERCEL_DEPLOY_HOOK`, … | secret | unchanged from GCP | unchanged from GCP |

Google OAuth clients now live in the Google Cloud project `oauth-apps-509719`
(no billing needed). The old ones were deleted along with the GCP project.

### 3.5 CI/CD

Every push to `main` deploys automatically (`workflow_dispatch` also works).

**CanvasSync:** CI (typecheck, lint, test, build) → build and push the three
images to GHCR → Data VM `docker compose -f docker-compose.data.yml up -d`
(a no-op when nothing changed) → App VM: write `.env`, pull, run
`prisma migrate deploy`, `up -d`, reload Caddy → wait for `/health` → Vercel
deploy hook.

**Knowdex:** CI → build and push two images → App VM: write `.env`, pull,
`up -d` (the http image applies migrations on start) → wait for `/health` →
Vercel deploy hook.

The Data VM has no public IP, so GitHub Actions reaches it through the App VM
as an SSH jump host (`proxy_host` in the appleboy actions).

---

## 4. Cost

Credit and free services both expire **10 Nov 2026** (Education hub →
"Days until credit expires"). You can never be charged real money: there is no
card on the account. When the credit runs out or expires, the subscription is
disabled.

### Monthly cost until 10 Nov 2026

| Resource | Used by | Free allowance | Your cost / month |
|---|---|---|---|
| App VM B2ats v2 | both apps | 750 h | ₹0 |
| Data VM B2pts v2 | both apps | 750 h | ₹0 |
| 2 × 64 GB P6 OS disks | both VMs | 2 × P6 | ₹0 |
| Postgres B1ms + 32 GB + backups | both apps | 750 h + 32 GB | ₹0 |
| VNet, subnets, NSG | — | always free | ₹0 |
| Outbound data | both apps | 100 GB | ₹0 at portfolio traffic |
| Static public IPv4 (Standard) | App VM | not on the list | ~₹320 (from credit) |
| Private DNS zone | Postgres | not on the list | ~₹45 (from credit) |
| **Total** | | | **~₹365 / month, paid from the ₹9,555 credit** |

About ₹550 of credit will be used before expiry. Check real usage in
Cost Management → Cost analysis.

### Per app

The infrastructure is shared, so neither app has a separate bill. As a rough
split by resource use:

| | CanvasSync | Knowdex |
|---|---|---|
| App VM share | http + ws + ai-worker (~230 MB) | http + ws (~90 MB) |
| Data VM | Redis (heavy use) + RabbitMQ | Redis pub/sub only |
| Postgres | `canvas_db` | `knowdex_db` |
| Share of ~₹365/month | ~₹250 | ~₹115 |
| External services | Gemini API (free tier), Gmail SMTP | Gemini API (free tier) |
| Frontend | Vercel Hobby (free) | Vercel Hobby (free) |

### What it would cost without the free services

At pay-as-you-go list prices this setup is roughly ₹3,000–3,500/month (two
VMs ~₹1,100, two Premium disks ~₹1,700, Postgres ~₹1,400, IP + DNS ~₹365).
That's why the plan relies on staying inside the free list.

---

## 5. Operating it

```bash
source ~/.canvas-azure.env
ssh -i ~/.ssh/canvas_azure azureuser@$APP_VM_IP

docker ps                                             # all containers
docker logs -f canvas-http-backend-1                  # CanvasSync API
docker logs -f knowdex-knowdex-http-1                 # Knowdex API
docker logs canvas-caddy-1 | grep -i error            # HTTPS / routing
free -m                                               # memory + swap

# Data VM (via jump host)
ssh -J azureuser@$APP_VM_IP azureuser@10.0.1.5 'docker ps'
```

- **Redeploy without a code change:** GitHub → Actions → Deploy → Run workflow.
- **Roll back:** images are also tagged `sha-<commit>`. Change `:latest` to
  that tag in the compose file on the VM and run `docker compose up -d`.
- **VM memory:** each container has a `mem_limit`. If something is OOM-killed,
  raise its limit or resize the App VM (credit covers a B1ms 2 GB for a while).

### Before 10 Nov 2026

1. Early November: portal → **Education** → **Renew** (you're still a student
   until May 2027, so this should work).
2. Back up both databases regardless:
   ```bash
   ssh azureuser@$APP_VM_IP
   docker run --rm postgres:16-alpine pg_dump -Fc "<canvas_db url>"  > canvas_db.dump
   docker run --rm postgres:16-alpine pg_dump -Fc "<knowdex_db url>" > knowdex_db.dump
   exit
   scp azureuser@$APP_VM_IP:~/*.dump .
   ```
3. If renewal fails, move the same compose files to any Docker host and
   restore with `pg_restore --no-owner -d "<new url>" <file>.dump`.

---

## 6. Problems hit during setup (and fixes)

| Symptom | Cause | Fix |
|---|---|---|
| First VM create: "Subscription not found" | `Microsoft.Compute` / `DBforPostgreSQL` providers not yet registered on a fresh subscription | `az provider register`, wait, retry |
| Postgres create rejected zone name | private access needs a pre-created private DNS zone | create zone + VNet link, pass its resource id |
| Data VM deploy: `DATABASE_URL is required` | compose checks required vars for every service in the file | split Redis/RabbitMQ into `docker-compose.data.yml` |
| Google login: `Error 401: deleted_client` | OAuth clients lived in the deleted GCP project | new project `oauth-apps-509719`, one client per app |
| Site can't reach `api.canvassync.tech` from one network | that network's DNS still caches the old GCP IP (up to the old TTL) | wait, or use 1.1.1.1 / 8.8.8.8 as DNS |
