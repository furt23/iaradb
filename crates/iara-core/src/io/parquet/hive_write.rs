//! Writing a Hive-partitioned dataset: the rows of each partition go to
//! `root/key=value/.../part-<id>.parquet`, without the partition columns
//! (their values are in the folder names, where readers find them again).
//!
//! Every file is written under a temporary name and moved into place when
//! the sink finishes. A sink dropped before that removes the files it already
//! completed, so a failed write leaves none of its files behind.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use arrow::array::{Array, UInt32Array};
use arrow::compute::take_record_batch;
use arrow::datatypes::{Schema, SchemaRef};
use arrow::record_batch::RecordBatch;
use arrow::util::display::array_value_to_string;

use super::write::ParquetSink;
use crate::error::{Result, WhError};
use crate::io::dataset;
use crate::io::options::StorageOptions;
use crate::io::output::WrittenFile;
use crate::io::partition::{NULL_PARTITION, escape};

/// Partitions written at once (each holds an open file).
pub const MAX_PARTITIONS: usize = 1024;

pub struct HiveSink {
    root: String,
    /// partition columns of the input
    keys: Vec<usize>,
    /// the other columns, as written to the files
    data: Vec<usize>,
    data_schema: SchemaRef,
    compression: String,
    row_group_size: Option<usize>,
    storage: StorageOptions,
    file_name: String,
    /// the open file of each folder, with the partition values the folder names
    writers: HashMap<String, (ParquetSink, PartitionValues)>,
    /// files already in place (while finishing)
    completed: Vec<WrittenFile>,
    finished: bool,
}

type PartitionValues = Vec<(String, Option<String>)>;

/// A file name no other writer of this process (or, very likely, of another) uses.
pub fn new_file_name() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
    format!("part-{nanos:x}-{}-{}.parquet", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

impl HiveSink {
    pub fn create(root: &str, schema: SchemaRef, partition_by: &[String], compression: &str, row_group_size: Option<usize>, storage: &StorageOptions) -> Result<Self> {
        let keys = partition_by
            .iter()
            .map(|k| schema.index_of(k).map_err(|_| WhError::Plan(format!("cannot partition by '{k}': no such column"))))
            .collect::<Result<Vec<_>>>()?;
        let data: Vec<usize> = (0..schema.fields().len()).filter(|i| !keys.contains(i)).collect();
        if data.is_empty() {
            return Err(WhError::Plan("every column is a partition column: nothing left to write in the files".into()));
        }
        super::write::parse_compression(compression)?;
        Ok(Self {
            root: root.trim_end_matches(['/', '\\']).to_string(),
            data_schema: Arc::new(Schema::new(data.iter().map(|&i| schema.field(i).clone()).collect::<Vec<_>>())),
            keys,
            data,
            compression: compression.to_string(),
            row_group_size,
            storage: storage.clone(),
            file_name: new_file_name(),
            writers: HashMap::new(),
            completed: vec![],
            finished: false,
        })
    }

    /// Name the files `name` (in each partition folder) instead of a generated name.
    pub fn with_file_name(mut self, name: String) -> Self {
        self.file_name = name;
        self
    }

    /// The partition values (None = null) of each row.
    fn partition_values(&self, batch: &RecordBatch) -> Result<Vec<Vec<Option<String>>>> {
        let cols: Vec<&Arc<dyn Array>> = self.keys.iter().map(|&k| batch.column(k)).collect();
        (0..batch.num_rows())
            .map(|row| cols.iter().map(|col| if col.is_null(row) { Ok(None) } else { Ok(Some(array_value_to_string(col, row)?)) }).collect())
            .collect()
    }

    /// The folder (`k=v/k2=v2`) of a row's partition values.
    fn folder(names: &[&String], values: &[Option<String>]) -> String {
        let parts = names.iter().zip(values).map(|(name, v)| format!("{name}={}", v.as_deref().map_or_else(|| NULL_PARTITION.to_string(), escape)));
        parts.collect::<Vec<_>>().join("/")
    }

    pub fn write(&mut self, batch: &RecordBatch) -> Result<()> {
        let names: Vec<&String> = self.keys.iter().map(|&k| batch.schema_ref().field(k).name()).collect();
        let mut groups: HashMap<String, (Vec<u32>, Vec<Option<String>>)> = HashMap::new();
        for (row, values) in self.partition_values(batch)?.into_iter().enumerate() {
            groups.entry(Self::folder(&names, &values)).or_insert_with(|| (vec![], values)).0.push(row as u32);
        }
        let data = batch.project(&self.data)?;
        for (folder, (rows, values)) in groups {
            let part = take_record_batch(&data, &UInt32Array::from(rows))?;
            if !self.writers.contains_key(&folder) {
                if self.writers.len() >= MAX_PARTITIONS {
                    return Err(WhError::Execution(format!("more than {MAX_PARTITIONS} partitions: partition by fewer or coarser columns")));
                }
                let path = format!("{}/{folder}/{}", self.root, self.file_name);
                let sink = ParquetSink::create(&path, self.data_schema.clone(), &self.compression, self.row_group_size, &self.storage)?;
                let values = names.iter().map(|n| n.to_string()).zip(values).collect();
                self.writers.insert(folder.clone(), (sink, values));
            }
            self.writers.get_mut(&folder).expect("opened").0.write(&part)?;
        }
        Ok(())
    }

    /// Close every file and move them into place; returns them, in folder order.
    pub fn finish(mut self) -> Result<Vec<WrittenFile>> {
        let mut writers: Vec<_> = std::mem::take(&mut self.writers).into_iter().collect();
        writers.sort_by(|a, b| a.0.cmp(&b.0));
        for (_, (sink, values)) in writers {
            let mut file = sink.finish()?;
            file.partition_values = values;
            self.completed.push(file);
        }
        self.finished = true;
        Ok(std::mem::take(&mut self.completed))
    }
}

impl Drop for HiveSink {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        // unfinished files delete themselves; take back the ones already in place
        self.writers.clear();
        let done: Vec<String> = self.completed.iter().map(|f| f.path.clone()).collect();
        let _ = dataset::remove_files(&done, &self.storage);
        dataset::prune_empty_dirs(&self.root);
    }
}
