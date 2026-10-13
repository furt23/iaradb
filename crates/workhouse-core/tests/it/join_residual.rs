//! Hash joins with a residual filter and nested loop joins, run as operators
//! and compared with a brute-force join. The build sides are bigger than one
//! output chunk (8192 rows) and the pairs span several chunks, so the chunked
//! paths run. The memory pool is process-wide: tests take a lock.

use std::sync::{Arc, Mutex, MutexGuard};

use arrow::array::{ArrayRef, AsArray, Int64Array};
use arrow::datatypes::{DataType, Field, Int64Type, Schema, SchemaRef};
use arrow::record_batch::RecordBatch;
use workhouse_core::exec::join::{HashJoinProbe, JoinHashTable, NestedLoopJoin, joined_schema};
use workhouse_core::exec::memory;
use workhouse_core::exec::pipeline::Operator;
use workhouse_core::expr::Operator as Op;
use workhouse_core::logical::JoinType;
use workhouse_core::physical::expr::PhysExpr;

static LOCK: Mutex<()> = Mutex::new(());

fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Columns: k (join key), v (filter value), id. Some k and v are NULL.
fn side(prefix: &str, rows: usize, keys: i64, seed: u64) -> (SchemaRef, RecordBatch) {
    let mut s = seed;
    let mut next = move || {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        s >> 33
    };
    let k: Vec<Option<i64>> = (0..rows).map(|_| (next() % 40 != 0).then(|| (next() % keys as u64) as i64)).collect();
    let v: Vec<Option<i64>> = (0..rows).map(|_| (next() % 25 != 0).then(|| (next() % 1000) as i64)).collect();
    let id: Vec<Option<i64>> = (0..rows as i64).map(Some).collect();
    let schema = Arc::new(Schema::new(vec![
        Field::new(format!("{prefix}k"), DataType::Int64, true),
        Field::new(format!("{prefix}v"), DataType::Int64, true),
        Field::new(format!("{prefix}id"), DataType::Int64, true),
    ]));
    let cols: Vec<ArrayRef> = [k, v, id].into_iter().map(|c| Arc::new(Int64Array::from(c)) as ArrayRef).collect();
    (schema.clone(), RecordBatch::try_new(schema, cols).unwrap())
}

fn column(index: usize, name: &str) -> PhysExpr {
    PhysExpr::Column { index, name: name.into(), dt: DataType::Int64 }
}

/// probe.v < build.v over the joined columns [pk, pv, pid, bk, bv, bid]
fn less() -> PhysExpr {
    PhysExpr::Binary { left: Box::new(column(1, "pv")), op: Op::Lt, right: Box::new(column(4, "bv")), dt: DataType::Boolean }
}

fn cols(b: &RecordBatch, i: usize) -> Vec<Option<i64>> {
    b.column(i).as_primitive::<Int64Type>().iter().collect()
}

/// The oracle: (probe row, build row) pairs that join.
fn pairs(probe: &RecordBatch, build: &RecordBatch, keyed: bool, filtered: bool) -> Vec<(usize, usize)> {
    let (pk, pv) = (cols(probe, 0), cols(probe, 1));
    let (bk, bv) = (cols(build, 0), cols(build, 1));
    let mut out = vec![];
    for i in 0..probe.num_rows() {
        for j in 0..build.num_rows() {
            let key_ok = !keyed || (pk[i].is_some() && pk[i] == bk[j]);
            let filter_ok = !filtered || matches!((pv[i], bv[j]), (Some(a), Some(b)) if a < b);
            if key_ok && filter_ok {
                out.push((i, j));
            }
        }
    }
    out
}

