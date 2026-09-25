# Deploying CanvasSync + Knowdex backends to Azure (Azure for Students)

Both frontends stay on Vercel. Both backends run on the Azure free-services
tier: two 1 GB VMs plus one managed Postgres server. Postgres
and Redis are shared by the two apps (separate databases, separate Redis
key/channel namespaces), like the old GCP setup.

```
                    Internet
                       │  443 (Caddy, auto HTTPS)
          ┌────────────▼─────────────┐
          │ App VM  B2ats v2 (x86)   │  public IP
          │ caddy                    │
          │ canvas http · canvas ws  │
          │ canvas ai-worker         │
          │ knowdex http · knowdex ws│
          └────────────┬─────────────┘
           private VNet│ 6379 / 5672
          ┌────────────▼─────────────┐
          │ Data VM B2pts v2 (ARM)   │  no public IP
          │ redis · rabbitmq         │
          └──────────────────────────┘
     Azure Postgres Flexible B1ms (private access): canvas_db + knowdex_db
```

## 0. Before you start

- Portal → **Free services** blade: confirm B2ats v2, B2pts v2 (750 h each),
  PostgreSQL Flexible Server B1ms and P6 managed disks are listed.
- **Cost Management → Budgets**: create a ₹500 budget with an email alert.
- Pick **one region** that offers B2pts v2 and use it for everything
  (e.g. Central India, East US).
- Generate one SSH key for all VMs and for GitHub Actions:
  ```bash
  ssh-keygen -t ed25519 -f ~/.ssh/canvas_azure -N ""
  ```

## 1. Network

1. Create resource group `canvas-rg`.
2. Create virtual network `canvas-vnet` (`10.0.0.0/16`) with two subnets:
   - `vms` — `10.0.1.0/24`. **Untick "Enable private subnet"** so the private
     VMs keep outbound internet (Docker pulls, Gemini API). Without it you'd
     need a NAT gateway, which is not free.
   - `postgres` — `10.0.2.0/24` (the Postgres wizard delegates it).

## 2. Virtual machines

Both: Ubuntu Server 24.04 LTS, SSH public key auth with
`~/.ssh/canvas_azure.pub`, same username (e.g. `azureuser`), subnet `vms`,
OS disk **Premium SSD, 64 GiB (P6)** — the free tier covers two P6 disks.

| VM | Size | Image arch | Public IP | Inbound ports |
|---|---|---|---|---|
| `canvas-app` | B2ats v2 | x64 | Standard, static | 22, 80, 443 |
| `canvas-data` | B2pts v2 | **Arm64** | None | none (VNet only) |

Note both private IPs (Overview → Networking), e.g. `10.0.1.4` and `10.0.1.5`.

Do not add 6379 or 5672 to any NSG rule; the data VM has no public IP, so only
the VNet can reach Redis and RabbitMQ.

Bootstrap both VMs (Docker, 2 GB swap, `/opt/canvas`, `/opt/knowdex`, `edge`
network):

```bash
ssh-add ~/.ssh/canvas_azure
APP=<app-public-ip>
ssh azureuser@$APP 'bash -s' < scripts/azure-vm-setup.sh
ssh -J azureuser@$APP azureuser@10.0.1.5 'bash -s' < scripts/azure-vm-setup.sh
```

## 3. Postgres

Create **Azure Database for PostgreSQL – Flexible Server**:

- Workload: Development → **Burstable B1ms**, 32 GB storage, PostgreSQL 16
- High availability off, backup retention 7 days
- Authentication: PostgreSQL only; admin `canvasadmin` + strong password
- Networking: **Private access (VNet integration)** → `canvas-vnet` / `postgres`

Create both app databases from the app VM:

```bash
ssh -i ~/.ssh/canvas_azure azureuser@$APP
docker run --rm -it postgres:16-alpine psql \
  "postgresql://canvasadmin:PASS@<server>.postgres.database.azure.com:5432/postgres?sslmode=require" \
  -c "CREATE DATABASE canvas_db;" -c "CREATE DATABASE knowdex_db;"
```

`DATABASE_URL` for each repo:

