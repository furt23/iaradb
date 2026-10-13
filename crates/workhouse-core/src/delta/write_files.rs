//! Writing a query's rows as the data files of a Delta table: Parquet
//! (Snappy) files named `part-<uuid>-c000.snappy.parquet`, in `col=value/`
//! folders for the partition columns (whose values are not stored in the
//! files), with an `add` action for each file.
//!
//! The rows are first conformed to the table's schema, by column name. Types
//! are normalised to what Delta (and so every other reader) knows: see
//! [`delta_type`]. The files only become part of a table when a commit adds
//! them; a [`DataFiles`] that is dropped without [`DataFiles::keep`] deletes
//! them, so a failed query or a lost commit leaves nothing behind.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use arrow::array::{Array, ArrayRef, StringArray, new_null_array};
use arrow::compute::cast;
use arrow::datatypes::{DataType, Field, Schema, SchemaRef, TimeUnit};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use parking_lot::Mutex;

use super::actions::{Add, PartitionValues};
use super::stats::FileStats;
use super::util::new_uuid;
use crate::error::{Result, WhError};
use crate::io::dataset;
use crate::io::options::StorageOptions;
use crate::io::output::WrittenFile;
use crate::io::parquet::{HiveSink, ParquetSink};
use crate::session::LazyFrame;

/// The type Delta stores a column of this Arrow type as. Unsigned integers
/// become the next wider signed one (`UInt64`: `Decimal128(20, 0)`),
/// timestamps microseconds (their zone kept), `Date64` a date, large / view
/// strings and binaries the plain ones, dictionaries their values; lists,
/// structs and maps are converted inside.
pub fn delta_type(dt: &DataType) -> DataType {
    use DataType::*;
    match dt {
        UInt8 => Int16,
        UInt16 => Int32,
        UInt32 => Int64,
        UInt64 => Decimal128(20, 0),
        Float16 => Float32,
        Utf8 | LargeUtf8 | Utf8View => Utf8,
        Binary | LargeBinary | BinaryView | FixedSizeBinary(_) => Binary,
        Date64 => Date32,
        Timestamp(_, tz) => Timestamp(TimeUnit::Microsecond, tz.clone()),
        Dictionary(_, v) => delta_type(v),
        List(f) | LargeList(f) | FixedSizeList(f, _) | ListView(f) | LargeListView(f) => List(delta_field(f)),
        Struct(fields) => Struct(fields.iter().map(|f| delta_field(f)).collect()),
        Map(entries, sorted) => Map(delta_field(entries), *sorted),
        other => other.clone(),
    }
}

fn delta_field(f: &Arc<Field>) -> Arc<Field> {
    Arc::new(Field::new(f.name(), delta_type(f.data_type()), f.is_nullable()).with_metadata(f.metadata().clone()))
}

/// The schema a table created from a query with this schema gets: the types
/// of [`delta_type`], every column nullable.
pub fn delta_schema(schema: &Schema) -> SchemaRef {
    Arc::new(Schema::new(
        schema.fields().iter().map(|f| Field::new(f.name(), delta_type(f.data_type()), true).with_metadata(f.metadata().clone())).collect::<Vec<_>>(),
    ))
}

/// The schema of a table declared with column definitions: the types of
/// [`delta_type`], the declared nullability (`NOT NULL`) kept.
pub fn delta_schema_declared(schema: &Schema) -> SchemaRef {
    Arc::new(Schema::new(
        schema.fields().iter().map(|f| Field::new(f.name(), delta_type(f.data_type()), f.is_nullable()).with_metadata(f.metadata().clone())).collect::<Vec<_>>(),
    ))
}

/// Whether a column of this type can partition a table (Delta partitions by primitive types only).
fn partitionable(dt: &DataType) -> bool {
    use DataType::*;
    matches!(
        dt,
        Utf8 | Boolean | Int8 | Int16 | Int32 | Int64 | Float32 | Float64 | Date32 | Timestamp(_, _) | Decimal128(_, _)
    )
}

/// Check the partition columns against the table schema.
pub fn check_partition_columns(schema: &Schema, partition_by: &[String]) -> Result<()> {
    let mut seen = HashSet::new();
    for c in partition_by {
        let field = schema.field_with_name(c).map_err(|_| WhError::Plan(format!("cannot partition by '{c}': no such column")))?;
        if !partitionable(field.data_type()) {
            return Err(WhError::Plan(format!("cannot partition by '{c}': a column of type {} is not a Delta partition type", field.data_type())));
        }
        if !seen.insert(c.as_str()) {
            return Err(WhError::Plan(format!("partition column '{c}' is listed twice")));
        }
    }
    if !partition_by.is_empty() && partition_by.len() >= schema.fields().len() {
        return Err(WhError::Plan("every column is a partition column: nothing left to write in the files".into()));
    }
    Ok(())
}

