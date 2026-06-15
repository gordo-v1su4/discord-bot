# Pindeck Discord Bot

Same as `pindeck/services/discord-bot` – standalone deploy. Gateway-based bot using `discord.js`. `/images` commands, ingest, queue moderation.

This repo historically hosted a media-gateway compatibility proxy, but new Pindeck image processing now talks to the RustFS media API directly.

This repo is also the home for long-running Pindeck ingest workers that live
beside the Discord bot on Hostinger. Docker Compose runs them as sibling
containers in one deployment stack, not as child processes inside one container.

## How it works

- **Gateway**: Long-lived connection to Discord. Registers `/images` and handles interactions, reactions, etc.
- **Commands**: `/images menu`, `/images send`, `/images panel`, `/images import`, `/images review`, `/images approve`, `/images reject`, `/images generate`
- **Ingest**: Emoji reaction triggers import to Pindeck. Links Convex ingest, queue, moderation endpoints.
- **Pinterest ingest**: `services/pinterest-ingest` uses `gallery-dl` to watch
  configured Pinterest boards/profiles, expose RSS feeds, and send new items to
  Pindeck's moderated `/ingestExternal` path.

## Environment

Set these in `.env.local` (or `.env`). Same paths as pindeck: loads `.env.local`, `.env` from cwd, then `../../.env.local`, `../.env.local`, etc., so you can reuse pindeck’s root `.env.local`.

**Convex HTTP base for this deployment:** `https://convex-site.serving.cloud` — use the `PINDECK_*` / `CONVEX_SITE_URL` / `VITE_CONVEX_SITE_URL` values shown in [`.env.example`](.env.example) (or set only `CONVEX_SITE_URL` and let the bot derive ingest, queue, and moderation paths — see `src/index.js`).

| Variable | Required | Description |
|---------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` or `DISCORD_APPLICATION_ID` | Yes | Application ID |
| `DISCORD_GUILD_ID` | No | Recommended for fast slash command updates |
| `DISCORD_IMAGES_JSON` | No | JSON array of image presets (uses samples if omitted) |
| `DISCORD_INGEST_EMOJIS` | No | Emoji triggers for import (e.g. `📌`) |
| `INGEST_API_KEY` | For ingest | Must match Convex |
| `PINDECK_USER_ID` | For ingest | Convex user id for imports |
| `PINDECK_INGEST_URL` / `CONVEX_SITE_URL` | No | Defaults from Convex URL |
| `PINDECK_DISCORD_QUEUE_URL`, `PINDECK_DISCORD_MODERATION_URL` | No | Queue/moderation endpoints |
| `DISCORD_STATUS_WEBHOOK_URL` | No | Optional status webhook |
| `DISCORD_QUEUED_MODERATION_BUTTONS` | No | Post Approve/Deny/Generate buttons when a queued status webhook appears; default `1` |
| `MEDIA_GATEWAY_TOKEN` | For legacy media gateway | Bearer token accepted by the compatibility gateway if you still run it |
| `MEDIA_API_TOKEN` | For legacy media gateway | Bearer token used when forwarding writes to RustFS. Falls back to `MEDIA_GATEWAY_TOKEN` if omitted |
| `RUSTFS_MEDIA_API_URL` / `MEDIA_API_URL` | No | RustFS media API base URL, default `https://media.v1su4.dev` |
| `MEDIA_GATEWAY_BUCKET` | No | RustFS bucket for Pindeck uploads, default `pindeck` |
| `POLL_INTERVAL_MINUTES` | For Pinterest | Poll interval for watched Pinterest sources; `0` disables background polling |
| `PUBLIC_BASE_URL` | For Pinterest RSS | External/base URL used in RSS links; localhost is fine for server-local use |
| `AUTO_SYNC_PINDECK` | For Pinterest | Set `1` to forward new items after each successful run |
| `GALLERY_DL_RANGE` | No | Optional extraction cap for smoke tests, e.g. `1`; leave blank for full runs |

Storage is RustFS-only. Pindeck Convex uses `MEDIA_GATEWAY_URL=https://media.v1su4.dev` and `MEDIA_GATEWAY_TOKEN` for new writes; the bot only needs Convex ingest/queue/moderation access.

## Install and run

```bash
bun install
bun start
```

From pindeck monorepo root you’d run `bun run discord:bot`; here you run `bun start` from this repo.

## Legacy media gateway

The optional compatibility gateway exposes:

- `GET /health`
- `POST /process-image`

`POST /process-image` accepts one image upload and forwards it to the RustFS media API, which stores:

