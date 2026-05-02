# Pindeck Discord Bot

Same as `pindeck/services/discord-bot` – standalone deploy. Gateway-based bot using `discord.js`. `/images` commands, ingest, queue moderation.

This repo now also hosts the `sharp`-based media gateway used for new Pindeck image processing. Run both services together via `docker compose` on the bot machine.

## How it works

- **Gateway**: Long-lived connection to Discord. Registers `/images` and handles interactions, reactions, etc.
- **Commands**: `/images menu`, `/images send`, `/images panel`, `/images import`, `/images review`, `/images approve`, `/images reject`, `/images generate`
- **Ingest**: Emoji reaction triggers import to Pindeck. Links Convex ingest, queue, moderation endpoints.

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
| `MEDIA_GATEWAY_TOKEN` | For media gateway | Shared bearer token used by Pindeck backend |
| `NEXTCLOUD_URL` | For media gateway | Base Nextcloud URL, e.g. `https://cloud.v1su4.dev` |
| `NEXTCLOUD_USERNAME` | For media gateway | WebDAV/Nextcloud username |
| `NEXTCLOUD_PASSWORD` | For media gateway | WebDAV/Nextcloud app password |
| `NEXTCLOUD_BASE_FOLDER` | No | Storage root, default `/pindeck/media-uploads` |
| `NEXTCLOUD_PUBLIC_BASE_URL` | No | Public host for browser URLs, defaults to `NEXTCLOUD_URL` |
| `NEXTCLOUD_PUBLIC_SHARE_TOKEN` | Preferred | Shared public folder token for deterministic asset URLs |
| `NEXTCLOUD_PUBLIC_SHARE_PATH` | Preferred | Shared folder root, default `pindeck/media-uploads` |

The media gateway also accepts the existing Pindeck/Convex variable names as aliases:
`NEXTCLOUD_WEBDAV_BASE_URL`, `NEXTCLOUD_WEBDAV_USER`, `NEXTCLOUD_WEBDAV_APP_PASSWORD`, and `NEXTCLOUD_UPLOAD_PREFIX`.

## Install and run

```bash
bun install
bun start
```

From pindeck monorepo root you’d run `bun run discord:bot`; here you run `bun start` from this repo.

## Media gateway

The media gateway exposes:

- `GET /health`
- `POST /process-image`

`POST /process-image` accepts one image upload and stores:

- original
- `320x180`
- `640x360`
- `1280x720`
- `1920x1080`

All non-original variants are generated with `sharp` using a `16:9` cover crop plus black-bar trim before upload to Nextcloud.

Run both services together:

```bash
docker compose up -d --build
```

The media gateway listens on port `4545` by default.

## Bot invite

- Scopes: `bot`, `applications.commands`
- Permissions: View Channels, Send Messages, Embed Links, Read Message History, Add Reactions, Use Application Commands

## Hostinger deploy

1. On the VPS: clone this repo (e.g. `/root/discord-bot`), add `.env` with required vars (file is gitignored).
2. In GitHub: **Actions** secrets — `HOSTINGER_HOST`, `HOSTINGER_USER`, `HOSTINGER_SSH_KEY` (required); `HOSTINGER_APP_PATH` optional if not `/root/discord-bot`.
3. Push to `main` → workflow SSHs in, resets the clone to `origin/main`, runs `docker compose build` and `docker compose up -d` (bot + media gateway on `4545`).

Legacy single-container runs used the name `discord-bot-pinterest`; stop or remove that container if you still have it so it does not fight `docker compose` for the same Discord token.

## Docker

Preferred: use Compose (bot health on **8080**, media gateway on **4545**):

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
