from __future__ import annotations

import asyncio
import hashlib
import re
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Response

from .config import Settings
from .db import Store
from .extractor import GalleryDlConfig, extract_items, gallery_dl_version
from .models import RunRecord, SourceCreate, SourceRecord, SyncResult
from .pindeck import PindeckClient
from .rss import render_feed


settings = Settings()
store = Store(settings.database_path)
pindeck = PindeckClient(
    settings.pindeck_ingest_url,
    settings.pindeck_ingest_api_key,
    settings.pindeck_user_id,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task: asyncio.Task | None = None
    if settings.poll_interval_minutes > 0:
        task = asyncio.create_task(poll_loop())
    try:
        yield
    finally:
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


app = FastAPI(title="Pindeck Pinterest Ingest", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    version = gallery_dl_version()
    return {
        "ok": True,
        "galleryDlVersion": version,
        "databasePath": settings.database_path,
        "cookiesPath": settings.cookies_path,
        "pindeckConfigured": pindeck.configured(),
        "pollIntervalMinutes": settings.poll_interval_minutes,
        "autoSyncPindeck": settings.auto_sync_pindeck,
    }


@app.get("/sources", response_model=list[SourceRecord])
def list_sources() -> list[dict[str, Any]]:
    return store.list_sources()


@app.post("/sources", response_model=SourceRecord)
def create_source(source: SourceCreate) -> dict[str, Any]:
    name = source.name or source.url.host or "pinterest"
    source_id = unique_source_id(slugify(name), str(source.url))
    return store.upsert_source(
        source_id=source_id,
        name=name,
        url=str(source.url),
        tags=source.tags,
        active=source.active,
    )


@app.post("/runs/{source_id}", response_model=RunRecord)
async def run_source(source_id: str) -> dict[str, Any]:
    return await run_source_extraction(source_id)


@app.get("/runs/{run_id}", response_model=RunRecord)
def get_run(run_id: str) -> dict[str, Any]:
    run = store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@app.get("/feeds/pinterest/{source_id}.xml")
def feed(source_id: str) -> Response:
    source = require_source(source_id)
    items = store.list_items(source_id, limit=100)
    return Response(
        render_feed(source, items, settings.public_base_url),
        media_type="application/rss+xml; charset=utf-8",
    )


@app.post("/sources/{source_id}/sync-pindeck", response_model=SyncResult)
async def sync_source_to_pindeck(source_id: str) -> dict[str, Any]:
    source = require_source(source_id)
    return await sync_unsent(source)


async def poll_loop() -> None:
    while True:
        for source in store.list_sources():
            if not source["active"]:
                continue
            try:
                await run_source_extraction(source["id"])
            except Exception as error:
                print(f"Poll failed for {source['id']}: {error}", flush=True)
        await asyncio.sleep(settings.poll_interval_minutes * 60)


async def run_source_extraction(source_id: str) -> dict[str, Any]:
    source = require_source(source_id)
    run_id = str(uuid.uuid4())
    store.start_run(run_id, source_id)
    try:
        records = await asyncio.to_thread(
            extract_items,
            source_id,
            source["url"],
            GalleryDlConfig(
                cookies_path=settings.cookies_path,
                timeout_seconds=settings.gallery_dl_timeout_seconds,
                sleep_request=settings.gallery_dl_sleep_request,
                item_range=settings.gallery_dl_range,
            ),
        )
        discovered, created = store.upsert_items(source_id, records)
        synced = 0
        if settings.auto_sync_pindeck:
            sync = await sync_unsent(source)
            synced = sync["synced"]
        return store.finish_run(
            run_id,
            source_id,
            "succeeded",
            discovered_count=discovered,
            new_count=created,
            synced_count=synced,
        )
    except Exception as error:
        return store.finish_run(
            run_id,
            source_id,
            "failed",
            discovered_count=0,
            new_count=0,
            error=str(error),
        )


async def sync_unsent(source: dict[str, Any]) -> dict[str, Any]:
    items = store.unsent_items(source["id"], limit=50)
    errors: list[str] = []
    synced = 0

    for item in items:
        try:
            image_id = await pindeck.ingest(source, item)
            store.mark_item_synced(item["external_id"], image_id)
            synced += 1
        except Exception as error:
            message = f"{item['external_id']}: {error}"
            store.mark_item_sync_failed(item["external_id"], str(error))
            errors.append(message)

    return {
        "source_id": source["id"],
        "attempted": len(items),
        "synced": synced,
        "failed": len(errors),
        "errors": errors,
    }


def require_source(source_id: str) -> dict[str, Any]:
    source = store.get_source_by_id(source_id)
    if not source:
        raise HTTPException(status_code=404, detail="Source not found")
    return source


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or f"source-{uuid.uuid4().hex[:8]}"


def unique_source_id(base_id: str, url: str) -> str:
    existing = store.get_source_by_id(base_id)
    if not existing or existing["url"] == url:
        return base_id
    suffix = hashlib.sha256(url.encode("utf-8")).hexdigest()[:8]
    return f"{base_id}-{suffix}"
