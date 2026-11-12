//! Collected results. A sorted result keeps its batches as they were produced
//! plus the row order, and is gathered into order only when read.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::datatypes::{Schema, SchemaRef};
use arrow::record_batch::RecordBatch;
use napi::bindgen_prelude::{AsyncTask, Buffer, Uint8Array, Unknown};
use napi_derive::napi;

use iara_core::io::csv::write_csv_with;
use iara_core::io::parquet::write_parquet_with;
use iara_core::session::Collected;

use crate::error::{Result, ResExt, count};
use crate::ipc::{from_ipc, to_ipc};
use crate::lazy::JsLazyFrame;
use crate::session::JsSessionContext;
use crate::storage::options;
use crate::task::{Job, spawn};

#[napi(object)]
pub struct SchemaField {
    pub name: String,
    #[napi(js_name = "type")]
    pub dtype: String,
}

pub fn schema_list(schema: &Schema) -> Vec<SchemaField> {
    schema.fields().iter().map(|f| SchemaField { name: f.name().clone(), dtype: iara_core::nested::type_name(f.data_type()) }).collect()
}

struct FrameInner {
    batches: Vec<RecordBatch>,
    idx: Option<Arc<[u32]>>,
}

struct Frame {
    schema: SchemaRef,
    inner: parking_lot::Mutex<FrameInner>,
}

impl Frame {
    fn new(schema: SchemaRef, batches: Vec<RecordBatch>) -> Arc<Self> {
        Arc::new(Self { schema, inner: parking_lot::Mutex::new(FrameInner { batches, idx: None }) })
    }

    fn batches(&self) -> Result<Vec<RecordBatch>> {
        let mut g = self.inner.lock();
        if let Some(idx) = g.idx.take() {
            g.batches = iara_core::exec::sort::gather(&self.schema, &g.batches, &idx, iara_core::exec::pipeline::MORSEL_ROWS).js()?;
        }
        Ok(g.batches.clone())
    }

    fn num_rows(&self) -> usize {
        let g = self.inner.lock();
        match &g.idx {
            Some(idx) => idx.len(),
            None => g.batches.iter().map(|b| b.num_rows()).sum(),
        }
    }
}

#[napi]
pub struct JsDataFrame {
    frame: Arc<Frame>,
}

impl JsDataFrame {
    pub fn new(schema: SchemaRef, batches: Vec<RecordBatch>) -> Self {
        Self { frame: Frame::new(schema, batches) }
    }

    pub fn from_collected(c: Collected) -> Self {
        match c {
            Collected::Batches(schema, batches) => Self::new(schema, batches),
            Collected::Sorted { schema, batches, idx } => {
                Self { frame: Arc::new(Frame { schema, inner: parking_lot::Mutex::new(FrameInner { batches, idx: Some(idx) }) }) }
            }
        }
    }

    pub fn schema_ref(&self) -> SchemaRef {
        self.frame.schema.clone()
    }

    pub fn batches(&self) -> Result<Vec<RecordBatch>> {
        self.frame.batches()
    }
}

#[napi]
impl JsDataFrame {
    /// A table from an Arrow IPC stream.
    #[napi(ts_return_type = "Promise<JsDataFrame>")]
    pub fn from_ipc(bytes: Uint8Array) -> AsyncTask<Job<JsDataFrame>> {
        let bytes = bytes.to_vec();
        spawn(move || {
            let (schema, batches) = from_ipc(&bytes)?;
            Ok(JsDataFrame::new(schema, batches))
        })
    }

    /// The table as an Arrow IPC stream.
    #[napi(ts_return_type = "Promise<Buffer>")]
    pub fn to_ipc(&self) -> AsyncTask<Job<Buffer>> {
        let f = self.frame.clone();
        spawn(move || Ok(Buffer::from(to_ipc(&f.schema, &f.batches()?)?)))
    }

    #[napi]
    pub fn num_rows(&self) -> i64 {
        self.frame.num_rows() as i64
    }

    #[napi]
    pub fn num_columns(&self) -> i64 {
        self.frame.schema.fields().len() as i64
    }

    #[napi]
    pub fn columns(&self) -> Vec<String> {
        self.frame.schema.fields().iter().map(|f| f.name().clone()).collect()
    }