/// The expected rows as `probe id|build id` (`-` for NULL), sorted.
fn expected(probe: &RecordBatch, build: &RecordBatch, t: JoinType, keyed: bool, filtered: bool) -> Vec<String> {
    let ps = pairs(probe, build, keyed, filtered);
    let mut pm = vec![false; probe.num_rows()];
    let mut bm = vec![false; build.num_rows()];
    for &(i, j) in &ps {
        pm[i] = true;
        bm[j] = true;
    }
    let fmt = |a: Option<usize>, b: Option<usize>| {
        let f = |x: Option<usize>| x.map_or("-".to_string(), |x| x.to_string());
        format!("{}|{}", f(a), f(b))
    };
    let mut out: Vec<String> = vec![];
    let with_pairs = matches!(t, JoinType::Inner | JoinType::Left | JoinType::Right | JoinType::Full);
    if with_pairs {
        out.extend(ps.iter().map(|&(i, j)| fmt(Some(i), Some(j))));
    }
    if matches!(t, JoinType::Left | JoinType::Full) {
        out.extend((0..pm.len()).filter(|&i| !pm[i]).map(|i| fmt(Some(i), None)));
    }
    if matches!(t, JoinType::Right | JoinType::Full) {
        out.extend((0..bm.len()).filter(|&j| !bm[j]).map(|j| fmt(None, Some(j))));
    }
    if t == JoinType::Semi {
        out.extend((0..pm.len()).filter(|&i| pm[i]).map(|i| i.to_string()));
    }
    if t == JoinType::Anti {
        out.extend((0..pm.len()).filter(|&i| !pm[i]).map(|i| i.to_string()));
    }
    out.sort();
    out
}

/// Rows of the batches in the same format; also the largest batch.
fn rows_of(batches: &[RecordBatch], t: JoinType) -> (Vec<String>, usize) {
    let mut out = vec![];
    for b in batches {
        let id = |i: usize| cols(b, i);
        if matches!(t, JoinType::Semi | JoinType::Anti) {
            out.extend(id(2).iter().map(|x| x.unwrap().to_string()));
        } else {
            let f = |x: Option<i64>| x.map_or("-".to_string(), |x| x.to_string());
            out.extend(id(2).iter().zip(id(5)).map(|(a, b)| format!("{}|{}", f(*a), f(b))));
        }
    }
    out.sort();
    (out, batches.iter().map(|b| b.num_rows()).max().unwrap_or(0))
}

fn split(b: &RecordBatch, parts: usize) -> Vec<RecordBatch> {
    let step = b.num_rows().div_ceil(parts);
    (0..b.num_rows()).step_by(step).map(|s| b.slice(s, step.min(b.num_rows() - s))).collect()
}

/// Output schema: probe and build columns, or the probe columns for semi/anti.
fn out_schema(t: JoinType, joined: &SchemaRef, probe: &SchemaRef) -> SchemaRef {
    if matches!(t, JoinType::Semi | JoinType::Anti) { probe.clone() } else { joined.clone() }
}

const ALL: [JoinType; 6] = [JoinType::Inner, JoinType::Left, JoinType::Right, JoinType::Full, JoinType::Semi, JoinType::Anti];

fn run(op: &dyn Operator, probe: &RecordBatch, parts: usize) -> Vec<RecordBatch> {
    let mut out = vec![];
    for b in split(probe, parts) {
        op.execute(b, &mut |o| {
            out.push(o);
            Ok(())
        })
        .unwrap();
    }
    out.extend(op.finish().unwrap());
    out.retain(|b| b.num_rows() > 0);
    out
}

#[test]
fn hash_join_with_a_residual_filter_matches_brute_force() {
    let _g = lock();
    let (ps, probe) = side("p", 3000, 60, 1);
    let (bs, build) = side("b", 2500, 60, 2);
    let joined = joined_schema(&ps, &bs);
    for filtered in [true, false] {
        for t in ALL {
            let table = JoinHashTable::build(build.clone(), vec![build.column(0).clone()], matches!(t, JoinType::Right | JoinType::Full)).unwrap();
            let op = HashJoinProbe {
                table: Arc::new(table),
                probe_keys: vec![column(0, "pk")],
                join_type: t,
                filter: filtered.then(less),
                joined_schema: joined.clone(),
                output_schema: out_schema(t, &joined, &ps),
                order: None,
                mark_only: false,
            };
            let (got, biggest) = rows_of(&run(&op, &probe, 3), t);
            let want = expected(&probe, &build, t, true, filtered);
            assert!(want.len() > 8192 || matches!(t, JoinType::Semi | JoinType::Anti), "{t:?}: pairs span several chunks ({})", want.len());
            assert_eq!(got.len(), want.len(), "{t:?} filtered={filtered}");
            assert_eq!(got, want, "{t:?} filtered={filtered}");
            assert!(biggest <= 8192 || !filtered || !matches!(t, JoinType::Inner), "{t:?}: batch of {biggest} rows");
        }
    }
}

