from __future__ import annotations

import os
from dataclasses import dataclass


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if not value:
        return default
    return int(value)


def _ingest_url() -> str:
    value = os.getenv("PINDECK_INGEST_URL") or os.getenv("CONVEX_SITE_URL")
    if not value:
        return "https://convex-site.serving.cloud/ingestExternal"
    value = value.rstrip("/")
    if value.endswith("/ingestExternal"):
        return value
    return f"{value}/ingestExternal"


@dataclass(frozen=True)
class Settings:
    database_path: str = os.getenv("DATABASE_PATH", "/data/pinterest-ingest.sqlite")
    cookies_path: str = os.getenv("PINTEREST_COOKIES_PATH", "/secrets/pinterest-cookies.txt")
    pindeck_ingest_url: str = _ingest_url()
    pindeck_ingest_api_key: str = os.getenv("PINDECK_INGEST_API_KEY") or os.getenv("INGEST_API_KEY", "")
    pindeck_user_id: str = os.getenv("PINDECK_USER_ID", "")
    public_base_url: str = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
    poll_interval_minutes: int = _int_env("POLL_INTERVAL_MINUTES", 0)
    gallery_dl_timeout_seconds: int = _int_env("GALLERY_DL_TIMEOUT_SECONDS", 180)
    gallery_dl_sleep_request: str = os.getenv("GALLERY_DL_SLEEP_REQUEST", "2.0-4.0")
    gallery_dl_range: str = os.getenv("GALLERY_DL_RANGE", "")
    auto_sync_pindeck: bool = _bool_env("AUTO_SYNC_PINDECK", False)
