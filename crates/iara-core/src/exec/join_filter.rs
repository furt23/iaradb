//! A hash join's build keys as a filter on the probe side's scan. Once the
//! build side is done, a scan of the probe table decodes the probe key column
//! first and drops the rows whose key is not in the build table; the other
//! columns are decoded for the rest only (see
//! [`crate::io::parquet`]'s late filtering). Only joins that drop probe rows
//! without a match use it. The join still checks every key it gets: the
//! filter must never drop a row that matches.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};

use arrow::array::{ArrayRef, BooleanArray};
use arrow::datatypes::DataType;
use parking_lot::RwLock;

use crate::exec::join::JoinHashTable;

/// Whether a cast from `from` to `to` keeps every value as it is (equal
/// types, or integers into a type that holds their whole range): a column
/// can then be tested against keys compared as `to`.
pub fn value_preserving(from: &DataType, to: &DataType) -> bool {
    use DataType::*;
    fn range(dt: &DataType) -> Option<(i128, i128)> {
        Some(match dt {
            Int8 => (i8::MIN as i128, i8::MAX as i128),
            Int16 => (i16::MIN as i128, i16::MAX as i128),
            Int32 => (i32::MIN as i128, i32::MAX as i128),
            Int64 => (i64::MIN as i128, i64::MAX as i128),
            UInt8 => (0, u8::MAX as i128),
            UInt16 => (0, u16::MAX as i128),
            UInt32 => (0, u32::MAX as i128),
            UInt64 => (0, u64::MAX as i128),
            _ => return None,
        })
    }
    from == to || matches!((range(from), range(to)), (Some((lo, hi)), Some((min, max))) if min <= lo && hi <= max)
}

#[derive(Debug)]
pub struct JoinKeyFilter {
    /// the scanned column and its type: columns of another type are not tested
    column: String,
    column_type: DataType,
    /// the build table, while the join probes with it (re-set at each run of
    /// the join; weak, as the filter outlives the join in the scan)
    table: RwLock<Weak<JoinHashTable>>,
    /// a scan filters with it
    attached: AtomicBool,
}

impl JoinKeyFilter {
    pub fn new(column: &str, column_type: DataType) -> Self {
        Self { column: column.to_string(), column_type, table: RwLock::new(Weak::new()), attached: AtomicBool::new(false) }
    }

    pub fn column(&self) -> &str {
        &self.column
    }

    /// The build side is done: rows are tested against `table` from now on.
    pub fn set(&self, table: &Arc<JoinHashTable>) {
        *self.table.write() = Arc::downgrade(table);
    }

    /// The build side spilled: nothing is tested.
    pub fn clear(&self) {
        *self.table.write() = Weak::new();
    }

    /// Whether a table is set and still alive.
    pub fn is_set(&self) -> bool {
        self.table.read().strong_count() > 0
    }

    /// A scan filters with this.
    pub fn attach(&self) {
        self.attached.store(true, Ordering::Relaxed);
    }

    pub fn attached(&self) -> bool {
        self.attached.load(Ordering::Relaxed)
    }

    /// The rows of `keys` whose key is in the build table (None: all may be).
    pub fn mask(&self, keys: &ArrayRef) -> Option<BooleanArray> {
        if keys.data_type() != &self.column_type {
            return None;
        }
        let table = self.table.read().upgrade()?;
        Some(BooleanArray::new(table.contains(keys)?, None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::{Int32Array, Int64Array};
    use arrow::record_batch::RecordBatch;

    fn table(keys: Vec<Option<i64>>) -> Arc<JoinHashTable> {
        let k: ArrayRef = Arc::new(Int64Array::from(keys));
        let batch = RecordBatch::try_from_iter([("k", k.clone())]).unwrap();
        Arc::new(JoinHashTable::build(batch, vec![k], false).unwrap())
    }

    #[test]
    fn keys_are_tested_while_the_table_lives() {
        let f = JoinKeyFilter::new("k", DataType::Int32);
        let keys: ArrayRef = Arc::new(Int32Array::from(vec![Some(1), Some(2), None, Some(4)]));
        assert!(f.mask(&keys).is_none() && !f.is_set());
        let t = table(vec![Some(2), Some(4), None]);
        f.set(&t);
        assert!(f.is_set());
        let m = f.mask(&keys).unwrap();
        // 2 and 4 are in the table, 1 is not, NULL matches nothing
        assert_eq!(m.iter().map(|v| v.unwrap()).collect::<Vec<_>>(), vec![false, true, false, true]);
        // a column of another type is not tested
        let wide: ArrayRef = Arc::new(Int64Array::from(vec![1]));
        assert!(f.mask(&wide).is_none());
        // a spilled run, and the join being done
        f.clear();
        assert!(f.mask(&keys).is_none());
        f.set(&t);
        drop(t);
        assert!(!f.is_set() && f.mask(&keys).is_none());
    }

    #[test]
    fn only_casts_that_keep_values_pass() {
        use DataType::*;
        assert!(value_preserving(&Int32, &Int32));
        assert!(value_preserving(&Int32, &Int64));
        assert!(value_preserving(&UInt32, &Int64));
        assert!(value_preserving(&Date32, &Date32));
        assert!(!value_preserving(&Int64, &Int32));
        assert!(!value_preserving(&UInt32, &Int32));
        assert!(!value_preserving(&Int32, &UInt32));
        assert!(!value_preserving(&Date32, &Date64));
        assert!(!value_preserving(&Int32, &Float64));
    }
}
