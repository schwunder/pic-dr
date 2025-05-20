# db.py  – thin, read/write wrapper around art.sqlite

"""
db.py  – thin, read/write wrapper around **art.sqlite**

Four tables (all created automatically):

    embeddings         filename PK → never mutated after initial ingest
    artists            artist   PK → aux-info for the viewer side-panel
    configs            every DR run (OVERWRITE by config_id possible)
    projection_points  1 row per projected 2-D point

All functions open their own connection via the `conn()` context–manager.
Foreign-keys are ON; a cascade delete on configs will automatically
purge its projection_points.
"""
from __future__ import annotations
import json, sqlite3, os
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

# ---------- location ----------
DB_PATH = Path(os.getenv("DR_DB", "art.sqlite")).expanduser()

# ---------------------------------------------------------------------
# 0)  connection helper
# ---------------------------------------------------------------------
@contextmanager
def conn():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row      # results behave like dicts
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
        con.commit()
    finally:
        con.close()

# ---------------------------------------------------------------------
# 1)  schema bootstrap (run on import)
# ---------------------------------------------------------------------
_SCHEMA_SQL = """
-- embeddings: immutable, written outside this repo
CREATE TABLE IF NOT EXISTS embeddings (
  filename   TEXT PRIMARY KEY,
  artist     TEXT NOT NULL,
  embedding  BLOB NOT NULL
);

-- auxiliary lookup
CREATE TABLE IF NOT EXISTS artists (
  artist       TEXT PRIMARY KEY,
  nationality  TEXT,
  years        TEXT,
  bio          TEXT
);

-- each successful DR configuration
CREATE TABLE IF NOT EXISTS configs (
  config_id       INTEGER PRIMARY KEY,
  method          TEXT NOT NULL,
  subset_strategy TEXT,
  subset_size     INTEGER,
  params_json     TEXT NOT NULL,
  runtime         REAL,
  created_at      TEXT DEFAULT (datetime('now'))
);

-- projected 2-D points, <= 500 per config
CREATE TABLE IF NOT EXISTS projection_points (
  id         INTEGER PRIMARY KEY,
  filename   TEXT NOT NULL,
  artist     TEXT NOT NULL,
  config_id  INTEGER NOT NULL,
  x          REAL NOT NULL,
  y          REAL NOT NULL,

  FOREIGN KEY(filename)  REFERENCES embeddings(filename) ON DELETE CASCADE,
  FOREIGN KEY(config_id) REFERENCES configs(config_id)  ON DELETE CASCADE
);
"""

with conn() as c:
    c.executescript(_SCHEMA_SQL)

# ---------------------------------------------------------------------
# 2)  convenience helpers
# ---------------------------------------------------------------------
def fetch_subset(strategy: str, size: int, rng_state: int | None = None):
    """
    Returns (embeddings : np.ndarray, meta_rows : list[dict])
    * strategy == "artist_first5" | "random"
    * size     == max #rows (enforced in SQL LIMIT)
    """
    import numpy as np

    with conn() as c:
        if strategy == "artist_first5":
            rows = c.execute("""
              WITH ranked AS (
                SELECT filename, artist, embedding,
                       ROW_NUMBER() OVER (PARTITION BY artist ORDER BY filename) rn
                  FROM embeddings
              )
              SELECT * FROM ranked WHERE rn <= 5 LIMIT ?;
            """, (size,)).fetchall()

        elif strategy == "random":
            if rng_state is not None:
                c.execute("SELECT random(?)", (rng_state,))
            rows = c.execute(
                "SELECT * FROM embeddings ORDER BY random() LIMIT ?", (size,)
            ).fetchall()

        else:
            raise ValueError(f"Unknown subset strategy: {strategy}")

    embeds = np.vstack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
    meta   = [dict(r) for r in rows]
    return embeds, meta


def upsert_config(method: str, subset_strategy: str, subset_size: int,
                  params: dict[str, Any], runtime: float,
                  config_id: int | None = None) -> int:
    """
    Inserts a new config row OR overwrites an existing one if `config_id` supplied.
    Returns the row's (possibly newly-generated) id.
    """
    params_json = json.dumps(params, sort_keys=True)

    with conn() as c:
        if config_id is None:
            cur = c.execute(
                """INSERT INTO configs
                   (method, subset_strategy, subset_size, params_json, runtime)
                   VALUES (?,?,?,?,?)""",
                (method, subset_strategy, subset_size, params_json, runtime)
            )
            return cur.lastrowid
        else:
            c.execute(
                """REPLACE INTO configs
                   (config_id, method, subset_strategy, subset_size,
                    params_json, runtime)
                   VALUES (?,?,?,?,?,?)""",
                (config_id, method, subset_strategy, subset_size,
                 params_json, runtime)
            )
            return config_id


def save_points(config_id: int, points: Iterable[tuple[str, str, float, float]]):
    """
    Bulk-insert projected points:
        points iterable of (filename, artist, x, y)
    """
    with conn() as c:
        c.executemany("""
          INSERT INTO projection_points(filename, artist, config_id, x, y)
               VALUES (?,?,?, ?,?)
        """, [(fn, ar, config_id, float(x), float(y)) for fn, ar, x, y in points])


def load_config_blob(config_id: int) -> dict[str, Any]:
    """Return {config: row-dict, points: [row-dict,…]} for JSON passthrough."""
    with conn() as c:
        cfg = c.execute("SELECT * FROM configs WHERE config_id = ?", (config_id,)).fetchone()
        if cfg is None:
            raise KeyError(f"config_id {config_id} not found")

        pts = c.execute("""
            SELECT filename, artist, config_id, x, y
              FROM projection_points
             WHERE config_id = ?
        """, (config_id,)).fetchall()

    return {
        "config": dict(cfg),
        "points": [dict(r) for r in pts]
    }
