# Workhouse API gap vs PySpark and Polars

> **Re-check (2026-10-11).** The tables below predate commit `8eb0499`. Verified status of what is still open:
> - Frame:
>   - pivot/unpivot, join_asof, join_where;
>   - frame `cast`, hstack, top_k/bottom_k, transpose, null_count/n_unique;
>   - is_duplicated/is_unique, random_split/sample_by, crosstab;
>   - eager `rename`/`drop`, `__getitem__` with list or slice, to_numpy/iter_rows.
> - Expr:
>   - value_counts, mode, replace/replace_strict;
>   - cum_prod, pct_change, ewm, rolling_median/quantile, cut/qcut;
>   - hash/md5/sha2, bitwise, cbrt/log1p/hypot, is_finite;
>   - nvl2/zeroifnull/nanvl/try_divide, string_agg, skew/kurtosis;
>   - explode_outer/posexplode, str.extract_all/split_exact/strip_prefix/levenshtein;
>   - dt.total_*, time zone functions, list.eval/filter and set operations, map type.
> - Python UDFs (map_elements, map_batches, SQL UDF): none.
> - Dtype classes, selectors, group_by_dynamic, write modes, scan_parquet options, Arrow IPC, compressed CSV, GCS/Azure/HTTP, databases.
> - Present now (despite the tables below): frame ops (fill_null/nan, drop_nulls, unique subset, sample, with_row_index, describe, union_by_name, explode/unnest), regex, padding/split, dates and formats, trig, corr/covar, quantiles, collect_list/set, max_by/min_by, count_if, bool_and/or, product, list/struct/JSON namespaces, NDJSON IO, CSV options.
> - Corrections:
>   - DISTINCT ON was NotSupported (being fixed in the 2026-10-11 round);
>   - LATERAL covers UNNEST only.
>
> **Status (2026-10-10).**
> - Done: P1 items 1–7 (frame ops), 8–9 (JSON and CSV options), 10–15 and 19 (scalars, regex, dates), 17–18 (aggregates), and the list work (P1 16 and 20: `array_agg`, `collect_list`/`collect_set`, `explode`/`unnest`; the `split` item; the list namespace). Also `ROLLUP`/`CUBE`/`GROUPING SETS`, trig, `now()` and `random()`.
> - Next: structs and nested JSON.

Scope: Workhouse Python (`python/workhouse/__init__.py`, `_window.py`) and the SQL/Rust function registry (`crates/workhouse-core/src`: `expr.rs` enums `AggFunc`, `ScalarFunc`, `WindowFunc`; `physical/functions.rs`; `sql/mod.rs`; `io/`).

Reference versions: Polars 1.44.2 (installed, introspected with `dir()`). PySpark: not installed; names taken from the official docs index (`pyspark.sql.functions` and `pyspark.sql.DataFrame`). Status marks are based on the code read. Items marked "unverified" were only seen in a keyword grep.

## 1. Workhouse inventory

- **DataFrame (eager):** filter, select, with_columns, sort, join (inner/left/right/full/semi/anti/cross), group_by, unique, head, slice, sql, lazy, to_arrow/pandas/polars/dicts, write_parquet, write_csv.
- **LazyFrame:** the above plus limit, drop, rename, union, sink_parquet, sink_csv, explain, profile, fetch, collect, to_reader, stream, iter_batches.
- **GroupBy:** agg, sum, mean, min, max, count, len.
- **Expr:** arithmetic and comparisons, alias, cast, is_null, is_not_null, is_in, is_between, fill_null, filter, not_, sum, mean, min, max, count, n_unique, std, var, median, first, last, abs, round, sqrt, exp, log, log10, floor, ceil, pow, when/then/otherwise, coalesce, greatest, least, concat_str.
- **Window (`_window.py`):** over, rank, shift, diff, cum_sum, cum_min, cum_max, cum_count, rolling_sum/mean/min/max/std/var, row_number.
- **str namespace:** contains, like, starts_with, ends_with, to_uppercase, to_lowercase, len_chars, strip_chars(_start/_end), slice, head, tail, replace_all, reverse.
- **dt namespace:** year, quarter, month, week, day, weekday, ordinal_day, hour, minute, second, truncate.
- **Top-level functions:** col, lit, all, count, len, sum, mean, min, max, row_number, coalesce, greatest, least, concat_str, when, scan/read parquet and csv, from_arrow/pandas/polars/dict, sql.
- **SQL scalars:** abs, ceil, floor, round, sqrt, exp, ln, log, log10, log2, power, upper, lower, length, trim/ltrim/rtrim, substring, replace, concat, starts_with, ends_with, contains, strpos, left, right, reverse, coalesce, nullif, ifnull, iff, greatest, least, date parts (year to second, dayofweek, dayofyear, weekofyear), date_trunc, date_part, to_date.
- **SQL aggregates:** count, count_distinct, sum, avg, min, max, median, stddev (pop/samp), variance (pop/samp), first/last/any_value, approx_count_distinct.
- **SQL window functions:** row_number, rank, dense_rank, percent_rank, cume_dist, ntile, lag, lead, first_value, last_value, nth_value, plus aggregates over frames.
- **Joins and set ops in SQL:** INTERSECT, EXCEPT, LATERAL, QUALIFY, DISTINCT ON are present.
- **IO:** parquet (read, scan, write with compression and row group size), csv (read and scan with header, separator, schema inference length, parallel; write with separator and header), object stores through `storage_options`, partitioned parquet write in SQL.

