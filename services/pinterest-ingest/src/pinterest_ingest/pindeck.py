from __future__ import annotations

import httpx


class PindeckClient:
    def __init__(self, ingest_url: str, api_key: str, user_id: str):
        self.ingest_url = ingest_url
        self.api_key = api_key
        self.user_id = user_id

    def configured(self) -> bool:
        return bool(self.ingest_url and self.api_key and self.user_id)

    async def ingest(self, source: dict, item: dict) -> str:
        if not self.configured():
            raise RuntimeError(
                "Pindeck ingest is not configured. Set PINDECK_INGEST_URL, "
                "PINDECK_INGEST_API_KEY or INGEST_API_KEY, and PINDECK_USER_ID."
            )

        tags = ["pinterest", source["id"], *source.get("tags", [])]
        payload = {
            "userId": self.user_id,
            "imageUrl": item["image_url"],
            "sourceType": "pinterest",
            "source": "Pinterest",
            "sourceUrl": item["source_url"],
            "externalId": item["external_id"],
            "title": item.get("title") or "Pinterest reference",
            "description": item.get("description"),
            "tags": sorted({tag for tag in tags if tag}),
            "category": "General",
        }

        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                self.ingest_url,
                json=payload,
                headers={"Authorization": f"Bearer {self.api_key}"},
            )

        if response.status_code == 400 and "already exists" in response.text.lower():
            return "duplicate"
        if not response.is_success:
            raise RuntimeError(f"Pindeck ingest failed: {response.status_code} {response.text}")

        body = response.json()
        image_id = body.get("imageId")
        if not image_id:
            raise RuntimeError(f"Pindeck ingest returned no imageId: {body}")
        return str(image_id)
