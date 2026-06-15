import importlib
import sys

from fastapi.testclient import TestClient


def load_app(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "pinterest.sqlite"))
    monkeypatch.setenv("PINTEREST_COOKIES_PATH", str(tmp_path / "cookies.txt"))
    monkeypatch.setenv("PINDECK_INGEST_URL", "https://convex-site.example/ingestExternal")
    monkeypatch.setenv("PINDECK_INGEST_API_KEY", "test-key")
    monkeypatch.setenv("PINDECK_USER_ID", "user-123")
    monkeypatch.setenv("POLL_INTERVAL_MINUTES", "0")

    for name in list(sys.modules):
        if name == "pinterest_ingest.main" or name.startswith("pinterest_ingest."):
            sys.modules.pop(name)

    module = importlib.import_module("pinterest_ingest.main")
    return module, TestClient(module.app)


def add_source(client):
    response = client.post(
        "/sources",
        json={
            "url": "https://www.pinterest.com/example/reference-board/",
            "name": "Reference Board",
            "tags": ["style"],
        },
    )

    assert response.status_code == 200
    return response.json()


def test_source_run_feed_and_sync_copy_to_pindeck(tmp_path, monkeypatch):
    module, client = load_app(tmp_path, monkeypatch)
    source = add_source(client)

    def fake_extract(source_id, source_url, config):
        assert config.cookies_path == str(tmp_path / "cookies.txt")
        return [
            {
                "external_id": f"pinterest:{source_id}:123",
                "pin_id": "123",
                "title": "Green lighting reference",
                "description": "Strong green color palette",
                "source_url": "https://www.pinterest.com/pin/123/",
                "image_url": "https://i.pinimg.com/originals/aa/bb/ref.jpg",
                "thumbnail_url": "https://i.pinimg.com/236x/aa/bb/ref.jpg",
                "created_at": "2026-06-15T12:00:00Z",
            }
        ]

    class FakePindeck:
        def configured(self):
            return True

        async def ingest(self, sync_source, item):
            assert sync_source["id"] == source["id"]
            assert item["image_url"] == "https://i.pinimg.com/originals/aa/bb/ref.jpg"
            assert item["source_url"] == "https://www.pinterest.com/pin/123/"
            return "image-123"

    monkeypatch.setattr(module, "extract_items", fake_extract)
    monkeypatch.setattr(module, "pindeck", FakePindeck())

    run_response = client.post(f"/runs/{source['id']}")
    assert run_response.status_code == 200
    run = run_response.json()
    assert run["status"] == "succeeded"
    assert run["discovered_count"] == 1
    assert run["new_count"] == 1

    feed_response = client.get(f"/feeds/pinterest/{source['id']}.xml")
    assert feed_response.status_code == 200
    assert "application/rss+xml" in feed_response.headers["content-type"]
    assert "Green lighting reference" in feed_response.text
    assert "https://i.pinimg.com/originals/aa/bb/ref.jpg" in feed_response.text
    assert "pinterest:reference-board:123" in feed_response.text

    sync_response = client.post(f"/sources/{source['id']}/sync-pindeck")
    assert sync_response.status_code == 200
    assert sync_response.json() == {
        "source_id": source["id"],
        "attempted": 1,
        "synced": 1,
        "failed": 0,
        "errors": [],
    }

    second_sync = client.post(f"/sources/{source['id']}/sync-pindeck")
    assert second_sync.status_code == 200
    assert second_sync.json()["attempted"] == 0


def test_extraction_failure_is_visible_on_run_and_source(tmp_path, monkeypatch):
    module, client = load_app(tmp_path, monkeypatch)
    source = add_source(client)

    def broken_extract(source_id, source_url, config):
        raise RuntimeError("Pinterest cookies file not found at /secrets/pinterest-cookies.txt")

    monkeypatch.setattr(module, "extract_items", broken_extract)

    run_response = client.post(f"/runs/{source['id']}")
    assert run_response.status_code == 200
    run = run_response.json()
    assert run["status"] == "failed"
    assert "cookies file not found" in run["error"]

    sources_response = client.get("/sources")
    assert sources_response.status_code == 200
    [updated_source] = sources_response.json()
    assert updated_source["last_status"] == "failed"
    assert "cookies file not found" in updated_source["last_error"]


def test_updating_existing_source_preserves_source_id(tmp_path, monkeypatch):
    _, client = load_app(tmp_path, monkeypatch)
    first = add_source(client)

    response = client.post(
        "/sources",
        json={
            "url": "https://www.pinterest.com/example/reference-board/",
            "name": "Renamed Board",
            "tags": ["renamed"],
        },
    )

    assert response.status_code == 200
    updated = response.json()
    assert updated["id"] == first["id"]
    assert updated["name"] == "Renamed Board"
    assert updated["tags"] == ["renamed"]
