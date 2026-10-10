//! Writing a Hive-partitioned dataset: the rows of each partition go to
//! `root/key=value/.../part-<id>.parquet`, without the partition columns
//! (their values are in the folder names, where readers find them again).

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
use crate::io::options::StorageOptions;
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
    writers: HashMap<String, ParquetSink>,
}

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
        })
    }

    /// The folder (`k=v/k2=v2`) of each row.
    fn folders(&self, batch: &RecordBatch) -> Result<Vec<String>> {
        let names: Vec<&String> = self.keys.iter().map(|&k| batch.schema_ref().field(k).name()).collect();
        let cols: Vec<&Arc<dyn Array>> = self.keys.iter().map(|&k| batch.column(k)).collect();
        (0..batch.num_rows())
            .map(|row| {
                let parts = names.iter().zip(&cols).map(|(name, col)| {
                    let v = if col.is_null(row) { NULL_PARTITION.to_string() } else { escape(&array_value_to_string(col, row)?) };
                    Ok(format!("{name}={v}"))
                });
                Ok(parts.collect::<Result<Vec<_>>>()?.join("/"))
            })
            .collect()
    }

    pub fn write(&mut self, batch: &RecordBatch) -> Result<()> {
        let mut groups: HashMap<String, Vec<u32>> = HashMap::new();
        for (row, folder) in self.folders(batch)?.into_iter().enumerate() {
            groups.entry(folder).or_default().push(row as u32);
        }
        let data = batch.project(&self.data)?;
        for (folder, rows) in groups {
            let part = take_record_batch(&data, &UInt32Array::from(rows))?;
            if !self.writers.contains_key(&folder) {
                if self.writers.len() >= MAX_PARTITIONS {
                    return Err(WhError::Execution(format!("more than {MAX_PARTITIONS} partitions: partition by fewer or coarser columns")));
                }
                let path = format!("{}/{folder}/{}", self.root, self.file_name);
                let sink = ParquetSink::create(&path, self.data_schema.clone(), &self.compression, self.row_group_size, &self.storage)?;
                self.writers.insert(folder.clone(), sink);
            }
            self.writers.get_mut(&folder).expect("opened").write(&part)?;
        }
        Ok(())
    }

    /// Close every file; returns the partitions written.
    pub fn finish(self) -> Result<usize> {
        let n = self.writers.len();
        for (_, w) in self.writers {
            w.finish()?;
        }
        Ok(n)
    }
}
