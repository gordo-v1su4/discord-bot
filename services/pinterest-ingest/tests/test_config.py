import importlib
import sys


def reload_config(monkeypatch):
    for name in list(sys.modules):
        if name == "pinterest_ingest.config":
            sys.modules.pop(name)
    return importlib.import_module("pinterest_ingest.config")


def test_shared_discord_worker_env_is_accepted(monkeypatch):
    monkeypatch.setenv("PINDECK_INGEST_URL", "https://convex-site.example")
    monkeypatch.delenv("PINDECK_INGEST_API_KEY", raising=False)
    monkeypatch.setenv("INGEST_API_KEY", "shared-key")

    config = reload_config(monkeypatch)
    settings = config.Settings()

    assert settings.pindeck_ingest_url == "https://convex-site.example/ingestExternal"
    assert settings.pindeck_ingest_api_key == "shared-key"