- CanvasSync: `postgresql://canvasadmin:PASS@<server>.postgres.database.azure.com:5432/canvas_db?sslmode=require`
- Knowdex: `postgresql://canvasadmin:PASS@<server>.postgres.database.azure.com:5432/knowdex_db?sslmode=require`

If you have a dump of an old database, restore it the same way with
`pg_restore --no-owner -d "<url>" backup.dump` from the app VM.

Azure uses a public CA, so no custom cert is needed. Migrations run
automatically on each deploy (`prisma migrate deploy` in the app job).

## 4. DNS

Add A records pointing to the app VM's public IP:

- `api.canvassync.tech`, `ws.canvassync.tech` (DNS for canvassync.tech)
- `api.knowdex.me`, `ws.knowdex.me` (DNS for knowdex.me)

Caddy gets Let's Encrypt certificates automatically on first request.
Keep the Vercel records for the root domains as they are.

## 5. GitHub configuration

Settings → Secrets and variables → Actions.

**Variables:** `APP_VM_IP`, `DATA_VM_PRIVATE_IP`,
`API_HEALTH_URL` (`https://api.canvassync.tech/health`).

**Secrets:** see the list at the top of `.github/workflows/deploy.yml`.
Notes:

- `VM_USER` = `azureuser`, `VM_SSH_KEY` = contents of `~/.ssh/canvas_azure`.
- Generate `REDIS_PASS`, `RABBITMQ_PASS`, `JWT_SECRET`, `INTERNAL_SECRET` with
  `openssl rand -hex 24` (hex needs no URL escaping).
- Delete the old GCP-only secrets: `DB_SSL_CA_CERT`, `RABBITMQ_URL`, and the
  `VM_1_IP` / `VM_2_IP` / `WORKER_VM_IP` variables.
- `NEXT_PUBLIC_WS_URL` can be `wss://api.canvassync.tech` or
  `wss://ws.canvassync.tech`; Caddy routes both to ws-backend.

**Knowdex repo** (secrets list at the top of its `.github/workflows/deploy.yml`):

- Variables: `APP_VM_IP`, `DATA_VM_PRIVATE_IP`,
  `API_HEALTH_URL` (`https://api.knowdex.me/health`).
- Secrets: `VM_USER`, `VM_SSH_KEY`, `REDIS_PASS` (same values as CanvasSync),
  `DATABASE_URL` (knowdex_db), `JWT_SECRET`, `GEMINI_API_KEY`, the Google and
  GitHub OAuth IDs and secrets, `VERCEL_DEPLOY_HOOK`.
- Delete old GCP ones: `VM_1_IP`, `VM_2_IP`, `DB_SSL_CA_CERT`.
- Vercel env for Knowdex: `API_BASE_URL=https://api.knowdex.me`,
  `NEXT_PUBLIC_API_URL=https://api.knowdex.me/api/v1`,
  `NEXT_PUBLIC_WS_URL=wss://ws.knowdex.me` (or `wss://api.knowdex.me`).

OAuth callback URLs don't change as long as the `api.canvassync.tech` and
`api.knowdex.me` hosts are kept.

## 6. Deploy

Deploy **CanvasSync first** (it brings up Redis, RabbitMQ and Caddy), then
Knowdex. Push to `main` or run each repo's Deploy workflow manually.
CanvasSync order: data VM → app VM (migrations, then containers) → Vercel hook. Knowdex: app VM (migrations run on start) → Vercel hook.

Check:

```bash
curl https://api.canvassync.tech/health
curl https://api.knowdex.me/health
ssh -i ~/.ssh/canvas_azure azureuser@$APP 'cd /opt/canvas && docker compose -f docker-compose.prod.yml ps && free -m'
```

## Before the credit expires

Check days remaining in the portal's **Education** hub. When the subscription
is disabled, the VMs and Postgres stop and their data is eventually deleted,
so dump both databases before then:

```bash
ssh azureuser@$APP
docker run --rm postgres:16-alpine pg_dump -Fc "<canvas_db url>"  > canvas_db.dump
docker run --rm postgres:16-alpine pg_dump -Fc "<knowdex_db url>" > knowdex_db.dump
# then copy them to your laptop: scp azureuser@$APP:~/*.dump .
```