fn nested(build: &RecordBatch, ps: &SchemaRef, bs: &SchemaRef, t: JoinType, filtered: bool) -> NestedLoopJoin {
    let joined = joined_schema(ps, bs);
    NestedLoopJoin {
        build: build.clone(),
        join_type: t,
        filter: filtered.then(less),
        output_schema: out_schema(t, &joined, ps),
        joined_schema: joined,
        order: None,
        memory: None,
    }
}

#[test]
fn nested_loop_join_with_a_build_side_bigger_than_a_chunk() {
    let _g = lock();
    // 40 probe rows against 20k build rows: one probe row per block, the build side in slices
    let (ps, probe) = side("p", 40, 60, 3);
    let (bs, build) = side("b", 20_000, 60, 4);
    for filtered in [true, false] {
        for t in [JoinType::Inner, JoinType::Left, JoinType::Semi, JoinType::Anti] {
            let op = nested(&build, &ps, &bs, t, filtered);
            let (got, biggest) = rows_of(&run(&op, &probe, 2), t);
            assert_eq!(got, expected(&probe, &build, t, false, filtered), "{t:?} filtered={filtered}");
            if t == JoinType::Inner {
                assert!(biggest <= 8192, "output batches stay near one chunk, got {biggest}");
            }
        }
    }
}

#[test]
fn nested_loop_join_with_many_probe_rows_per_block() {
    let _g = lock();
    let (ps, probe) = side("p", 700, 60, 5);
    for build_rows in [1, 7, 300, 8192, 8193] {
        let (bs, build) = side("b", build_rows, 60, 6);
        for t in [JoinType::Inner, JoinType::Left, JoinType::Semi, JoinType::Anti] {
            let op = nested(&build, &ps, &bs, t, true);
            let (got, biggest) = rows_of(&run(&op, &probe, 2), t);
            assert_eq!(got, expected(&probe, &build, t, false, true), "{t:?} build={build_rows}");
            if t == JoinType::Inner {
                assert!(biggest <= 8192, "build={build_rows}: batch of {biggest} rows");
            }
        }
    }
}

#[test]
fn nested_loop_join_with_an_empty_build_side() {
    let _g = lock();
    let (ps, probe) = side("p", 50, 60, 7);
    let (bs, build) = side("b", 0, 60, 8);
    for t in [JoinType::Inner, JoinType::Left, JoinType::Semi, JoinType::Anti] {
        for filtered in [true, false] {
            let op = nested(&build, &ps, &bs, t, filtered);
            assert_eq!(rows_of(&run(&op, &probe, 1), t).0, expected(&probe, &build, t, false, filtered), "{t:?}");
        }
    }
}

#[test]
fn nested_loop_join_build_side_over_the_memory_limit_is_an_error() {
    let _g = lock();
    let (ps, probe) = side("p", 10, 60, 9);
    let (bs, build) = side("b", 20_000, 60, 10);
    let pool = memory::pool();
    pool.set_limit(100_000);
    let r = NestedLoopJoin::reserve_build(&build).map(|_| ());
    pool.set_limit(usize::MAX);
    let e = r.unwrap_err().to_string();
    assert!(e.contains("memory limit"), "{e}");
    // and it runs without the limit, holding the build side while it lives
    let held = NestedLoopJoin::reserve_build(&build).unwrap();
    assert!(held.size() > 0);
    let op = NestedLoopJoin { memory: Some(held), ..nested(&build, &ps, &bs, JoinType::Inner, true) };
    op.execute(probe, &mut |_| Ok(())).unwrap();
}
