//! Writing Parquet to a local file or an object (multipart upload), all at
//! once or batch by batch as a query produces them.

use std::sync::Arc;

use arrow::datatypes::SchemaRef;
use arrow::record_batch::RecordBatch;
use parquet::arrow::arrow_writer::{ArrowColumnChunk, ArrowLeafColumn, ArrowRowGroupWriterFactory, compute_leaves};
use parquet::arrow::{ArrowSchemaConverter, add_encoded_arrow_schema_to_metadata};
use parquet::file::writer::SerializedFileWriter;
use parquet::schema::types::ColumnPath;
use parquet::basic::{BrotliLevel, Compression, GzipLevel, ZstdLevel};
use parquet::file::properties::WriterProperties;

use crate::error::{Result, WhError};
use crate::io::options::StorageOptions;
use crate::io::output::{Output, WrittenFile};

pub fn parse_compression(s: &str) -> Result<Compression> {
    Ok(match s.to_ascii_lowercase().as_str() {
        "snappy" => Compression::SNAPPY,
        "zstd" => Compression::ZSTD(ZstdLevel::default()),
        "lz4" | "lz4_raw" => Compression::LZ4_RAW,
        "gzip" => Compression::GZIP(GzipLevel::default()),
        "brotli" => Compression::BROTLI(BrotliLevel::default()),
        "none" | "uncompressed" => Compression::UNCOMPRESSED,
        o => return Err(WhError::Plan(format!("unknown compression '{o}'"))),
    })
}

/// Threads that encode row groups. Not the query's pool: a streamed write
/// runs while the query's workers wait for their turn to emit (results keep
/// their order), and those blocked workers could not help encode.
fn encode_pool() -> &'static rayon::ThreadPool {
    static POOL: std::sync::OnceLock<rayon::ThreadPool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(rayon::current_num_threads())
            .thread_name(|i| format!("iara-parquet-{i}"))
            .build()
            .expect("parquet encode pool")
    })
}

/// A Parquet file being written. It appears under its name when
/// [`ParquetSink::finish`] succeeds; dropped before, it leaves nothing.
///
/// Rows are cut into row groups. Full row groups go to a writer thread, which
/// encodes a few per thread at once (every column of each on its own task:
/// encoding and compression are the cost of writing) and appends them to the
/// file in order, while the query goes on producing rows. A bounded queue
/// holds the query back when encoding falls behind.
pub struct ParquetSink {
    rows_per_group: usize,
    /// rows of the row group being filled
    pending: Vec<RecordBatch>,
    pending_rows: usize,
    /// full row groups not yet handed to the writer
    groups: Vec<Vec<RecordBatch>>,
    /// the file, until the writer starts
    start: Option<Pending>,
    queue: Option<std::sync::mpsc::SyncSender<Vec<Vec<RecordBatch>>>>,
    writer: Option<std::thread::JoinHandle<Result<SerializedFileWriter<Output>>>>,
    path: String,
}

/// Row groups encoding at once, per encode thread.
const IN_FLIGHT_PER_THREAD: usize = 2;

