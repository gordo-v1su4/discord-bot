import json

import httpx
import pytest

from pinterest_ingest.pindeck import PindeckClient


@pytest.mark.anyio
async def test_pindeck_client_sends_copy_payload_without_import_batch(monkeypatch):
    captured = {}

    async def handler(request):
        captured["headers"] = dict(request.headers)
        captured["payload"] = json.loads(request.content)
        return httpx.Response(200, json={"imageId": "image-456", "userId": "user-123"})

    original_async_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)

    class TestAsyncClient:
        def __init__(self, *args, **kwargs):
            self.client = original_async_client(transport=transport)

        async def __aenter__(self):
            return self.client

        async def __aexit__(self, exc_type, exc, tb):
            await self.client.aclose()

    monkeypatch.setattr(httpx, "AsyncClient", TestAsyncClient)

    client = PindeckClient(
        "https://convex-site.example/ingestExternal",
        "secret-key",
        "user-123",
    )
    image_id = await client.ingest(
        {"id": "green-board", "tags": ["style", "green"]},
        {
            "external_id": "pinterest:green-board:456",
            "image_url": "https://i.pinimg.com/originals/aa/bb/ref.jpg",
            "source_url": "https://www.pinterest.com/pin/456/",
            "title": "Green board",
            "description": "Original pin provenance is preserved",
        },
    )

    assert image_id == "image-456"
    assert captured["headers"]["authorization"] == "Bearer secret-key"
    assert captured["payload"] == {
        "userId": "user-123",
        "imageUrl": "https://i.pinimg.com/originals/aa/bb/ref.jpg",
        "sourceType": "pinterest",
        "source": "Pinterest",
        "sourceUrl": "https://www.pinterest.com/pin/456/",
        "externalId": "pinterest:green-board:456",
        "title": "Green board",
        "description": "Original pin provenance is preserved",
        "tags": ["green", "green-board", "pinterest", "style"],
        "category": "General",
    }