## 2. Summary tables by category

Status: P = present, Pa = partial, M = missing.

### DataFrame / LazyFrame ops

| Op | Polars | PySpark | Workhouse |
|---|---|---|---|
| filter, select, with_columns, sort, group_by, head, slice, rename, drop, unique | yes | yes | P |
| join inner/left/right/full/semi/anti/cross | yes | yes | P |
| join_asof / asof join | join_asof | (none, use window) | M |
| join_where (non-equi) | join_where | join on expr | M |
| fill_null / fillna on frame | yes | yes | Pa (Expr only) |
| fill_nan | yes | (na.fill) | M |
| drop_nulls / dropna(subset) | yes | yes | M |
| drop_nans | yes | no | M |
| unique(subset, keep) / drop_duplicates(subset) | yes | yes | Pa (no subset) |
| is_duplicated / is_unique | yes | no | M |
| with_row_index / monotonically_increasing_id | yes | yes | M |
| sample(n or fraction, seed) | yes | yes | M |
| sample_by / randomSplit | no | yes | M |
| describe / summary | yes | yes | M |
| pivot | yes | yes | M |
| unpivot / melt | yes | yes | M |
| explode / unnest | yes | yes | M |
| union (by position) | yes | yes | P |
| union by name | yes (how=diagonal) | unionByName | M |
| cast on frame (by schema) | yes | no | M (Expr only) |
| hstack / vstack | yes | no | M |
| top_k / bottom_k | yes | (orderBy+limit) | M |
| transpose | yes | no | M |
| null_count / n_unique on frame | yes | no | M |
| cube / rollup / grouping sets | no | yes | M |
| crosstab / freqItems / approxQuantile | no | yes | M |
| write_ndjson / write_json | yes | yes (via write.json) | M |
| write_ipc (Arrow IPC) | yes | no | M |
| write_excel | yes | no | M |
| write_delta / sink_delta | yes | yes | M |
| collect_schema / schema access | yes | yes | P (schema dict) |
| explain | yes | yes | P |

### Expr (general)

| Op | Polars | PySpark | Workhouse |
|---|---|---|---|
| arithmetic, comparisons, boolean | yes | yes | P |
| alias, cast, is_in, is_between | yes | yes | P |
| eq_missing (null-safe equal) | yes | equal_null | M |
| clip | yes | (greatest/least) | M |
| sign, mod/pmod | yes | yes | M |
| cbrt, log1p, hypot | yes | yes | M |
| trig (sin, cos, tan, arc*, degrees, radians) | yes | yes | M (unverified in grep) |
| is_nan / is_finite / is_infinite | yes | isnan | M |
| replace / replace_strict (mapping) | yes | no | M |
| value_counts / mode | yes | (groupBy count) | M |
| arg_max / arg_min | yes | no | M |
| cum_prod | yes | no | M |
| pct_change | yes | no | M |
| quantile (scalar) | yes | percentile | M |
| is_duplicated / is_unique (per-row) | yes | no | M |
| hash | yes | hash | M |
| first / last | yes | yes | P |
| map_elements (Python UDF) | yes | udf | out of scope |