/// The files of a write and the actions that add them.
pub struct DataFiles {
    pub adds: Vec<Add>,
    pub rows: u64,
    /// every file written (full paths or URLs), to delete if they are not kept
    paths: Vec<String>,
    storage: StorageOptions,
    keep: bool,
}

impl DataFiles {
    fn new(storage: &StorageOptions) -> DataFiles {
        DataFiles { adds: vec![], rows: 0, paths: vec![], storage: storage.clone(), keep: false }
    }

    /// No files (a table created from a schema).
    pub fn empty(storage: &StorageOptions) -> DataFiles {
        DataFiles::new(storage)
    }

    /// The commit succeeded: the files belong to the table now.
    pub fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for DataFiles {
    fn drop(&mut self) {
        if self.keep || self.paths.is_empty() {
            return;
        }
        let _ = dataset::remove_files(&self.paths, &self.storage);
        for p in &self.paths {
            remove_empty_parents(p);
        }
    }
}

/// Remove the partition folders (`col=value`) a deleted local file leaves empty, innermost first.
fn remove_empty_parents(path: &str) {
    let mut dir = std::path::Path::new(path).parent();
    while let Some(d) = dir {
        if !d.file_name().is_some_and(|n| n.to_string_lossy().contains('=')) || std::fs::remove_dir(d).is_err() {
            return;
        }
        dir = d.parent();
    }
}

/// A timestamp partition column as Delta writes its values: `2024-01-01 00:00:00[.ffffff]` in UTC.
fn timestamp_text(array: &ArrayRef) -> Result<ArrayRef> {
    let utc = cast(array, &DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())))?;
    let naive = cast(&utc, &DataType::Timestamp(TimeUnit::Microsecond, None))?;
    let text = cast(&naive, &DataType::Utf8)?;
    let text = text.as_any().downcast_ref::<StringArray>().expect("a string array");
    let spaced: StringArray = text.iter().map(|v| v.map(|s| s.replacen('T', " ", 1))).collect();
    Ok(Arc::new(spaced))
}

/// Rows of the query as rows of the table.
struct Conform {
    /// the query column each table column comes from (`None`: nulls)
    sources: Vec<Option<usize>>,
    target: SchemaRef,
    /// the schema the sinks get: timestamp partition columns as text
    sink_schema: SchemaRef,
    /// indexes of table columns written as text
    as_text: Vec<usize>,
}

impl Conform {
    fn new(query: &Schema, target: &SchemaRef, partition_by: &[String]) -> Result<Conform> {
        let find = |name: &str| query.index_of(name).ok().or_else(|| query.fields().iter().position(|f| f.name().eq_ignore_ascii_case(name)));
        let mut used = HashSet::new();
        let mut sources = vec![];
        for f in target.fields() {
            let src = find(f.name());
            match src {
                Some(i) => {
                    if !arrow::compute::can_cast_types(query.field(i).data_type(), f.data_type()) {
                        return Err(WhError::Plan(format!(
                            "column '{}': cannot write {} into a column of type {}",
                            f.name(),
                            query.field(i).data_type(),
                            f.data_type()
                        )));
                    }
                    used.insert(i);
                }
                None if !f.is_nullable() => return Err(WhError::Plan(format!("the query has no value for the required column '{}'", f.name()))),
                None => {}
            }
            sources.push(src);
        }
        if let Some(extra) = query.fields().iter().enumerate().find(|(i, _)| !used.contains(i)) {
            return Err(WhError::Plan(format!("column '{}' is not in the table (pass merge_schema to add it)", extra.1.name())));
        }
        let as_text: Vec<usize> = partition_by
            .iter()
            .filter_map(|p| target.index_of(p).ok())
            .filter(|i| matches!(target.field(*i).data_type(), DataType::Timestamp(_, _)))
            .collect();
        let sink_schema = Arc::new(Schema::new(
            target
                .fields()
                .iter()
                .enumerate()
                .map(|(i, f)| if as_text.contains(&i) { Field::new(f.name(), DataType::Utf8, true) } else { f.as_ref().clone() })
                .collect::<Vec<_>>(),
        ));
        Ok(Conform { sources, target: target.clone(), sink_schema, as_text })
    }

