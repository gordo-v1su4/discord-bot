# Pindeck Pinterest Ingest

Hostinger sidecar service that uses `gallery-dl` to read Pinterest boards or
profiles, exposes an RSS feed for FreshRSS, and forwards new still images into
Pindeck's moderated Pinterest queue. This service is deployed from the
standalone `discord-bot` repo as a sibling Docker Compose service beside the
Discord worker and media gateway.

The sidecar does not become a second image store. It keeps source metadata,
dedupe state, and RSS entries in SQLite. When syncing to Pindeck, it sends a
direct media URL to `/ingestExternal`; Pindeck downloads that file, persists it
to RustFS, creates the image record, extracts colors, and keeps the original
Pinterest URL as source metadata.

## Environment

| Name | Required | Description |
| --- | --- | --- |
| `PINDECK_INGEST_URL` | yes for sync | Pindeck HTTP action URL, usually `https://convex-site.serving.cloud/ingestExternal`. |
| `PINDECK_INGEST_API_KEY` or `INGEST_API_KEY` | yes for sync | Bearer token matching Convex ingest auth. `INGEST_API_KEY` lets this service share the Discord worker `.env`. |
| `PINDECK_USER_ID` | yes for sync | Pindeck owner id for imported images. |
| `PINTEREST_COOKIES_PATH` | no | Cookie file path. Defaults to `/secrets/pinterest-cookies.txt`. |
| `POLL_INTERVAL_MINUTES` | no | Background poll interval. `0` disables polling. Defaults to `0`. |
| `PUBLIC_BASE_URL` | no | External URL used in generated RSS links. |
| `DATABASE_PATH` | no | SQLite path. Defaults to `/data/pinterest-ingest.sqlite`. |
| `GALLERY_DL_TIMEOUT_SECONDS` | no | Extraction timeout. Defaults to `180`. |
| `GALLERY_DL_SLEEP_REQUEST` | no | Delay between gallery-dl HTTP requests. Defaults to `2.0-4.0`. |
| `GALLERY_DL_RANGE` | no | Optional gallery-dl range for smoke tests or capped runs, e.g. `1`. Defaults to full extraction. |
| `AUTO_SYNC_PINDECK` | no | Set `1` to sync after each successful run. Defaults to off. |

## Docker

From the `discord-bot` repo:

```bash
docker compose build pinterest-ingest
docker compose up -d pinterest-ingest
```

Or build the service directly:

```bash
docker build -t pindeck-pinterest-ingest services/pinterest-ingest
docker run --rm -p 8080:8080 \
  -v /docker/pinterest-ingest/data:/data \
  -v /docker/pinterest-ingest/secrets:/secrets:ro \
  -e PINDECK_INGEST_URL=https://convex-site.serving.cloud/ingestExternal \
  -e PINDECK_INGEST_API_KEY="$INGEST_API_KEY" \
  -e PINDECK_USER_ID="$PINDECK_USER_ID" \
  pindeck-pinterest-ingest
```

Place exported browser cookies at `/docker/pinterest-ingest/secrets/pinterest-cookies.txt`.

## API

```bash
uv run uvicorn --app-dir src pinterest_ingest.main:app --host 127.0.0.1 --port 8080

curl http://localhost:8080/health

curl -X POST http://localhost:8080/sources \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.pinterest.com/profile/board/","name":"reference-board"}'

curl -X POST http://localhost:8080/runs/reference-board
curl http://localhost:8080/feeds/pinterest/reference-board.xml
curl -X POST http://localhost:8080/sources/reference-board/sync-pindeck
```

## Failure behavior

No silent fallbacks are used. Missing cookies, gallery-dl failures, extraction
format changes, missing media URLs, and Pindeck ingest failures are recorded on
the run or item so the failure is visible in `/sources`, `/runs/{runId}`, and
logs.