### String

| Op | Polars | PySpark | Workhouse |
|---|---|---|---|
| contains (regex) | yes | rlike | Pa (literal flag only) |
| regex replace / extract / extract_all / count / like | yes | regexp_* | M (no regex functions in the registry) |
| split, split_exact, splitn | yes | split | M |
| replace (first occurrence) | yes | replace | Pa (replace_all only) |
| pad_start / pad_end / zfill | yes | lpad/rpad | M |
| lpad / rpad | no | yes | M |
| concat_ws | no | yes | M |
| initcap / to_titlecase | yes | initcap | M |
| repeat | no | repeat | M |
| find / instr | yes | instr | P (strpos, instr in SQL) |
| len_bytes, encode, decode | yes | encode/decode | M |
| strip_prefix / strip_suffix | yes | no | M |
| translate, levenshtein, soundex | no | yes | M |
| json_decode / json_path_match | yes | get_json_object | M |
| to_date / to_datetime / strptime (format) | yes | to_date(format) | M for format arg (to_date exists in SQL) |

### Datetime

| Op | Polars | PySpark | Workhouse |
|---|---|---|---|
| year, month, day, hour, minute, second, quarter, week, weekday, ordinal_day | yes | yes | P |
| truncate / date_trunc | yes | date_trunc | P |
| strftime / to_string (format) | yes | date_format | M |
| month_start / month_end / last_day | yes | last_day | M |
| offset_by / add_months | yes (offset_by) | add_months | M |
| date_add / date_sub / date_diff / datediff | no (via arithmetic) | yes | M |
| total_days / total_seconds, etc. | yes | (datediff) | M |
| convert_time_zone / replace_time_zone | yes | convert_timezone | M |
| make_date / make_timestamp | no | yes | M |
| current_date / now | no | yes | M (unverified) |
| is_leap_year, days_in_month | yes | no | M |
| combine / time / date | yes | to_time | M |

### List, array, struct, map

| Op | Polars | PySpark | Workhouse |
|---|---|---|---|
| list namespace (len, get, first, last, contains, sort, unique, join, sum, mean, min, max, explode, slice, concat) | yes (43 methods) | array_* functions | M (no list/array namespace) |
| struct namespace (field, unnest, rename_fields, with_fields) | yes | named_struct, struct | M |
| array / struct constructors | yes | yes | M |
| explode / explode_outer / posexplode | yes | yes | M |
| map functions | no | yes | M |

### Math and conditionals

| Op | Polars | PySpark | Workhouse |
|---|---|---|---|
| abs, ceil, floor, round, sqrt, exp, ln, log10, log2, power | yes | yes | P |
| sign, mod, cbrt, trig, radians, degrees | yes | yes | M |
| bitwise and/or/xor/shift | yes | yes | M |
| when/then/otherwise | yes | yes | P |
| coalesce, greatest, least, nullif | yes | yes | P |
| nvl2, nullifzero, zeroifnull, nanvl | no | yes | M |
| try_divide, try_cast-style | no | yes | M |

### Aggregates

| Op | Polars | PySpark | Workhouse |
|---|---|---|---|
| count, sum, mean, min, max, median, std, var, first, last, n_unique | yes | yes | P |
| approx_count_distinct / approx_n_unique | yes | yes | P (SQL) |
| count_distinct, sum_distinct | yes | yes | Pa (count_distinct only) |
| collect_list / array_agg / list | yes | yes | M |
| collect_set (unique list) | yes (n_unique + list) | yes | M |
| percentile / quantile / approx_percentile | yes | yes | M |
| mode | yes | yes | M |
| string_agg / listagg | no | yes | M |
| max_by / min_by / arg_max / arg_min | yes | yes | M |
| count_if, bool_and / every, bool_or / some | no | yes | M |
| product | yes | yes | M |
| skewness / kurtosis | yes | yes | M |
| corr, covar_pop, covar_samp | yes (corr) | yes | M (unverified in grep) |
| any_value | no | yes | P (SQL) |

### Window

