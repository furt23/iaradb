//! Packed multi-column keys: large tables move to them keeping their ids,
//! every row maps to the id of its key, emitted keys round-trip (types,
//! NULLs), and a NULL with no bit in the key falls back to column ids.

use std::collections::HashMap;
use std::sync::Arc;

use super::*;

const N: usize = 200_000;

/// `(i64, string, i16)` keys: `distinct` of them, each row `i` is key `i % distinct`.
fn batch(rows: std::ops::Range<usize>, distinct: usize, null_every: Option<usize>) -> Vec<ArrayRef> {
    let k = |i: usize| i % distinct;
    let a: Int64Array = rows.clone().map(|i| (null_every.is_none_or(|e| k(i) % e != 0)).then_some(k(i) as i64 * 7 - 3)).collect();
    let b: StringViewArray = rows.clone().map(|i| Some(if k(i) % 3 == 0 { format!("s{}", k(i) % 50) } else { format!("a longer string {}", k(i) % 1000) })).collect();
    let c: Int16Array = rows.map(|i| Some((k(i) % 300) as i16 - 150)).collect();
    vec![Arc::new(a), Arc::new(b), Arc::new(c)]
}

fn row_key(cols: &[ArrayRef], i: usize) -> String {
    cols.iter().map(|c| arrow::util::display::array_value_to_string(c, i).unwrap()).collect::<Vec<_>>().join("|")
}

/// Intern `batches` and check: equal keys share an id, ids are dense, and
/// the emitted keys are the rows' keys.
fn check(keys: &mut GroupKeys, batches: &[Vec<ArrayRef>]) {
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
    for (k, id) in seen {
        assert_eq!(row_key(&out, id as usize), k);
    }
}

#[test]
fn large_tables_move_to_packed_keys() {
    let types = [DataType::Int64, DataType::Utf8View, DataType::Int16];
    let mut keys = GroupKeys::try_new(&types).unwrap();
    let batches = vec![batch(0..50_000, N, Some(97)), batch(50_000..250_000, N, Some(97)), batch(250_000..400_000, N, Some(97))];
    check(&mut keys, &batches);
    assert!(matches!(keys.composite, Some(Composite::Packed(_))), "{} groups", keys.len());
    assert!(keys.emit().unwrap()[0].null_count() > 0);
}

#[test]
fn small_tables_keep_column_ids() {
    let types = [DataType::Int64, DataType::Utf8View, DataType::Int16];
    let mut keys = GroupKeys::try_new(&types).unwrap();
    check(&mut keys, &[batch(0..10_000, 500, None)]);
    assert!(!matches!(keys.composite, Some(Composite::Packed(_))));
}

#[test]
fn a_null_without_a_bit_falls_back_to_column_ids() {
    // two i64 and a decimal fill four words: no room for NULL bits
    let types = [DataType::Int64, DataType::Int64, DataType::Decimal128(15, 2)];
    let cols = |rows: std::ops::Range<usize>, nulls: bool| -> Vec<ArrayRef> {
        let a: Int64Array = rows.clone().map(|i| (!nulls || i % 5 != 0).then_some(i as i64 % 90_000)).collect();
        let b: Int64Array = rows.clone().map(|i| Some(-(i as i64 % 70_001))).collect();
        let d = Decimal128Array::from_iter(rows.map(|i| Some(i as i128 % 13))).with_precision_and_scale(15, 2).unwrap();
        vec![Arc::new(a), Arc::new(b), Arc::new(d)]
    };
    let mut keys = GroupKeys::try_new(&types).unwrap();
    // dependent mode fails (b is not a function of a), then column ids, then packed
    check(&mut keys, &[cols(0..150_000, false), cols(150_000..300_000, true), cols(0..1000, true)]);
    assert!(!matches!(keys.composite, Some(Composite::Packed(_))));
    assert_eq!(keys.emit().unwrap()[2].data_type(), &DataType::Decimal128(15, 2));
}

#[test]
fn value_types_round_trip() {
    let types = [
        DataType::Float64,
        DataType::Boolean,
        DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
        DataType::Date32,
        DataType::UInt8,
    ];
    let n = 100_000;
    let f: Float64Array = (0..n).map(|i| Some(if i % 1000 == 0 { -0.0 } else { (i % 70_000) as f64 * 0.5 })).collect();
    let b: BooleanArray = (0..n).map(|i| (i % 11 != 0).then_some(i % 2 == 0)).collect();
    let t = TimestampMicrosecondArray::from_iter((0..n).map(|i| Some(i as i64 % 3 * 1_000_000))).with_timezone("UTC");
    let d: Date32Array = (0..n).map(|i| Some((i % 4) as i32 - 2)).collect();
    let u: UInt8Array = (0..n).map(|i| Some((i % 256) as u8)).collect();
    let cols: Vec<ArrayRef> = vec![Arc::new(f), Arc::new(b), Arc::new(t), Arc::new(d), Arc::new(u)];
    let mut keys = GroupKeys::try_new(&types).unwrap();
    let mut ids = vec![];
    keys.intern(&cols, &mut ids).unwrap();
    keys.intern(&cols, &mut ids).unwrap();
    assert!(matches!(keys.composite, Some(Composite::Packed(_))));
    let out = keys.emit().unwrap();
    for (o, t) in out.iter().zip(&types) {
        assert_eq!(o.data_type(), t);
    }
    // -0.0 and 0.0 are one value
    let zero = (0..n).find(|&i| i % 1000 == 0 && i % 70_000 == 0 && i % 11 != 0).unwrap();
    assert_eq!(out[0].as_primitive::<Float64Type>().value(ids[zero] as usize), 0.0);
    for i in (0..n).step_by(997) {
        if i % 1000 != 0 {
            assert_eq!(row_key(&out, ids[i] as usize), row_key(&cols, i));
        }
    }
}

#[test]
fn masked_rows_get_no_id() {
    let types = [DataType::Int64, DataType::Utf8View, DataType::Int16];
    let mut keys = GroupKeys::try_new(&types).unwrap();
    let mut ids = vec![];
    // NULLs in the lead: no dependent mode
    keys.intern(&batch(0..100_000, N, Some(97)), &mut ids).unwrap();
    assert!(matches!(keys.composite, Some(Composite::Packed(_))));
    let b = batch(100_000..100_010, N, Some(97));
    let mask = arrow::buffer::BooleanBuffer::from_iter((0..10).map(|i| i % 2 == 0));
    keys.intern_masked(&b, &mask, &mut ids).unwrap();
    assert!(ids.iter().enumerate().all(|(i, &id)| (i % 2 == 0) == (id != u32::MAX)));
    let out = keys.emit().unwrap();
    for i in (0..10).step_by(2) {
        assert_eq!(row_key(&out, ids[i] as usize), row_key(&b, i));
    }
}
