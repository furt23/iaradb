//! Lazy query plans: building them is synchronous, running them is not.

use std::collections::HashMap;

use napi::bindgen_prelude::{AsyncTask, ClassInstance, Unknown};
use napi_derive::napi;

use iara_core::expr::SortExpr;
use iara_core::io::parquet::ParquetOptions;
use iara_core::{JoinType, LazyFrame, WhError};

use crate::error::{Result, ResExt, count, invalid};
use crate::expr::{JsExpr, exprs_of};
use crate::frame::{JsDataFrame, SchemaField, schema_list};
use crate::storage::options;
use crate::stream::JsResultStream;
use crate::task::{Job, spawn};

#[napi]
pub struct JsLazyFrame {
    pub(crate) inner: LazyFrame,
}

impl JsLazyFrame {
    pub fn new(inner: LazyFrame) -> Self {
        Self { inner }
    }
}

fn lf(r: Result<LazyFrame, WhError>) -> Result<JsLazyFrame> {
    Ok(JsLazyFrame::new(r.js()?))
}

fn delimiter_byte(d: Option<String>) -> u8 {
    d.as_deref().and_then(|d| d.as_bytes().first().copied()).unwrap_or(b',')
}

#[napi(object)]
pub struct DeltaWrite {
    pub version: i64,
    pub files: i64,
    pub rows: i64,
    pub skipped: bool,
}

#[napi]
impl JsLazyFrame {
    #[napi(catch_unwind)]
    pub fn filter(&self, predicate: &JsExpr) -> Result<JsLazyFrame> {
        lf(self.inner.filter(predicate.inner.clone()))
    }

    #[napi(catch_unwind)]
    pub fn select(&self, exprs: Vec<ClassInstance<'_, JsExpr>>) -> Result<JsLazyFrame> {
        lf(self.inner.select(exprs_of(&exprs)))
    }

    #[napi(catch_unwind)]
    pub fn with_columns(&self, exprs: Vec<ClassInstance<'_, JsExpr>>) -> Result<JsLazyFrame> {
        lf(self.inner.with_columns(exprs_of(&exprs)))
    }

    #[napi(catch_unwind)]
    pub fn group_by_agg(&self, keys: Vec<ClassInstance<'_, JsExpr>>, aggs: Vec<ClassInstance<'_, JsExpr>>) -> Result<JsLazyFrame> {
        lf(self.inner.aggregate(exprs_of(&keys), exprs_of(&aggs)))
    }

    #[napi(catch_unwind)]
    pub fn join(
        &self,
        other: &JsLazyFrame,
        left_on: Vec<ClassInstance<'_, JsExpr>>,
        right_on: Vec<ClassInstance<'_, JsExpr>>,
        how: Option<String>,
        suffix: Option<String>,
    ) -> Result<JsLazyFrame> {
        let how = how.unwrap_or_else(|| "inner".into());
        let suffix = suffix.unwrap_or_else(|| "_right".into());
        if how == "cross" {
            return lf(self.inner.cross_join(&other.inner, &suffix));
        }
        let jt = JoinType::parse(&how).js()?;
        lf(self.inner.join(&other.inner, exprs_of(&left_on), exprs_of(&right_on), jt, &suffix))
    }

    #[napi(catch_unwind)]
    pub fn sort(&self, by: Vec<ClassInstance<'_, JsExpr>>, descending: Vec<bool>, nulls_last: Vec<bool>) -> Result<JsLazyFrame> {
        let sorts = by
            .iter()
            .enumerate()
            .map(|(i, e)| {
                let desc = descending.get(i).copied().unwrap_or(false);
                let nl = nulls_last.get(i).copied().unwrap_or(false);
                SortExpr::new(e.inner.clone(), desc, !nl)
            })
            .collect();
        lf(self.inner.sort(sorts))
    }

    #[napi(catch_unwind)]
    pub fn slice(&self, offset: i64, length: Option<i64>) -> Result<JsLazyFrame> {
        let length = length.map(|l| count(l, "length")).transpose()?;
        Ok(JsLazyFrame::new(self.inner.slice(count(offset, "offset")?, length)))
    }

    #[napi(catch_unwind)]
    pub fn distinct(&self) -> Result<JsLazyFrame> {
        lf(self.inner.distinct())
    }

    #[napi(catch_unwind)]
    pub fn union(&self, others: Vec<&JsLazyFrame>) -> Result<JsLazyFrame> {
        let o: Vec<LazyFrame> = others.iter().map(|x| x.inner.clone()).collect();
        lf(self.inner.union(&o))
    }

    #[napi(catch_unwind)]
    pub fn drop(&self, names: Vec<String>) -> Result<JsLazyFrame> {
        lf(self.inner.drop(&names))
    }

    /// `oldNames[i]` becomes `newNames[i]`.
    #[napi(catch_unwind)]
    pub fn rename(&self, old_names: Vec<String>, new_names: Vec<String>) -> Result<JsLazyFrame> {
        if old_names.len() != new_names.len() {
            return Err(invalid("rename: oldNames and newNames must have the same length"));
        }
        lf(self.inner.rename(&old_names.into_iter().zip(new_names).collect::<Vec<_>>()))
    }

    #[napi]
    pub fn alias(&self, name: String) -> JsLazyFrame {
        JsLazyFrame::new(self.inner.alias(&name))
    }