| Op | Polars | PySpark | Workhouse |
|---|---|---|---|
| row_number, rank, dense_rank, percent_rank, cume_dist, ntile | (rank) | yes | P (SQL), Pa in Python (rank, row_number) |
| lag, lead, first_value, last_value, nth_value | (shift) | yes | P (SQL), Python shift/diff |
| cumulative sum/min/max/count | yes | (window) | P |
| cum_prod | yes | no | M |
| rolling sum/mean/min/max/std/var | yes | window | P |
| rolling_median / rolling_quantile / rolling_skew | yes | no | M |
| ewm_mean / ewm_std | yes | no | M |

### IO

| Op | Polars | PySpark | Workhouse |
|---|---|---|---|
| read/scan parquet, csv | yes | yes | P |
| csv: quote char, null values, skip rows, columns subset, schema override, compression | yes | yes | Pa (header, separator, infer length only) |
| read/write/scan json, ndjson | yes | yes | M |
| write_csv options (quote, null, date format) | yes | yes | Pa (separator, header) |
| ipc / arrow file | yes | no | M |
| excel | yes | pandas | M (not needed) |
| delta / iceberg | yes | yes | M |
| partitioned write (hive-style) | yes (write_parquet partitioned via pyarrow) | yes | P (SQL partition_by) |
| JDBC / databases | yes | yes | M |

### SQL functions

Workhouse SQL covers the scalar and aggregate list in section 1. Missing SQL functions that Spark users expect: regexp_*, lpad/rpad, split_part, repeat, initcap, concat_ws, date_add/date_sub/date_diff/add_months/last_day/make_date, array_* and struct/map constructors, json functions, md5/sha2, bitwise ops, percentile_approx, collect_list/array_agg, string_agg, count_if, bool_and/bool_or, max_by/min_by, UNNEST/EXPLODE, PIVOT/UNPIVOT (not in sqlparser output). Verify before relying on `now` and `current_date`, which did not show up in the registry grep.

## 3. Should add (ranked)

Effort: S = under a day, M = a few days, L = a week or more. Code hints point at the files to touch. Python signatures are proposals.

### P1: common in real data work and cheap

