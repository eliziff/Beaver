"""Load CourtListener's bulk tables (the 2026-09-30 PostgreSQL CSV dumps) into one DuckDB file.

    python -I load_duckdb.py DB BULK_DIR TABLE [TABLE ...]     (TABLE = courts, opinion-clusters, dockets, opinions, ...)

Each file is decompressed once (parallel bzip2) to a temporary CSV beside DB, read with the dump's
own conventions (FORMAT csv, ESCAPE '\\', HEADER; an unquoted empty field is NULL, "" is ''),
stored with every column as text except the ids, its row count recorded, and the temporary CSV
deleted. A table already recorded in _loaded is skipped, so a rerun resumes.
"""
import os
import sys
import time
import json
import duckdb
import indexed_bzip2

DATE = "2026-09-30"
# The largest record DuckDB's reader accepts; its read buffer is twice that, per thread. A record
# past it fails the load loudly, and this is raised.
MAX_RECORD = 128 << 20
# Columns cast to BIGINT (the joins); everything else stays as CourtListener wrote it.
IDS = {
    "opinion-clusters": ["id", "docket_id"],
    "dockets": ["id"],
    "opinions": ["id", "cluster_id", "author_id"],
}


def log(msg, out):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}"
    print(line, flush=True)
    out.write(line + "\n")
    out.flush()


def decompress(src, dst, out):
    t0 = time.time()
    with indexed_bzip2.open(src, parallelization=4) as f, open(dst + ".part", "wb") as w:
        n = 0
        while True:
            b = f.read(16 << 20)
            if not b:
                break
            w.write(b)
            n += len(b)
            if n % (8 << 30) < (16 << 20):
                log(f"  decoded {n / 1e9:.1f} GB ({n / 1e6 / (time.time() - t0):.0f} MB/s)", out)
    os.replace(dst + ".part", dst)
    return n, time.time() - t0


def main():
    db_path, bulk = sys.argv[1], sys.argv[2]
    tables = sys.argv[3:]
    work = os.path.dirname(os.path.abspath(db_path))
    out = open(os.path.join(work, "load.log"), "a", encoding="utf-8")

    # The database is open only while a table is written, so others can read it in between
    # (DuckDB admits no reader from another process while a writer is connected).
    def connect():
        con = duckdb.connect(db_path)
        con.execute("SET memory_limit='3GB'; SET threads=2; SET preserve_insertion_order=false")
        con.execute(f"SET temp_directory='{os.path.join(work, 'duckdb-temp')}'")
        con.execute("CREATE TABLE IF NOT EXISTS _loaded (tbl VARCHAR, source VARCHAR, source_bytes BIGINT, decoded_bytes BIGINT, csv_rows BIGINT, loaded_at VARCHAR)")
        return con

    for t in tables:
        name = t.replace("-", "_")
        con = connect()
        done = con.execute("SELECT count(*) FROM _loaded WHERE tbl = ?", [name]).fetchone()[0]
        con.close()
        if done:
            log(f"{name}: already loaded", out)
            continue
        src = os.path.join(bulk, f"{t}-{DATE}.csv.bz2")
        csv = os.path.join(work, f"{t}.csv")
        if not os.path.exists(csv):
            log(f"{name}: decompressing {src}", out)
            n, s = decompress(src, csv, out)
            log(f"{name}: {n / 1e9:.2f} GB decoded in {s:.0f} s", out)
        decoded = os.path.getsize(csv)
        reader = (f"read_csv('{csv}', header=true, delim=',', quote='\"', escape='\\', all_varchar=true, "
                  f"allow_quoted_nulls=false, max_line_size={MAX_RECORD}, buffer_size={2 * MAX_RECORD}, parallel=true)")
        ids = IDS.get(t, [])
        replace = f" REPLACE ({', '.join(f'CAST({c} AS BIGINT) AS {c}' for c in ids)})" if ids else ""
        log(f"{name}: loading", out)
        t0 = time.time()
        con = connect()
        con.execute(f"DROP TABLE IF EXISTS {name}")
        con.execute(f"CREATE TABLE {name} AS SELECT *{replace} FROM {reader}")
        rows = con.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
        cols = con.execute(f"SELECT count(*) FROM information_schema.columns WHERE table_name = '{name}'").fetchone()[0]
        log(f"{name}: {rows} rows, {cols} columns, loaded in {time.time() - t0:.0f} s", out)
        con.execute("INSERT INTO _loaded VALUES (?, ?, ?, ?, ?, ?)",
                    [name, src, os.path.getsize(src), decoded, rows, time.strftime('%Y-%m-%dT%H:%M:%S')])
        con.execute("CHECKPOINT")
        con.close()
        os.remove(csv)
    con = connect()
    log("done " + json.dumps(con.execute("SELECT tbl, csv_rows FROM _loaded").fetchall()), out)
    con.close()


main()