    #[napi]
    pub fn schema(&self) -> Vec<SchemaField> {
        schema_list(&self.frame.schema)
    }

    /// The first `maxRows` rows (10 by default) as a text table.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn to_table_string(&self, max_rows: Option<i64>) -> Result<AsyncTask<Job<String>>> {
        let max_rows = count(max_rows.unwrap_or(10), "maxRows")?;
        let f = self.frame.clone();
        Ok(spawn(move || {
            let head = {
                let g = f.inner.lock();
                match &g.idx {
                    Some(idx) => {
                        let end = max_rows.min(idx.len());
                        iara_core::exec::sort::gather(&f.schema, &g.batches, &idx[..end], iara_core::exec::pipeline::MORSEL_ROWS).js()?
                    }
                    None => iara_core::exec::pipeline::apply_limit(g.batches.clone(), 0, Some(max_rows)),
                }
            };
            let table = if head.is_empty() {
                arrow::util::pretty::pretty_format_batches(&[RecordBatch::new_empty(f.schema.clone())]).js()?
            } else {
                arrow::util::pretty::pretty_format_batches(&head).js()?
            };
            let n = f.num_rows();
            let mut s = format!("shape: ({}, {})\n{}", n, f.schema.fields().len(), table);
            if n > max_rows {
                s.push_str(&format!("\n... {} more rows", n - max_rows));
            }
            Ok(s)
        }))
    }

    #[napi(ts_return_type = "Promise<JsDataFrame>")]
    pub fn slice(&self, offset: i64, length: i64) -> Result<AsyncTask<Job<JsDataFrame>>> {
        let (offset, length) = (count(offset, "offset")?, count(length, "length")?);
        let f = self.frame.clone();
        Ok(spawn(move || {
            let g = f.inner.lock();
            if let Some(idx) = &g.idx {
                let start = offset.min(idx.len());
                let end = start.saturating_add(length).min(idx.len());
                let batches = iara_core::exec::sort::gather(&f.schema, &g.batches, &idx[start..end], iara_core::exec::pipeline::MORSEL_ROWS).js()?;
                return Ok(JsDataFrame::new(f.schema.clone(), batches));
            }
            Ok(JsDataFrame::new(f.schema.clone(), iara_core::exec::pipeline::apply_limit(g.batches.clone(), offset, Some(length))))
        }))
    }

    #[napi]
    pub fn lazy(&self, ctx: &JsSessionContext) -> Result<JsLazyFrame> {
        Ok(JsLazyFrame::new(ctx.inner.from_batches(self.frame.schema.clone(), self.frame.batches()?).js()?))
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn write_parquet(
        &self,
        path: String,
        compression: Option<String>,
        row_group_size: Option<i64>,
        storage_options: Option<HashMap<String, Unknown<'_>>>,
    ) -> Result<AsyncTask<Job<()>>> {
        let opts = options(storage_options)?;
        let row_group_size = row_group_size.map(|n| count(n, "rowGroupSize")).transpose()?;
        let compression = compression.unwrap_or_else(|| "zstd".into());
        let f = self.frame.clone();
        Ok(spawn(move || write_parquet_with(&path, f.schema.clone(), &f.batches()?, &compression, row_group_size, &opts).js()))
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn write_csv(
        &self,
        path: String,
        has_header: Option<bool>,
        delimiter: Option<String>,
        storage_options: Option<HashMap<String, Unknown<'_>>>,
    ) -> Result<AsyncTask<Job<()>>> {
        let opts = options(storage_options)?;
        let d = delimiter.as_deref().and_then(|d| d.as_bytes().first().copied()).unwrap_or(b',');
        let f = self.frame.clone();
        Ok(spawn(move || write_csv_with(&path, &f.batches()?, has_header.unwrap_or(true), d, &opts).js()))
    }

    /// One JSON object per row.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn write_ndjson(&self, path: String, storage_options: Option<HashMap<String, Unknown<'_>>>) -> Result<AsyncTask<Job<()>>> {
        let opts = options(storage_options)?;
        let f = self.frame.clone();
        Ok(spawn(move || iara_core::io::json::write_json_with(&path, &f.batches()?, &opts).js()))
    }
}