/// The writer thread: encode the queued row groups and append them in
/// order. Every column of every row group is a task of its own on the encode
/// pool, and row groups keep arriving while others encode: the pool does not
/// wait for the slowest column of a batch, nor for the appends to the file.
fn write_groups(
    mut writer: SerializedFileWriter<Output>,
    factory: ArrowRowGroupWriterFactory,
    schema: SchemaRef,
    queue: std::sync::mpsc::Receiver<Vec<Vec<RecordBatch>>>,
) -> Result<SerializedFileWriter<Output>> {
    type Done = (usize, usize, Result<ArrowColumnChunk>);
    let (done_tx, done) = std::sync::mpsc::channel::<Done>();
    let max_in_flight = IN_FLIGHT_PER_THREAD * encode_pool().current_num_threads();
    // row groups handed to the pool, the next one to append, and the encoded
    // columns of those in between
    let (mut assigned, mut next) = (0usize, 0usize);
    let mut chunks: std::collections::VecDeque<(Vec<Option<ArrowColumnChunk>>, usize)> = Default::default();
    let mut open = true;
    loop {
        while open && assigned - next < max_in_flight {
            // wait for rows only when nothing is encoding
            let received = if assigned == next {
                queue.recv().ok()
            } else {
                match queue.try_recv() {
                    Ok(g) => Some(g),
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => None,
                }
            };
            let Some(groups) = received else {
                open = false; // the query sent everything
                break;
            };
            for batches in groups {
                let writers = factory.create_column_writers(assigned)?;
                let mut leaves: Vec<Vec<ArrowLeafColumn>> = (0..writers.len()).map(|_| Vec::with_capacity(batches.len())).collect();
                for b in &batches {
                    let mut j = 0;
                    for (field, column) in schema.fields().iter().zip(b.columns()) {
                        for leaf in compute_leaves(field, column)? {
                            leaves[j].push(leaf);
                            j += 1;
                        }
                    }
                }
                chunks.push_back(((0..writers.len()).map(|_| None).collect(), writers.len()));
                for (c, (mut w, leaves)) in writers.into_iter().zip(leaves).enumerate() {
                    let (tx, g) = (done_tx.clone(), assigned);
                    encode_pool().spawn(move || {
                        let r = leaves.iter().try_for_each(|leaf| w.write(leaf)).and_then(|_| w.close());
                        // a closed channel: the write failed and stopped
                        let _ = tx.send((g, c, r.map_err(Into::into)));
                    });
                }
                assigned += 1;
            }
        }
        if assigned == next {
            if open {
                continue;
            }
            break;
        }
        let (g, c, chunk) = done.recv().map_err(|_| WhError::Execution("parquet encoder stopped".into()))?;
        let slot = &mut chunks[g - next];
        slot.0[c] = Some(chunk?);
        slot.1 -= 1;
        while chunks.front().is_some_and(|f| f.1 == 0) {
            let (cols, _) = chunks.pop_front().expect("front");
            let mut rg = writer.next_row_group()?;
            for chunk in cols {
                chunk.expect("encoded").append_to_row_group(&mut rg)?;
            }
            rg.close()?;
            next += 1;
        }
    }
    Ok(writer)
}

/// Rows sampled from the first row group to choose each column's encoding.
const SAMPLE_ROWS: usize = 16 * 1024;
/// A column whose sample is at least this share distinct is not dictionary
/// encoded: the dictionary would fill up and fall back to plain anyway,
/// after the work of building it (ids, prices, free text).
const MOSTLY_DISTINCT: f64 = 0.5;

/// Top-level columns (by index) that are flat and mostly distinct in `sample`.
fn mostly_distinct(schema: &SchemaRef, sample: &[RecordBatch]) -> Vec<usize> {
    let mut out = vec![];
    if sample.is_empty() {
        return out;
    }
    let mut rows = 0;
    let mut take = vec![];
    for b in sample {
        if rows >= SAMPLE_ROWS {
            break;
        }
        let n = b.num_rows().min(SAMPLE_ROWS - rows);
        take.push(b.slice(0, n));
        rows += n;
    }
    if rows < 1024 {
        return out;
    }
    for (i, f) in schema.fields().iter().enumerate() {
        if f.data_type().is_nested() || matches!(f.data_type(), arrow::datatypes::DataType::Boolean | arrow::datatypes::DataType::Null) {
            continue;
        }
        let parts: Vec<&dyn arrow::array::Array> = take.iter().map(|b| b.column(i).as_ref()).collect();
        let Ok(col) = arrow::compute::concat(&parts) else { continue };
        let Ok(conv) = arrow::row::RowConverter::new(vec![arrow::row::SortField::new(col.data_type().clone())]) else { continue };
        let Ok(encoded) = conv.convert_columns(&[col]) else { continue };
        let distinct: std::collections::HashSet<arrow::row::Row<'_>> = encoded.iter().collect();
        if distinct.len() as f64 >= rows as f64 * MOSTLY_DISTINCT {
            out.push(i);
        }
    }
    out
}

/// What a sink needs to start its file once it has seen the first rows.
struct Pending {
    output: Output,
    schema: SchemaRef,
    compression: Compression,
}

impl ParquetSink {
    pub fn create(path: &str, schema: SchemaRef, compression: &str, row_group_size: Option<usize>, storage: &StorageOptions) -> Result<Self> {
        let rows_per_group = row_group_size.unwrap_or(1 << 17).max(1);
        let pending = Pending { output: Output::create(path, storage)?, schema, compression: parse_compression(compression)? };
        Ok(Self {
            rows_per_group,
            pending: vec![],
            pending_rows: 0,
            groups: vec![],
            start: Some(pending),
            queue: None,
            writer: None,
            path: path.to_string(),
        })
    }

