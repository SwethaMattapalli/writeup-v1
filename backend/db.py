"""
Interaction log (FR-7): local SQLite, or Postgres when DATABASE_URL is set
(hosted on Render, where the local disk is wiped on every redeploy).

Schema mirrors §9 of the PRD exactly so no migration is needed when the
pattern-viewer / fine-tune pipeline is built on top.
"""

import sqlite3
import time
from pathlib import Path
import os

DB_PATH = Path(os.environ.get("WRITEUP_DB_PATH", Path.home() / ".writeup" / "interactions.db"))
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()


def _connect():
    if DATABASE_URL:
        import psycopg

        return psycopg.connect(DATABASE_URL)
    return sqlite3.connect(DB_PATH)


def init_db() -> None:
    """Create the database and schema if they don't exist yet."""
    if DATABASE_URL:
        id_col = "BIGSERIAL PRIMARY KEY"
        ts_col = "BIGINT NOT NULL"
    else:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        id_col = "INTEGER PRIMARY KEY AUTOINCREMENT"
        ts_col = "INTEGER NOT NULL"
    with _connect() as conn:
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS interactions (
                id            {id_col},
                ts            {ts_col},
                app_context   TEXT,
                tone          TEXT NOT NULL,
                original_text TEXT NOT NULL,
                suggested_text TEXT NOT NULL,
                final_text    TEXT,
                resolution    TEXT NOT NULL
                                  CHECK(resolution IN
                                        ('accepted','edited','dismissed','regenerated','error')),
                latency_ms    INTEGER
            )
        """)
        conn.commit()


def log_interaction(
    *,
    tone: str,
    original_text: str,
    suggested_text: str,
    resolution: str,
    latency_ms: int,
    final_text: str | None = None,
    app_context: str | None = None,
) -> None:
    """Insert one row into the interactions table.

    Silently ignores errors so that logging never blocks the main flow (FR-7).
    """
    placeholder = "%s" if DATABASE_URL else "?"
    try:
        with _connect() as conn:
            conn.execute(
                f"""
                INSERT INTO interactions
                    (ts, app_context, tone, original_text, suggested_text,
                     final_text, resolution, latency_ms)
                VALUES ({", ".join([placeholder] * 8)})
                """,
                (
                    int(time.time() * 1000),
                    app_context,
                    tone,
                    original_text,
                    suggested_text,
                    final_text,
                    resolution,
                    latency_ms,
                ),
            )
            conn.commit()
    except Exception:
        pass  # Logging must never crash the caller (FR-7)