1. **fill_null / fill_nan on DataFrame** (Polars `fill_null`, `fill_nan`; Spark `fillna`). Python: `df.fill_null(value, columns=None)`. SQL: `COALESCE` per column already works, so add a helper. Code: `python/workhouse/__init__.py` DataFrame and LazyFrame. Effort S.
2. **drop_nulls(subset) / drop_nans** (Polars `drop_nulls`; Spark `dropna`). Python: `df.drop_nulls(subset=None)`. SQL: `WHERE col IS NOT NULL` form. Code: Python layer, plus `physical/` filter if a native op is wanted. Effort S.
3. **unique(subset, keep) / drop_duplicates(subset)** (Polars `unique(subset=, keep=)`, Spark `dropDuplicates`). Python: `lf.unique(subset=[...], keep="first")`. SQL: `DISTINCT ON`, already parsed. Code: `crates/workhouse-core/src/logical.rs` and `exec/`. Effort M.
4. **sample(n / fraction, seed)** (Polars `sample`, Spark `sample`). Python: `df.sample(n=None, fraction=None, seed=None)`. SQL: `TABLESAMPLE`. Code: `logical.rs` and `exec/ops.rs`. Effort M.
5. **with_row_index / monotonically_increasing_id** (Polars `with_row_index`, Spark `monotonically_increasing_id`). Python: `df.with_row_index(name="index", offset=0)`. SQL: `ROW_NUMBER() OVER ()`. Code: `window.rs` and a Python wrapper. Effort S.
6. **describe / summary** (Polars `describe`, Spark `summary`). Python: `df.describe()` returns a DataFrame of count, null_count, mean, std, min, quartiles, max. Code: Python layer built on existing aggregates. Effort M.
7. **union_by_name** (Polars `concat(how="diagonal")`, Spark `unionByName`). Python: `lf.union(other, by_name=True)`. SQL: `UNION ALL BY NAME`. Code: `logical.rs` union, `physical/planner.rs`. Effort S.
8. **JSON and NDJSON IO** (Polars `read_json`, `read_ndjson`, `scan_ndjson`, `write_ndjson`, `sink_ndjson`; Spark `read.json`). Python: `read_ndjson(path)`, `scan_ndjson(path)`, `df.write_ndjson(path)`. SQL: `read_json(...)`. Code: new `crates/workhouse-core/src/io/json/` next to `io/csv/`, and `crates/workhouse-python`. Effort L.
9. **CSV options** (Polars `read_csv` kwargs, Spark `csv` options). Python: `read_csv(path, quote_char, null_values, skip_rows, columns, schema, compression)`. Code: `io/csv/source.rs`, `io/csv/write.rs`, `python/workhouse/__init__.py` `scan_csv`. Effort M.
10. **Expr.clip, sign, mod, is_nan** (Polars `clip`, `sign`, `%`, `is_nan`; Spark `sign`, `pmod`, `isnan`). Python: `e.clip(lo, hi)`, `e.sign()`, `e.is_nan()`. SQL: `SIGN`, `MOD`, `CLIP` via `GREATEST(LEAST())`. Code: `expr.rs` `ScalarFunc`, `physical/functions.rs`, `_window.py` style helpers in `__init__.py`. Effort S.
11. **Date arithmetic functions** (Spark `date_add`, `date_sub`, `datediff`, `add_months`, `last_day`, `make_date`; Polars `dt.offset_by`, `dt.month_end`). Python: `e.dt.offset_by("1mo")`, `e.dt.month_end()`. SQL: `DATE_ADD(d, n)`, `DATEDIFF(a, b)`, `ADD_MONTHS(d, n)`, `LAST_DAY(d)`, `MAKE_DATE(y, m, d)`. Code: `scalar.rs` plus `physical/functions.rs` Date32 arithmetic. Effort M.
12. **String parse to date/time with format** (Polars `str.to_date(format)`, `str.to_datetime`, `str.strptime`; Spark `to_date(col, fmt)`, `to_timestamp`). Python: `e.str.to_datetime("%Y-%m-%d %H:%M")`. SQL: `TO_DATE(s, fmt)`, `TO_TIMESTAMP(s, fmt)`. Code: `physical/functions.rs` using chrono parse. Effort M.
13. **Datetime formatting** (Polars `dt.strftime`, Spark `date_format`). Python: `e.dt.strftime("%Y-%m")`. SQL: `DATE_FORMAT(ts, fmt)`. Code: `physical/functions.rs`. Effort S.
14. **String padding and split** (Polars `str.pad_start`, `str.zfill`, `str.split`, `str.split_exact`; Spark `lpad`, `rpad`, `split`, `split_part`, `concat_ws`, `initcap`, `repeat`). Python: `e.str.pad_start(10, "0")`, `e.str.split(",")`. SQL: `LPAD`, `RPAD`, `SPLIT_PART`, `CONCAT_WS`, `INITCAP`, `REPEAT`. Code: `expr.rs` `ScalarFunc` enum, `physical/functions.rs` string arms. Effort S each, S-M for `split` (list type).
15. **Regex functions** (Polars `str.extract`, `str.replace` regex, `str.count_matches`, `str.contains` with `literal=False`; Spark `regexp_extract`, `regexp_replace`, `regexp_like`, `regexp_count`). Python: `e.str.extract(pattern, group=1)`, `e.str.replace(pattern, value, literal=False)`. SQL: `REGEXP_EXTRACT`, `REGEXP_REPLACE`, `REGEXP_LIKE`, `REGEXP_COUNT`. Code: `physical/functions.rs` with the `regex` crate (check Cargo.toml), and `_StrNamespace` in `__init__.py` where `contains` currently forces `literal=True`. Effort M.
16. **collect_list / array_agg and collect_set** (Polars `implode`, `agg_groups`, `list.unique`; Spark `collect_list`, `collect_set`). Python: `group_by(k).agg(xs.implode())`, `xs.unique().implode()`. SQL: `ARRAY_AGG(x)`, `COLLECT_SET`. Code: `expr.rs` `AggFunc`, `exec/accumulators.rs`, a list dtype in `types.rs`. Effort L because lists are needed. Keep at P1 since it is the most-requested aggregate.
17. **percentile / quantile aggregates** (Polars `quantile`, `median` exists; Spark `percentile`, `percentile_approx`). Python: `col("x").quantile(0.9)` on Expr and as an aggregate. SQL: `PERCENTILE_CONT(p)`, `APPROX_PERCENTILE(x, p)`. Code: `expr.rs` `AggFunc`, `exec/accumulators.rs`. Effort M.
18. **Small aggregates: count_if, bool_and/or, max_by/min_by, product, sum_distinct** (Spark `count_if`, `bool_and`, `bool_or`, `max_by`, `min_by`, `product`, `sum_distinct`; Polars `max_by`, `min_by`, `product`). Python: `pl.col("x").max_by("y")`. SQL: matching names. Code: `expr.rs` `AggFunc::from_name`, `exec/accumulators.rs`. Effort S each.
19. **Null-safe equality** (Polars `eq_missing`, Spark `equal_null`). Python: `a.eq_missing(b)`. SQL: `a IS NOT DISTINCT FROM b`. Code: `expr.rs` `Operator` enum. Effort S.
20. **Explode and unnest** (Polars `explode`, `unnest`; Spark `explode`, `posexplode`). Python: `df.explode("tags")`. SQL: `UNNEST(...)`, `LATERAL` already parsed. Code: `logical.rs`, new `physical/` op. Depends on list type (item 16). Effort L. Listed in P1 because nearly every nested-data pipeline needs it.

