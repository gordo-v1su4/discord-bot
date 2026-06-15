from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MEDIA_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp", ".gif")
URL_RE = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
PIN_ID_RE = re.compile(r"/pin/(\d+)")


@dataclass(frozen=True)
class GalleryDlConfig:
    cookies_path: str
    timeout_seconds: int
    sleep_request: str
    item_range: str = ""


def gallery_dl_version() -> str:
    result = subprocess.run(
        ["gallery-dl", "--version"],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def extract_items(source_id: str, source_url: str, config: GalleryDlConfig) -> list[dict[str, Any]]:
    cookies = Path(config.cookies_path)
    if not cookies.exists():
        raise RuntimeError(f"Pinterest cookies file not found at {config.cookies_path}")

    command = [
        "gallery-dl",
        "--config-ignore",
        "--cookies",
        config.cookies_path,
        "--sleep-request",
        config.sleep_request,
        "--resolve-json",
    ]
    if config.item_range:
        command.extend(["--range", config.item_range])
    command.append(source_url)
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=config.timeout_seconds,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"gallery-dl failed with exit {result.returncode}: {detail}")

    records = parse_gallery_dl_json(source_id, source_url, result.stdout)
    if not records:
        raise RuntimeError("gallery-dl returned no usable Pinterest image records")
    return records


def parse_gallery_dl_json(source_id: str, source_url: str, output: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    payloads: list[dict[str, Any]] = []

    try:
        decoded = json.loads(output)
        payloads.extend(iter_gallery_payloads(decoded))
    except json.JSONDecodeError:
        for line in output.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            payloads.extend(iter_gallery_payloads(payload))

    for payload in payloads:
        record = normalize_payload(source_id, source_url, payload)
        if not record or record["external_id"] in seen:
            continue
        seen.add(record["external_id"])
        records.append(record)

    return records


def iter_gallery_payloads(value: Any) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    if isinstance(value, dict):
        payloads.append(value)
        return payloads
    if isinstance(value, list):
        if len(value) >= 2 and isinstance(value[0], int) and isinstance(value[1], dict):
            payloads.append(value[1])
            return payloads
        for item in value:
            payloads.extend(iter_gallery_payloads(item))
    return payloads


def normalize_payload(source_id: str, source_url: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    page_url = first_string(
        payload,
        ["post_url", "pin_url", "url", "purl", "webpage_url", "permalink", "link"],
    )
    source_page = pinterest_page_url(page_url) or pinterest_page_url(find_any_url(payload)) or source_url
    pin_id = first_string(payload, ["pin_id", "id", "post_id"]) or pin_id_from_url(source_page)
    image_url = choose_media_url(payload)

    if not image_url:
        return None
    if not pin_id:
        pin_id = stable_short_id(source_page or image_url)

    title = first_string(payload, ["title", "name", "headline", "description"])
    description = first_string(payload, ["description", "caption", "text", "alt"])
    created_at = first_string(payload, ["date", "created_at", "timestamp"])

    return {
        "external_id": f"pinterest:{source_id}:{pin_id}",
        "pin_id": pin_id,
        "title": title or "Pinterest reference",
        "description": description,
        "source_url": source_page,
        "image_url": image_url,
        "thumbnail_url": first_string(payload, ["thumbnail", "thumb", "preview"]) or image_url,
        "created_at": str(created_at) if created_at is not None else None,
    }


def choose_media_url(payload: dict[str, Any]) -> str | None:
    for key in ("image_url", "content_url", "media_url", "download_url", "url"):
        value = payload.get(key)
        if isinstance(value, str) and is_media_url(value):
            return value

    urls = collect_urls(payload)
    media_urls = [url for url in urls if is_media_url(url)]
    if not media_urls:
        return None
    return sorted(media_urls, key=media_rank, reverse=True)[0]


def is_media_url(url: str) -> bool:
    clean = url.split("?", 1)[0].lower()
    return clean.endswith(MEDIA_EXTENSIONS) or "pinimg.com" in clean


def media_rank(url: str) -> tuple[int, int]:
    clean = url.lower()
    original_score = 2 if "/originals/" in clean else 0
    return (original_score, len(url))


def collect_urls(value: Any) -> list[str]:
    urls: list[str] = []
    if isinstance(value, str):
        urls.extend(match.group(0) for match in URL_RE.finditer(value))
    elif isinstance(value, dict):
        for nested in value.values():
            urls.extend(collect_urls(nested))
    elif isinstance(value, list):
        for nested in value:
            urls.extend(collect_urls(nested))
    return urls


def first_string(payload: dict[str, Any], keys: list[str]) -> str | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, int):
            return str(value)
    return None


def find_any_url(payload: dict[str, Any]) -> str | None:
    urls = collect_urls(payload)
    return urls[0] if urls else None


def pinterest_page_url(url: str | None) -> str | None:
    if not url:
        return None
    if "pinterest." not in url and "pin.it" not in url:
        return None
    return url


def pin_id_from_url(url: str | None) -> str | None:
    if not url:
        return None
    match = PIN_ID_RE.search(url)
    return match.group(1) if match else None


def stable_short_id(value: str) -> str:
    import hashlib

    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]
