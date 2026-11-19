//! Keys kept as encoded rows: chosen for wide keys, every supported type
//! round-trips (NULLs, floats' `-0.0` and NaN, long and short strings), a
//! table merges into another by its rows, and the hash kept for each group
//! is the one rows are partitioned by.

use std::collections::HashMap;
use std::sync::Arc;

use super::*;

/// A row's key as text, floats canonical (`-0.0` is `0.0`, every NaN one value).
fn row_key(cols: &[ArrayRef], i: usize) -> String {
    cols.iter()
        .map(|c| {
            if c.is_null(i) {
                return "<null>".to_string();
            }
            let text = arrow::util::display::array_value_to_string(c, i).unwrap();
            match c.data_type() {
                DataType::Float32 | DataType::Float64 => text.strip_prefix('-').filter(|t| *t == "0" || *t == "0.0").map_or(text.clone(), str::to_string),
                _ => text,
            }
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// Intern `batches`, check that equal keys share an id and ids are dense, and
/// that the emitted keys are the rows' keys, of the key types.
fn check(keys: &mut GroupKeys, types: &[DataType], batches: &[Vec<ArrayRef>]) -> Vec<ArrayRef> {
    let mut seen: HashMap<String, u32> = HashMap::new();
    let mut ids = vec![];
    for b in batches {
        keys.intern(b, &mut ids).unwrap();
        for (i, &id) in ids.iter().enumerate() {
            let k = row_key(b, i);
            assert_eq!(*seen.entry(k.clone()).or_insert(id), id, "{k}");
        }
    }
    assert_eq!(keys.len(), seen.len());
    let out = keys.emit().unwrap();
    for (o, t) in out.iter().zip(types) {
        assert_eq!(o.data_type(), t);
        assert_eq!(o.len(), seen.len());
    }
    for (k, id) in seen {
        assert_eq!(row_key(&out, id as usize), k);
    }
    out
}

fn is_rows(keys: &GroupKeys) -> bool {
    keys.dep.is_none() && matches!(keys.composite, Some(Composite::Rows(_)))
}

/// The form keys of these types take once no column turns out to be one the others depend on.
fn without_lead(types: &[DataType]) -> GroupKeys {
    let mut keys = GroupKeys::try_new(types).unwrap();
    keys.candidates.clear();
    keys.next_mode().unwrap();
    keys
}

/// One column of every type rows keep, `n` rows, `distinct` keys; every seventh
/// value of most columns NULL.
fn every_type(rows: std::ops::Range<usize>, distinct: usize) -> (Vec<DataType>, Vec<ArrayRef>) {
    let k = |i: usize| i % distinct;
    let null = |i: usize| k(i) % 7 == 3;
    let ints = |f: fn(usize) -> i64| -> Vec<Option<i64>> { rows.clone().map(|i| (!null(i)).then(|| f(k(i)))).collect() };
    let text = |i: usize| -> Option<String> {
        (!null(i)).then(|| match k(i) % 4 {
            0 => String::new(),
            1 => "é".to_string(),
            2 => format!("v{}", k(i) % 9),
            _ => format!("a value longer than twelve bytes {}", k(i) % 5),
        })
    };
    let floats: Vec<Option<f64>> = rows
        .clone()
        .map(|i| match k(i) % 6 {
            0 => Some(-0.0),
            1 => Some(0.0),
            2 => Some(f64::NAN),
            3 => None,
            m => Some(m as f64 * -1.5),
        })
        .collect();
    let small = ints(|v| (v % 5) as i64 - 2);
    let cols: Vec<ArrayRef> = vec![
        Arc::new(BooleanArray::from_iter(rows.clone().map(|i| (!null(i)).then_some(k(i) % 2 == 0)))),
        Arc::new(Int8Array::from_iter(small.iter().map(|v| v.map(|v| v as i8)))),
        Arc::new(UInt16Array::from_iter(small.iter().map(|v| v.map(|v| (v + 2) as u16)))),
        Arc::new(Int32Array::from_iter(small.iter().map(|v| v.map(|v| v as i32 * 1000)))),
        Arc::new(UInt64Array::from_iter(ints(|v| (v % 3) as i64).into_iter().map(|v| v.map(|v| u64::MAX - v as u64)))),
        Arc::new(Int64Array::from(ints(|v| (v % 4) as i64 - 1))),
        Arc::new(Float32Array::from_iter(floats.iter().map(|v| v.map(|v| v as f32)))),
        Arc::new(Float64Array::from(floats.clone())),
        Arc::new(Date32Array::from_iter(small.iter().map(|v| v.map(|v| v as i32 + 19_000)))),
        Arc::new(TimestampMicrosecondArray::from(ints(|v| (v % 3) as i64 * 1_000_001)).with_timezone("UTC")),
        Arc::new(Decimal128Array::from_iter(small.iter().map(|v| v.map(|v| v as i128 * 12_345))).with_precision_and_scale(20, 3).unwrap()),
        Arc::new(StringArray::from_iter(rows.clone().map(text))),
        Arc::new(LargeStringArray::from_iter(rows.clone().map(|i| text(i + 1)))),
        Arc::new(StringViewArray::from_iter(rows.clone().map(|i| text(i + 2)))),
        Arc::new(BinaryArray::from_iter(rows.clone().map(|i| text(i + 3).map(String::into_bytes)))),
        Arc::new(BinaryViewArray::from_iter(rows.clone().map(|i| text(i).map(String::into_bytes)))),
    ];
    let types = cols.iter().map(|c| c.data_type().clone()).collect();
    (types, cols)
}

#[test]
fn wide_keys_are_rows_and_packable_ones_are_not() {
    let wide: Vec<DataType> = (0..12).map(|j| if j % 2 == 0 { DataType::Utf8 } else { DataType::Int64 }).collect();
    let mut keys = GroupKeys::try_new(&wide).unwrap();
    let cols: Vec<ArrayRef> = (0..12)
        .map(|j| -> ArrayRef {
            if j % 2 == 0 { Arc::new(StringArray::from_iter_values((0..5000).map(|i| format!("s{}", (i * (j + 1)) % 7)))) } else { Arc::new(Int64Array::from_iter_values((0..5000).map(|i| (i * j) as i64 % 5))) }
        })
        .collect();
    check(&mut keys, &wide, &[cols]);
    assert!(is_rows(&keys), "after the dependent mode fails");
    // three strings: no value to pack
    let strings = [DataType::Utf8View, DataType::Utf8View, DataType::Utf8View];
    assert!(matches!(without_lead(&strings).composite, Some(Composite::Rows(_))));
    // keys that fit four words stay column ids, to be packed
    let packable = [DataType::Int64, DataType::Utf8View, DataType::Int16];
    assert!(matches!(without_lead(&packable).composite, Some(Composite::Many { .. })));
    // two columns keep their pairs of ids; a type rows do not keep, its column ids
    assert!(matches!(without_lead(&strings[..2]).composite, Some(Composite::Two { .. })));
    let list = DataType::List(Arc::new(arrow::datatypes::Field::new("item", DataType::Int64, true)));
    assert!(matches!(without_lead(&[DataType::Utf8, DataType::Utf8, list]).composite, Some(Composite::Many { .. })));
}

#[test]
fn every_type_round_trips() {
    let (types, cols) = every_type(0..20_000, 3_000);
    let mut keys = GroupKeys::try_new(&types).unwrap();
    let (_, more) = every_type(20_000..30_000, 3_000);
    let out = check(&mut keys, &types, &[cols, more]);
    assert!(is_rows(&keys));
    // -0.0 is 0.0, every NaN one group, NULL a group apart from the empty string
    let floats = out[7].as_primitive::<Float64Type>();
    let zeros = (0..floats.len()).filter(|&g| floats.is_valid(g) && floats.value(g) == 0.0).count();
    let nans = (0..floats.len()).filter(|&g| floats.is_valid(g) && floats.value(g).is_nan()).count();
    assert!(zeros > 0 && nans > 0);
    assert!(floats.iter().flatten().all(|v| !(v == 0.0 && v.is_sign_negative())));
    let strings = out[11].as_string::<i32>();
    assert!(strings.iter().any(|s| s == Some("")) && strings.null_count() > 0);
}

#[test]
fn a_table_merges_into_another_by_its_rows() {
    let (types, cols) = every_type(0..20_000, 5_000);
    let mut a = GroupKeys::try_new(&types).unwrap();
    let mut ids = vec![];
    a.intern(&cols, &mut ids).unwrap();
    let (_, other) = every_type(10_000..40_000, 7_000);
    let mut b = GroupKeys::try_new(&types).unwrap();
    b.intern(&other, &mut ids).unwrap();
    assert!(is_rows(&a) && is_rows(&b));
    // every group of `b`, then some of them out of order
    let mut by_rows = GroupKeys::try_new(&types).unwrap();
    let mut by_keys = GroupKeys::try_new(&types).unwrap();
    let (mut x, mut y) = (vec![], vec![]);
    let last = b.len() as u32 - 1;
    for (from, groups) in [(&a, None), (&b, None), (&b, Some(vec![5u32, 1, last, 3, 1]))] {
        by_rows.intern_from(from, groups.as_deref(), &mut x).unwrap();
        let keys = from.emit().unwrap();
        let keys = match &groups {
            Some(g) => keys.iter().map(|k| take(k, &UInt32Array::from(g.clone()), None).unwrap()).collect(),
            None => keys,
        };
        by_keys.intern(&keys, &mut y).unwrap();
        assert_eq!(x, y);
    }
    assert!(is_rows(&by_rows));
    let (r, k) = (by_rows.emit().unwrap(), by_keys.emit().unwrap());
    for g in 0..by_rows.len() {
        assert_eq!(row_key(&r, g), row_key(&k, g));
    }
    // a table that starts empty takes the rows' form at once (no dependent mode to try)
    let ints = [DataType::Int64, DataType::Int64, DataType::Int64, DataType::Int64, DataType::Utf8];
    let wide: Vec<DataType> = ints.iter().chain(&types).cloned().collect();
    let mut fresh = GroupKeys::try_new(&wide).unwrap();
    assert!(fresh.dep.is_some());
    let mut src = GroupKeys::try_new(&wide).unwrap();
    let lead: Vec<ArrayRef> = (0..4).map(|j| Arc::new(Int64Array::from_iter_values((0..20_000).map(move |i| (i % (3 + j)) as i64))) as ArrayRef).collect();
    let mut all = lead;
    all.push(Arc::new(StringArray::from_iter_values((0..20_000).map(|i| format!("{}", i % 11)))));
    all.extend(cols.iter().cloned());
    src.intern(&all, &mut ids).unwrap();
    fresh.intern_from(&src, None, &mut x).unwrap();
    assert!(is_rows(&fresh) && x.iter().enumerate().all(|(i, &g)| g as usize == i));
}

#[test]
fn the_kept_hash_is_the_hash_of_the_emitted_keys() {
    let (types, cols) = every_type(0..20_000, 4_000);
    let mut keys = GroupKeys::try_new(&types).unwrap();
    let mut ids = vec![];
    keys.intern(&cols, &mut ids).unwrap();
    let kept = keys.hashes().expect("rows keep their hashes").to_vec();
    let mut hashes = vec![];
    crate::hash::hash_columns(&keys.emit().unwrap(), &mut hashes).unwrap();
    assert_eq!(kept, hashes);
    // and of the rows they came from (`-0.0` hashes as `0.0`)
    crate::hash::hash_columns(&cols, &mut hashes).unwrap();
    assert!(ids.iter().zip(&hashes).all(|(&g, &h)| kept[g as usize] == h));
}

#[test]
fn masked_rows_get_no_id() {
    let (types, cols) = every_type(0..1_000, 300);
    let mut keys = GroupKeys::try_new(&types).unwrap();
    let mut ids = vec![];
    keys.intern(&cols, &mut ids).unwrap();
    assert!(is_rows(&keys));
    let before = keys.len();
    let mask = arrow::buffer::BooleanBuffer::from_iter((0..1_000).map(|i| i % 3 == 0));
    let (_, more) = every_type(1_000..2_000, 600);
    keys.intern_masked(&more, &mask, &mut ids).unwrap();
    assert!(ids.iter().enumerate().all(|(i, &id)| (i % 3 == 0) == (id != u32::MAX)));
    let out = keys.emit().unwrap();
    for i in (0..1_000).step_by(3) {
        assert_eq!(row_key(&out, ids[i] as usize), row_key(&more, i));
    }
    assert!(keys.len() > before);
}

#[test]
fn a_column_with_as_many_values_as_groups_partitions_rows() {
    // `a` has a value per group, the other integers few, the strings as many (never a
    // partition column); five 64-bit columns do not fit the packed words: rows
    let n = 5_000;
    let few = |m: i64| -> ArrayRef { Arc::new(Int64Array::from_iter_values((0..n).map(move |i| i as i64 % m))) };
    let cols: Vec<ArrayRef> = vec![
        Arc::new(StringArray::from_iter_values((0..n).map(|i| format!("s{}", i % 3)))),
        Arc::new(Int64Array::from_iter_values((0..n).map(|i| i as i64 * 7))),
        few(5),
        Arc::new(StringArray::from_iter_values((0..n).map(|i| format!("{i}")))),
        few(3),
        few(7),
        few(2),
    ];
    let types: Vec<DataType> = cols.iter().map(|c| c.data_type().clone()).collect();
    let mut keys = without_lead(&types);
    let mut ids = vec![];
    keys.intern(&cols, &mut ids).unwrap();
    assert!(is_rows(&keys));
    assert_eq!(keys.partition_column(), Some(1));
    // no column of 32 bits or more with enough values
    let some: Vec<ArrayRef> = cols.iter().enumerate().filter(|(j, _)| *j != 1).map(|(_, c)| c.clone()).collect();
    let some_types: Vec<DataType> = some.iter().map(|c| c.data_type().clone()).collect();
    let mut keys = without_lead(&some_types);
    keys.intern(&some, &mut ids).unwrap();
    assert!(is_rows(&keys));
    assert_eq!(keys.partition_column(), None);
}
