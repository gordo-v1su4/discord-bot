from __future__ import annotations

from email.utils import format_datetime
from html import escape
from datetime import UTC, datetime
from xml.etree.ElementTree import Element, SubElement, tostring


def rss_datetime(value: str | None) -> str:
    if not value:
        return format_datetime(datetime.now(UTC), usegmt=True)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return format_datetime(parsed.astimezone(UTC), usegmt=True)
    except ValueError:
        return format_datetime(datetime.now(UTC), usegmt=True)


def render_feed(source: dict, items: list[dict], public_base_url: str = "") -> str:
    rss = Element("rss", {"version": "2.0"})
    rss.set("xmlns:media", "http://search.yahoo.com/mrss/")
    channel = SubElement(rss, "channel")
    SubElement(channel, "title").text = f"Pindeck Pinterest - {source['name']}"
    SubElement(channel, "link").text = source["url"]
    SubElement(channel, "description").text = f"Pinterest references for {source['name']}"
    SubElement(channel, "lastBuildDate").text = rss_datetime(source.get("last_run_at"))

    for item in items:
        entry = SubElement(channel, "item")
        title = item.get("title") or "Pinterest reference"
        SubElement(entry, "title").text = title
        SubElement(entry, "link").text = item["source_url"]
        SubElement(entry, "guid", {"isPermaLink": "false"}).text = item["external_id"]
        SubElement(entry, "pubDate").text = rss_datetime(item.get("created_at") or item.get("first_seen_at"))
        description = item.get("description") or title
        image_html = f'<p><img src="{escape(item["image_url"])}" alt="{escape(title)}" /></p>'
        SubElement(entry, "description").text = f"{image_html}<p>{escape(description)}</p>"
        SubElement(entry, "{http://search.yahoo.com/mrss/}content", {
            "url": item["image_url"],
            "medium": "image",
        })
        if public_base_url:
            SubElement(entry, "comments").text = f"{public_base_url}/sources/{source['id']}/sync-pindeck"

    return '<?xml version="1.0" encoding="UTF-8"?>\n' + tostring(rss, encoding="unicode")