    /// One row per element of the list columns, in their place.
    #[napi(catch_unwind)]
    pub fn explode(&self, columns: Vec<String>) -> Result<JsLazyFrame> {
        lf(self.inner.explode(&columns))
    }

    /// The struct columns replaced by one column per field.
    #[napi(catch_unwind)]
    pub fn unnest(&self, columns: Vec<String>, separator: Option<String>) -> Result<JsLazyFrame> {
        lf(self.inner.unnest(&columns, separator.as_deref()))
    }

    /// The field names of the struct `expr` evaluates to; null when it is not a struct.
    #[napi(catch_unwind)]
    pub fn struct_fields(&self, expr: &JsExpr) -> Result<Option<Vec<String>>> {
        self.inner.struct_field_names(&expr.inner).js()
    }

    #[napi]
    pub fn columns(&self) -> Vec<String> {
        self.inner.schema().fields().iter().map(|f| f.name().to_string()).collect()
    }

    #[napi]
    pub fn schema(&self) -> Vec<SchemaField> {
        schema_list(self.inner.schema().arrow_schema())
    }

    #[napi(ts_return_type = "Promise<string>")]
    pub fn explain(&self, optimized: Option<bool>) -> AsyncTask<Job<String>> {
        let inner = self.inner.clone();
        spawn(move || inner.explain(optimized.unwrap_or(true)).js())
    }

    #[napi(ts_return_type = "Promise<JsDataFrame>")]
    pub fn collect(&self) -> AsyncTask<Job<JsDataFrame>> {
        let inner = self.inner.clone();
        spawn(move || Ok(JsDataFrame::from_collected(inner.collect_lazy().js()?)))
    }

    /// The result, read batch by batch; resolves once the query has started.
    #[napi(ts_return_type = "Promise<JsResultStream>")]
    pub fn stream(&self) -> AsyncTask<Job<JsResultStream>> {
        let inner = self.inner.clone();
        spawn(move || JsResultStream::open(inner))
    }

    /// Write the result to Parquet as it is produced (Hive-partitioned with
    /// `partitionBy`); resolves to the rows written.
    #[napi(ts_return_type = "Promise<number>")]
    pub fn sink_parquet(
        &self,
        path: String,
        compression: Option<String>,
        row_group_size: Option<i64>,
        storage_options: Option<HashMap<String, Unknown<'_>>>,
        partition_by: Option<Vec<String>>,
    ) -> Result<AsyncTask<Job<i64>>> {
        let storage = options(storage_options)?;
        let row_group_size = row_group_size.map(|n| count(n, "rowGroupSize")).transpose()?;
        let opts = ParquetOptions {
            compression: compression.unwrap_or_else(|| "zstd".into()),
            row_group_size,
            partition_by: partition_by.unwrap_or_default(),
        };
        let inner = self.inner.clone();
        Ok(spawn(move || Ok(inner.sink_parquet(&path, &opts, &storage).js()? as i64)))
    }

    /// Write the result to CSV as it is produced; resolves to the rows written.
    #[napi(ts_return_type = "Promise<number>")]
    pub fn sink_csv(
        &self,
        path: String,
        has_header: Option<bool>,
        delimiter: Option<String>,
        storage_options: Option<HashMap<String, Unknown<'_>>>,
    ) -> Result<AsyncTask<Job<i64>>> {
        let storage = options(storage_options)?;
        let d = delimiter_byte(delimiter);
        let inner = self.inner.clone();
        Ok(spawn(move || Ok(inner.sink_csv(&path, has_header.unwrap_or(true), d, &storage).js()? as i64)))
    }

    /// Write the result as NDJSON while it is produced; resolves to the rows written.
    #[napi(ts_return_type = "Promise<number>")]
    pub fn sink_ndjson(&self, path: String, storage_options: Option<HashMap<String, Unknown<'_>>>) -> Result<AsyncTask<Job<i64>>> {
        let storage = options(storage_options)?;
        let inner = self.inner.clone();
        Ok(spawn(move || Ok(iara_core::io::json::sink_json(&inner, &path, &storage).js()? as i64)))
    }

    /// Write the result to a Delta table (a path or object store URL) as it is
    /// produced. `mode` is `error` (the default), `append`, `overwrite` or
    /// `ignore`; `mergeSchema` lets an append or overwrite add the result's new
    /// columns to the table.
    #[napi(ts_return_type = "Promise<DeltaWrite>")]
    pub fn sink_delta(
        &self,
        path: String,
        mode: Option<String>,
        partition_by: Option<Vec<String>>,
        storage_options: Option<HashMap<String, Unknown<'_>>>,
        merge_schema: Option<bool>,
    ) -> Result<AsyncTask<Job<DeltaWrite>>> {
        let storage = options(storage_options)?;
        let mode = iara_core::delta::WriteMode::parse(mode.as_deref().unwrap_or("error")).js()?;
        let (inner, partition_by) = (self.inner.clone(), partition_by.unwrap_or_default());
        Ok(spawn(move || {
            let s = iara_core::delta::write_table(&inner, &path, &storage, mode, &partition_by, merge_schema.unwrap_or(false)).js()?;
            Ok(DeltaWrite { version: s.version as i64, files: s.files as i64, rows: s.rows as i64, skipped: s.skipped })
        }))
    }
}