- original
- `320x180`
- `1280x720`
- `1920x1080`
- five sampled palette colors

All durable URLs returned to Pindeck should use the RustFS public shape: `https://s3.v1su4.dev/pindeck/media-uploads/...`.

Run both services together:

```bash
docker compose up -d --build
```

The media gateway listens on port `4545` by default.

## Pinterest ingest sidecar

The Pinterest worker is packaged at
[`services/pinterest-ingest`](services/pinterest-ingest). It is a separate
Python/uv container because `gallery-dl` is the extractor runtime. Compose runs
it beside the Discord bot and media gateway.

The sidecar keeps only operational state in SQLite. Pindeck still owns durable
storage: the sidecar resolves the direct Pinterest media URL, sends it to
`/ingestExternal`, and Pindeck downloads/copies it into RustFS while preserving
the Pinterest source URL.

Hostinger runtime paths:

- Data: `/docker/pinterest-ingest/data/pinterest-ingest.sqlite`
- Cookies: `/docker/pinterest-ingest/secrets/pinterest-cookies.txt`
- Local service URL: `http://127.0.0.1:8095`

Create the runtime folders on the server:

```bash
mkdir -p /docker/pinterest-ingest/data /docker/pinterest-ingest/secrets
chmod 700 /docker/pinterest-ingest/secrets
```

Export browser cookies for Pinterest and place them at:

```bash
/docker/pinterest-ingest/secrets/pinterest-cookies.txt
```

The Compose file binds the service to `127.0.0.1:8095` so admin endpoints are
not public by default. Use SSH or a server-side tool to add sources and run
syncs:

```bash
curl http://127.0.0.1:8095/health

curl -X POST http://127.0.0.1:8095/sources \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.pinterest.com/profile/board/","name":"reference-board"}'

curl -X POST http://127.0.0.1:8095/runs/reference-board
curl http://127.0.0.1:8095/feeds/pinterest/reference-board.xml
curl -X POST http://127.0.0.1:8095/sources/reference-board/sync-pindeck
```

## Bot invite

- Scopes: `bot`, `applications.commands`
- Permissions: View Channels, Send Messages, Embed Links, Read Message History, Add Reactions, Use Application Commands

## Hostinger deploy

1. On the VPS: clone this repo (e.g. `/root/discord-bot`), add `.env` with required vars (file is gitignored).
2. In GitHub: **Actions** secrets — `HOSTINGER_HOST`, `HOSTINGER_USER`, `HOSTINGER_SSH_KEY` (required); `HOSTINGER_APP_PATH` optional if not `/root/discord-bot`.
3. Push to `main` → workflow SSHs in, resets the clone to `origin/main`, runs `docker compose build` and `docker compose up -d` (bot + media gateway on `4545` + Pinterest ingest on server-local `8095`).

Legacy single-container runs used the name `discord-bot-pinterest`; stop or remove that container if you still have it so it does not fight `docker compose` for the same Discord token.

The Hostinger VPS also serves the public Convex HTTP domains. The bot container must resolve `convex-site.serving.cloud` and `convex.serving.cloud` to the Docker host gateway (`172.18.0.1`) instead of `127.0.1.1`; otherwise Bun fetches to `/ingestExternal` fail from inside the container even when host-level `curl` works. The Compose file pins both names with `extra_hosts`.

Current server:

- Hostname: `srv1353991`
- Public IP: `187.77.8.227`
- SSH user: `root`
- App path: `/root/discord-bot`

## Docker

Preferred: use Compose (bot health on **8080**, media gateway on **4545**,
Pinterest ingest on server-local **8095**):

```bash
docker compose up -d --build
```

Ad-hoc single container (bot only):

```bash
docker build -t discord-bot:latest .
docker run -d --restart unless-stopped --name discord-bot -p 8080:8080 --env-file .env discord-bot:latest
```

- **Bot health check**: `GET http://your-server:8080/health` → `{"ok":true,"service":"pindeck-discord-bot"}`.
- **Media gateway**: `GET http://your-server:4545/health` (Compose sets `HEALTH_PORT=4545` for that service).
- **Pinterest ingest**: `GET http://127.0.0.1:8095/health` on the server.
- `discord-bot` runs as the long-lived Discord worker container.
- `pindeck-media-gateway` exposes `GET /health` on port `4545`.
- `pindeck-pinterest-ingest` exposes RSS/source/run endpoints on server-local port `8095`.
- `docker compose ps` is the quickest way to verify both services after a deploy.