    /// Open the file with encodings chosen from `sample` (the first rows)
    /// and start the writer thread.
    fn start(&mut self, sample: &[RecordBatch]) -> Result<()> {
        let Some(Pending { output, schema, compression }) = self.start.take() else { return Ok(()) };
        let mut builder = WriterProperties::builder()
            .set_compression(compression)
            .set_max_row_group_row_count(Some(self.rows_per_group));
        for i in mostly_distinct(&schema, sample) {
            builder = builder.set_column_dictionary_enabled(ColumnPath::from(schema.field(i).name().as_str()), false);
        }
        let mut props = builder.build();
        add_encoded_arrow_schema_to_metadata(&schema, &mut props);
        let parquet_schema = ArrowSchemaConverter::new().with_coerce_types(props.coerce_types()).convert(&schema)?;
        let writer = SerializedFileWriter::new(output, parquet_schema.root_schema_ptr(), Arc::new(props))?;
        let factory = ArrowRowGroupWriterFactory::new(&writer, schema.clone());
        // one batch of groups queued while the previous one is encoded
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let handle = std::thread::Builder::new()
            .name("iara-parquet-writer".into())
            .spawn(move || write_groups(writer, factory, schema, rx))
            .map_err(|e| WhError::Execution(format!("parquet writer thread: {e}")))?;
        self.queue = Some(tx);
        self.writer = Some(handle);
        Ok(())
    }

    pub fn write(&mut self, batch: &RecordBatch) -> Result<()> {
        let mut at = 0;
        while at < batch.num_rows() {
            let take = (self.rows_per_group - self.pending_rows).min(batch.num_rows() - at);
            self.pending.push(batch.slice(at, take));
            self.pending_rows += take;
            at += take;
            if self.pending_rows == self.rows_per_group {
                self.end_group();
                self.send()?;
            }
        }
        Ok(())
    }

    fn end_group(&mut self) {
        self.groups.push(std::mem::take(&mut self.pending));
        self.pending_rows = 0;
    }

    /// Hand the full row groups to the writer thread (waits while it is a
    /// batch behind); a failed writer reports its error here.
    fn send(&mut self) -> Result<()> {
        let groups = std::mem::take(&mut self.groups);
        if groups.is_empty() {
            return Ok(());
        }
        if self.start.is_some() {
            self.start(&groups[0])?;
        }
        let sent = self.queue.as_ref().is_some_and(|q| q.send(groups).is_ok());
        if sent { Ok(()) } else { self.join().map(|_| ()) }
    }

    fn join(&mut self) -> Result<SerializedFileWriter<Output>> {
        self.queue = None;
        let handle = self.writer.take().ok_or_else(|| WhError::Execution("parquet writer already closed".into()))?;
        let w = handle.join().map_err(|_| WhError::Execution("parquet writer thread panicked".into()))??;
        Ok(w)
    }

    /// Write the footer and close the file (complete the upload); returns
    /// the file as written, with its footer.
    pub fn finish(mut self) -> Result<WrittenFile> {
        if self.pending_rows > 0 {
            self.end_group();
        }
        self.send()?;
        if self.start.is_some() {
            self.start(&[])?;
        }
        let mut writer = self.join()?;
        let metadata = writer.finish()?;
        let size = writer.inner_mut().commit()?;
        Ok(WrittenFile {
            path: std::mem::take(&mut self.path),
            size,
            rows: metadata.file_metadata().num_rows().max(0) as u64,
            partition_values: vec![],
            metadata: Some(Arc::new(metadata)),
        })
    }
}

pub fn write_parquet(path: &str, schema: SchemaRef, batches: &[RecordBatch], compression: &str, row_group_size: Option<usize>) -> Result<()> {
    write_parquet_with(path, schema, batches, compression, row_group_size, &StorageOptions::default())
}

pub fn write_parquet_with(
    path: &str,
    schema: SchemaRef,
    batches: &[RecordBatch],
    compression: &str,
    row_group_size: Option<usize>,
    options: &StorageOptions,
) -> Result<()> {
    let mut sink = ParquetSink::create(path, schema, compression, row_group_size, options)?;
    for b in batches {
        sink.write(b)?;
    }
    sink.finish().map(|_| ())
}
