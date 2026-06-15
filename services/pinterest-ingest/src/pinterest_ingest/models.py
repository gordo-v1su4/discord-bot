from __future__ import annotations

from pydantic import BaseModel, Field, HttpUrl


class SourceCreate(BaseModel):
    url: HttpUrl
    name: str | None = None
    tags: list[str] = Field(default_factory=list)
    active: bool = True


class SourceRecord(BaseModel):
    id: str
    name: str
    url: str
    tags: list[str]
    active: bool
    last_run_id: str | None = None
    last_status: str | None = None
    last_error: str | None = None
    last_run_at: str | None = None


class RunRecord(BaseModel):
    id: str
    source_id: str
    status: str
    started_at: str
    finished_at: str | None = None
    discovered_count: int = 0
    new_count: int = 0
    synced_count: int = 0
    error: str | None = None


class SyncResult(BaseModel):
    source_id: str
    attempted: int
    synced: int
    failed: int
    errors: list[str]