### P2: valuable, medium effort

21. **pivot / unpivot (melt)** (Polars `pivot`, `unpivot`, `melt`; Spark `pivot`, `unpivot`). Python: `df.pivot(on="k", index="id", values="v", aggregate="sum")`, `df.unpivot(index=["id"], on=[...])`. SQL: `PIVOT`, `UNPIVOT`. Code: `logical.rs` plus rewrite to `group_by` + `CASE`. Effort M/L.
22. **asof join and join_where** (Polars `join_asof`, `join_where`). Python: `lf.join_asof(other, on="ts", by="id", strategy="backward")`. SQL: `ASOF JOIN`. Code: `exec/join.rs`. Effort L.
23. **list namespace** (Polars `Expr.list.*`: len, get, first, last, contains, sort, unique, join, sum, mean, min, max, concat, slice, set operations). Python: `e.list.len()`, `e.list.contains(x)`. SQL: `ARRAY_LENGTH`, `ARRAY_CONTAINS`, `ARRAY_SORT`, `ARRAY_DISTINCT`, `ARRAY_JOIN`. Code: new `python/workhouse/_list.py` namespace, `physical/functions.rs`. Effort L.
24. **struct namespace and struct()** (Polars `struct.field`, `struct.unnest`, `struct.rename_fields`; Spark `struct`, `named_struct`). Python: `pl.struct(a, b)`, `e.struct.field("a")`, `e.struct.unnest()`. SQL: `STRUCT(a, b)`, `named_struct`. Code: `types.rs`, `physical/functions.rs`, new `python/workhouse/_struct.py`. Effort L.
25. **Expr.replace / replace_strict (mapping)** (Polars `replace`, `replace_strict`). Python: `e.replace({"a": 1})`. SQL: `CASE WHEN` generated. Code: `__init__.py` building `when/then` chain. Effort S.
26. **value_counts, mode, n_unique on frame, top_k / bottom_k, arg_max / arg_min** (Polars `value_counts`, `top_k`, `bottom_k`, `arg_max`, `arg_min`, `mode`; Spark no direct). Python: `e.value_counts()`, `df.top_k(3, by="x")`. SQL: `ORDER BY ... LIMIT`. Code: Python wrappers plus `AggFunc` additions. Effort S each.
27. **Trig, cbrt, log1p, radians, degrees, hypot** (Polars, Spark). Python: `e.sin()`, `e.cbrt()`. SQL: `SIN`, `COS`, `TAN`, `CBRT`, `LOG1P`, `RADIANS`, `DEGREES`. Code: `expr.rs` `ScalarFunc`, `physical/functions.rs` `unary_f64`. Effort S.
28. **Hash functions** (Polars `hash`; Spark `md5`, `sha1`, `sha2`, `xxhash64`, `hash`). Python: `e.hash()`, `e.md5()`. SQL: `MD5`, `SHA2`. Code: `physical/functions.rs`, crate `md-5` or `sha2` (check Cargo.toml). Effort S-M.
29. **JSON functions** (Polars `str.json_decode`, `json_path_match`; Spark `get_json_object`, `from_json`, `to_json`). Python: `e.str.json_path_match("$.a")`. SQL: `JSON_EXTRACT`. Code: new `physical/json.rs`. Effort M.
30. **Frame-level cast and hstack / vstack** (Polars `cast` dict, `hstack`, `vstack`). Python: `df.cast({"a": "Int64"})`. Code: Python layer. Effort S.
31. **Window extras: cum_prod, rolling_median / rolling_quantile, ewm_mean, pct_change** (Polars window and rolling family). Python: `e.cum_prod()`, `e.rolling_median(3)`, `e.pct_change()`. SQL: window frames. Code: `_window.py` and `window.rs`. Effort M.
32. **Arrow IPC write and read** (Polars `write_ipc`, `scan_ipc`; Spark no direct). Python: `df.write_ipc(path)`, `scan_ipc(path)`. Code: `io/`. Effort M.
33. **CSV/parquet options: schema override and column projection on read** (`scan_parquet(path, columns=...)`, Polars `schema` and `columns`). Code: `io/parquet/source.rs`. Effort M.
34. **Null/nan helpers: nvl2, nullifzero, zeroifnull, nanvl** (Spark). Python: `zeroifnull(e)`. SQL: `ZEROIFNULL`, `NVL2`. Code: `physical/functions.rs`. Effort S.
35. **Bitwise ops** (Polars `bitwise_*`; Spark `shiftleft`, `bit_count`, `bit_and`). Python: `e.bitwise_and(x)`. SQL: `&`, `|`, `<<`. Code: `physical/functions.rs`. Effort S.
36. **Approximate and stat extras: approx_quantile, cov, corr aggregate** (Polars `corr`, `cov`; Spark `corr`, `covar_pop`, `covar_samp`, `approxQuantile`). Python: `df.corr()`, `pl.corr(a, b)`. SQL: `CORR`, `COVAR_SAMP`. Code: `AggFunc` plus `exec/accumulators.rs`. Effort M.

