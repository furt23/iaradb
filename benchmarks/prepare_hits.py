"""Write a typed copy of ClickBench's hits.parquet for the benchmark.

The published file stores EventTime as Unix seconds, EventDate as days since
1970 and strings as binary. This copy uses TIMESTAMP, DATE and UTF-8 strings, so
every engine runs the queries on the same column types.

usage: python benchmarks/prepare_hits.py <hits.parquet> <out.parquet>
"""

import sys

import duckdb

src, dst = sys.argv[1], sys.argv[2]
con = duckdb.connect()
con.execute(
    f"""
COPY (
    SELECT * REPLACE (
        to_timestamp(EventTime)::TIMESTAMP AS EventTime,
        (DATE '1970-01-01' + EventDate::INTEGER) AS EventDate,
        to_timestamp(ClientEventTime)::TIMESTAMP AS ClientEventTime,
        to_timestamp(LocalEventTime)::TIMESTAMP AS LocalEventTime
    )
    FROM read_parquet('{src}', binary_as_string = true)
) TO '{dst}' (FORMAT parquet, COMPRESSION zstd)
"""
)
print(con.execute(f"SELECT count(*) FROM '{dst}'").fetchone()[0], "rows")
