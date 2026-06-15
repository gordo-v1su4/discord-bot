from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class Store:
    def __init__(self, database_path: str):
        self.database_path = database_path
        self._lock = threading.RLock()
        Path(database_path).parent.mkdir(parents=True, exist_ok=True)
        self.init()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = sqlite3.connect(self.database_path)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            try:
                yield conn
                conn.commit()
            finally:
                conn.close()

    def init(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS sources (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  url TEXT NOT NULL UNIQUE,
                  tags_json TEXT NOT NULL DEFAULT '[]',
                  active INTEGER NOT NULL DEFAULT 1,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  last_run_id TEXT,
                  last_status TEXT,
                  last_error TEXT,
                  last_run_at TEXT
                );

                CREATE TABLE IF NOT EXISTS runs (
                  id TEXT PRIMARY KEY,
                  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
                  status TEXT NOT NULL,
                  started_at TEXT NOT NULL,
                  finished_at TEXT,
                  discovered_count INTEGER NOT NULL DEFAULT 0,
                  new_count INTEGER NOT NULL DEFAULT 0,
                  synced_count INTEGER NOT NULL DEFAULT 0,
                  error TEXT
                );

                CREATE TABLE IF NOT EXISTS items (
                  id TEXT PRIMARY KEY,
                  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
                  external_id TEXT NOT NULL UNIQUE,
                  pin_id TEXT NOT NULL,
                  title TEXT,
                  description TEXT,
                  source_url TEXT NOT NULL,
                  image_url TEXT NOT NULL,
                  thumbnail_url TEXT,
                  created_at TEXT,
                  first_seen_at TEXT NOT NULL,
                  last_seen_at TEXT NOT NULL,
                  sent_to_pindeck_at TEXT,
                  pindeck_image_id TEXT,
                  last_pindeck_error TEXT
                );
                """
            )

    def upsert_source(self, source_id: str, name: str, url: str, tags: list[str], active: bool) -> dict[str, Any]:
        timestamp = now_iso()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO sources (id, name, url, tags_json, active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(url) DO UPDATE SET
                  name = excluded.name,
                  tags_json = excluded.tags_json,
                  active = excluded.active,
                  updated_at = excluded.updated_at
                """,
                (source_id, name, url, json.dumps(tags), 1 if active else 0, timestamp, timestamp),
            )
            return self.get_source_by_url(url, conn)

    def list_sources(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM sources ORDER BY created_at DESC").fetchall()
            return [self._source(row) for row in rows]

    def get_source_by_id(self, source_id: str, conn: sqlite3.Connection | None = None) -> dict[str, Any] | None:
        if conn:
            row = conn.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
            return self._source(row) if row else None
        with self.connect() as local_conn:
            return self.get_source_by_id(source_id, local_conn)

    def get_source_by_url(self, url: str, conn: sqlite3.Connection | None = None) -> dict[str, Any] | None:
        if conn:
            row = conn.execute("SELECT * FROM sources WHERE url = ?", (url,)).fetchone()
            return self._source(row) if row else None
        with self.connect() as local_conn:
            return self.get_source_by_url(url, local_conn)

    def start_run(self, run_id: str, source_id: str) -> dict[str, Any]:
        started_at = now_iso()
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO runs (id, source_id, status, started_at) VALUES (?, ?, 'running', ?)",
                (run_id, source_id, started_at),
            )
            conn.execute(
                """
                UPDATE sources
                SET last_run_id = ?, last_status = 'running', last_error = NULL, last_run_at = ?
                WHERE id = ?
                """,
                (run_id, started_at, source_id),
            )
            return self.get_run(run_id, conn)

    def finish_run(
        self,
        run_id: str,
        source_id: str,
        status: str,
        discovered_count: int,
        new_count: int,
        synced_count: int = 0,
        error: str | None = None,
    ) -> dict[str, Any]:
        finished_at = now_iso()
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE runs
                SET status = ?, finished_at = ?, discovered_count = ?, new_count = ?,
                    synced_count = ?, error = ?
                WHERE id = ?
                """,
                (status, finished_at, discovered_count, new_count, synced_count, error, run_id),
            )
            conn.execute(
                """
                UPDATE sources
                SET last_status = ?, last_error = ?, last_run_at = ?
                WHERE id = ?
                """,
                (status, error, finished_at, source_id),
            )
            return self.get_run(run_id, conn)

    def get_run(self, run_id: str, conn: sqlite3.Connection | None = None) -> dict[str, Any] | None:
        if conn:
            row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            return dict(row) if row else None
        with self.connect() as local_conn:
            return self.get_run(run_id, local_conn)

    def upsert_items(self, source_id: str, items: list[dict[str, Any]]) -> tuple[int, int]:
        timestamp = now_iso()
        discovered = 0
        created = 0
        with self.connect() as conn:
            for item in items:
                discovered += 1
                existing = conn.execute(
                    "SELECT id FROM items WHERE external_id = ?",
                    (item["external_id"],),
                ).fetchone()
                if existing:
                    conn.execute(
                        """
                        UPDATE items
                        SET title = ?, description = ?, source_url = ?, image_url = ?,
                            thumbnail_url = ?, created_at = COALESCE(?, created_at),
                            last_seen_at = ?
                        WHERE external_id = ?
                        """,
                        (
                            item.get("title"),
                            item.get("description"),
                            item["source_url"],
                            item["image_url"],
                            item.get("thumbnail_url"),
                            item.get("created_at"),
                            timestamp,
                            item["external_id"],
                        ),
                    )
                else:
                    created += 1
                    conn.execute(
                        """
                        INSERT INTO items (
                          id, source_id, external_id, pin_id, title, description,
                          source_url, image_url, thumbnail_url, created_at,
                          first_seen_at, last_seen_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            item["external_id"],
                            source_id,
                            item["external_id"],
                            item["pin_id"],
                            item.get("title"),
                            item.get("description"),
                            item["source_url"],
                            item["image_url"],
                            item.get("thumbnail_url"),
                            item.get("created_at"),
                            timestamp,
                            timestamp,
                        ),
                    )
        return discovered, created

    def list_items(self, source_id: str, limit: int = 100) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM items
                WHERE source_id = ?
                ORDER BY COALESCE(created_at, first_seen_at) DESC
                LIMIT ?
                """,
                (source_id, limit),
            ).fetchall()
            return [dict(row) for row in rows]

    def unsent_items(self, source_id: str, limit: int = 50) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM items
                WHERE source_id = ? AND sent_to_pindeck_at IS NULL
                ORDER BY first_seen_at ASC
                LIMIT ?
                """,
                (source_id, limit),
            ).fetchall()
            return [dict(row) for row in rows]

    def mark_item_synced(self, external_id: str, image_id: str) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE items
                SET sent_to_pindeck_at = ?, pindeck_image_id = ?, last_pindeck_error = NULL
                WHERE external_id = ?
                """,
                (now_iso(), image_id, external_id),
            )

    def mark_item_sync_failed(self, external_id: str, error: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE items SET last_pindeck_error = ? WHERE external_id = ?",
                (error, external_id),
            )

    @staticmethod
    def _source(row: sqlite3.Row) -> dict[str, Any]:
        data = dict(row)
        data["tags"] = json.loads(data.pop("tags_json") or "[]")
        data["active"] = bool(data["active"])
        return data