### P3: niche

37. **cube, rollup, grouping sets** (Spark `cube`, `rollup`, `groupingSets`; Polars none). SQL: `ROLLUP`, `CUBE`, `GROUPING SETS` (parse status to check). Code: `logical.rs`. Effort L.
38. **sample_by and random_split** (Spark `sampleBy`, `randomSplit`). Python: `df.random_split([0.8, 0.2], seed=1)`. Effort M.
39. **crosstab, freq_items** (Spark `crosstab`, `freqItems`; Polars `pivot` covers most). Effort M.
40. **Delta and Iceberg read/write** (Polars `read_delta`, `scan_delta`, `write_delta`, `scan_iceberg`; Spark `format("delta")`). Code: `io/`. Effort L.
41. **Map functions** (Spark `map_keys`, `map_values`, `create_map`, `map_from_arrays`). Code: `types.rs`. Effort L.
42. **Cut and qcut** (Polars `cut`, `qcut`). Python: `e.cut([0, 10, 100])`. Effort S-M.
43. **Transpose and hstack/vstack extras** (Polars `transpose`, `vstack`). Effort M.
44. **Excel / ODS write** (Polars `write_excel`, `read_excel`). Out of scope unless users ask. Effort M.
45. **Map and list higher-order functions** (Spark `transform`, `filter`, `aggregate`, `exists`, `zip_with`; Polars `list.eval`, `list.filter`). Depends on list namespace. Effort L.
46. **Hyper-specific: approx_count_distinct accuracy knobs and sketch functions** (Spark `hll_sketch_agg`, `kll_sketch`). Effort L, low demand.

## 4. Notes

- The biggest structural gaps are list/struct types (blocks explode, collect_list, list namespace, struct namespace) and regex (blocks many string tasks). Fixing these two unlocks most of the P1 and P2 items.
- Unverified in code: `now`, `current_date`, trig names, `corr`, `ROLLUP`/`CUBE` parsing. Confirm before writing the Workhouse roadmap around them.
- PySpark was not installed, so its list comes from the docs index. The docs page was truncated after the first 100k characters, so the Pandas API on Spark section is not covered. The DataFrame list is complete.