    fn apply(&self, batch: &RecordBatch) -> Result<RecordBatch> {
        let n = batch.num_rows();
        let mut columns = Vec::with_capacity(self.sources.len());
        for (i, (src, field)) in self.sources.iter().zip(self.target.fields()).enumerate() {
            let col = match src {
                Some(s) => cast(batch.column(*s), field.data_type())?,
                None => new_null_array(field.data_type(), n),
            };
            if !field.is_nullable() && col.null_count() > 0 {
                return Err(WhError::Execution(format!(
                    "NOT NULL constraint violated: column '{}' does not accept NULL, but the rows written have {} of them",
                    field.name(),
                    col.null_count()
                )));
            }
            columns.push(if self.as_text.contains(&i) { timestamp_text(&col)? } else { col });
        }
        let opts = RecordBatchOptions::new().with_row_count(Some(n));
        RecordBatch::try_new_with_options(self.sink_schema.clone(), columns, &opts).map_err(|e| {
            WhError::Execution(format!("the rows do not fit the table schema (a null in a required column?): {e}"))
        })
    }
}

enum Sink {
    File(ParquetSink),
    Hive(HiveSink),
}

struct Running {
    sink: Sink,
    conform: Conform,
}

/// Write the rows of `lf`, conformed to `target` (the table's full schema, partition columns included).
/// `root` is the table location; the files are written below it.
pub fn write_data_files(lf: &LazyFrame, root: &str, storage: &StorageOptions, partition_by: &[String], target: &SchemaRef) -> Result<DataFiles> {
    check_partition_columns(target, partition_by)?;
    let root = root.trim_end_matches(['/', '\\']).to_string();
    let name = format!("part-{}-c000.snappy.parquet", new_uuid());
    let running = Mutex::new(None::<Running>);
    lf.stream(
        &mut |query| {
            let conform = Conform::new(query, target, partition_by)?;
            let sink = if partition_by.is_empty() {
                Sink::File(ParquetSink::create(&format!("{root}/{name}"), conform.sink_schema.clone(), "snappy", None, storage)?)
            } else {
                Sink::Hive(HiveSink::create(&root, conform.sink_schema.clone(), partition_by, "snappy", None, storage)?.with_file_name(name.clone()))
            };
            *running.lock() = Some(Running { sink, conform });
            Ok(())
        },
        &mut |b| {
            let mut guard = running.lock();
            let r = guard.as_mut().expect("writer");
            let batch = r.conform.apply(&b)?;
            match &mut r.sink {
                Sink::File(sink) => sink.write(&batch),
                Sink::Hive(sink) => sink.write(&batch),
            }
        },
    )?;
    let finished = match running.into_inner().expect("writer").sink {
        Sink::File(sink) => vec![sink.finish()?],
        Sink::Hive(sink) => sink.finish()?,
    };
    let mut files = DataFiles::new(storage);
    // listed first: from here on a failure deletes the files
    files.paths = finished.iter().map(|f| f.path.clone()).collect();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let prefix = format!("{root}/");
    for f in finished {
        if f.rows == 0 {
            // an empty file adds nothing (it is deleted with the others if the write is not kept)
            continue;
        }
        files.rows += f.rows;
        files.adds.push(add_of(&f, &prefix, now)?);
    }
    Ok(files)
}

fn add_of(f: &WrittenFile, prefix: &str, now: i64) -> Result<Add> {
    let relative = f.path.strip_prefix(prefix).ok_or_else(|| WhError::Execution(format!("the file '{}' is not under the table '{prefix}'", f.path)))?;
    // an empty partition value is a null one
    let partition_values: PartitionValues = f.partition_values.iter().map(|(k, v)| (k.clone(), v.clone().filter(|v| !v.is_empty()))).collect::<BTreeMap<_, _>>();
    let stats = f.metadata.as_ref().map(|m| FileStats::from_parquet(m).to_json());
    Ok(Add::new(relative, partition_values, f.size as i64, now, stats))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_become_what_delta_knows() {
        use DataType::*;
        assert_eq!(delta_type(&UInt8), Int16);
        assert_eq!(delta_type(&UInt32), Int64);
        assert_eq!(delta_type(&UInt64), Decimal128(20, 0));
        assert_eq!(delta_type(&LargeUtf8), Utf8);
        assert_eq!(delta_type(&Timestamp(TimeUnit::Nanosecond, Some("UTC".into()))), Timestamp(TimeUnit::Microsecond, Some("UTC".into())));
        let nested = List(Arc::new(Field::new("item", UInt16, true)));
        assert_eq!(delta_type(&nested), List(Arc::new(Field::new("item", Int32, true))));
    }

    #[test]
    fn timestamp_partitions_are_spaced_utc_text() {
        use arrow::array::TimestampMicrosecondArray;
        let a: ArrayRef = Arc::new(TimestampMicrosecondArray::from(vec![Some(1_700_000_000_123_456), None]));
        let t = timestamp_text(&a).unwrap();
        let t = t.as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!(t.value(0), "2023-11-14 22:13:20.123456");
        assert!(t.is_null(1));
    }
}
