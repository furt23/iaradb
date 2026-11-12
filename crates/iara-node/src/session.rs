//! The session: tables registered by name, SQL and file readers.

use std::collections::HashMap;

use napi::bindgen_prelude::{AsyncTask, Unknown};
use napi_derive::napi;

use iara_core::SessionContext;
use iara_core::delta::VersionSpec;
use iara_core::io::csv::CsvOptions;

use crate::error::{Result, ResExt, count, invalid};
use crate::file_options::{self, Dict};
use crate::frame::JsDataFrame;
use crate::lazy::JsLazyFrame;
use crate::scalar::sql_params;
use crate::storage as store;
use crate::task::{Job, spawn};

#[napi]
pub struct JsSessionContext {
    pub(crate) inner: SessionContext,
}

fn csv_options(has_header: Option<bool>, delimiter: Option<String>, infer_rows: Option<i64>, parallel: Option<bool>, extra: Option<Dict<'_>>) -> Result<CsvOptions> {
    let base = CsvOptions {
        has_header: has_header.unwrap_or(true),
        delimiter: delimiter.as_deref().and_then(|d| d.as_bytes().first().copied()).unwrap_or(b','),
        infer_rows: count(infer_rows.unwrap_or(10000), "inferRows")?,
        parallel: parallel.unwrap_or(true),
        ..Default::default()
    };
    file_options::csv_options(extra, base)
}

#[napi]
impl JsSessionContext {
    /// `defaultCatalog`: the name of the catalog that registrations belong to
    /// and the session starts in (`main` when not given).
    #[napi(constructor, catch_unwind)]
    pub fn new(default_catalog: Option<String>) -> Result<Self> {
        let inner = match default_catalog {
            Some(name) => SessionContext::with_default_catalog(&name).js()?,
            None => SessionContext::new(),
        };
        Ok(Self { inner })
    }

    /// Register a Parquet path, directory, glob or URL; with `lazy`, files are
    /// listed (and footers read) on first use instead of now.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn register_parquet(&self, name: String, path: String, storage_options: Option<HashMap<String, Unknown<'_>>>, lazy: Option<bool>) -> Result<AsyncTask<Job<()>>> {
        let storage = store::options(storage_options)?;
        let ctx = self.inner.clone();
        Ok(spawn(move || ctx.register_parquet_with(&name, &path, &storage, lazy.unwrap_or(false)).js()))
    }

    /// Register a folder of Parquet files or a Delta table (told apart once, when the table loads).
    #[napi(ts_return_type = "Promise<void>")]
    pub fn register_table(&self, name: String, path: String, storage_options: Option<HashMap<String, Unknown<'_>>>, lazy: Option<bool>) -> Result<AsyncTask<Job<()>>> {
        let storage = store::options(storage_options)?;
        let ctx = self.inner.clone();
        Ok(spawn(move || ctx.register_table_at(&name, &path, &storage, lazy.unwrap_or(false)).js()))
    }

    /// Register a Delta table, at its newest version.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn register_delta(&self, name: String, path: String, storage_options: Option<HashMap<String, Unknown<'_>>>, lazy: Option<bool>) -> Result<AsyncTask<Job<()>>> {
        let storage = store::options(storage_options)?;
        let ctx = self.inner.clone();
        Ok(spawn(move || ctx.register_delta(&name, &path, &storage, None, lazy.unwrap_or(false)).js()))
    }

    #[napi(ts_return_type = "Promise<void>")]
    #[allow(clippy::too_many_arguments)]
    pub fn register_csv(
        &self,
        name: String,
        path: String,
        has_header: Option<bool>,
        delimiter: Option<String>,
        infer_rows: Option<i64>,
        parallel: Option<bool>,
        storage_options: Option<HashMap<String, Unknown<'_>>>,
        lazy: Option<bool>,
        options: Option<HashMap<String, Unknown<'_>>>,
    ) -> Result<AsyncTask<Job<()>>> {
        let opts = csv_options(has_header, delimiter, infer_rows, parallel, options)?;
        let storage = store::options(storage_options)?;
        let ctx = self.inner.clone();
        Ok(spawn(move || ctx.register_csv_with(&name, &path, opts, &storage, lazy.unwrap_or(false)).js()))
    }

    /// Register JSON / NDJSON files (a path, folder, glob or URL) as a table.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn register_json(
        &self,
        name: String,
        path: String,
        options: Option<HashMap<String, Unknown<'_>>>,
        storage_options: Option<HashMap<String, Unknown<'_>>>,
        lazy: Option<bool>,
    ) -> Result<AsyncTask<Job<()>>> {
        let opts = file_options::json_options(options)?;
        let storage = store::options(storage_options)?;
        let ctx = self.inner.clone();
        Ok(spawn(move || iara_core::io::json::register_json(&ctx, &name, &path, opts, &storage, lazy.unwrap_or(false)).js()))
    }

    #[napi(ts_return_type = "Promise<JsLazyFrame>")]
    pub fn read_json(&self, path: String, options: Option<HashMap<String, Unknown<'_>>>, storage_options: Option<HashMap<String, Unknown<'_>>>) -> Result<AsyncTask<Job<JsLazyFrame>>> {
        let opts = file_options::json_options(options)?;
        let storage = store::options(storage_options)?;
        let ctx = self.inner.clone();
        Ok(spawn(move || Ok(JsLazyFrame::new(iara_core::io::json::read_json(&ctx, &path, opts, &storage).js()?))))
    }

    /// Whether a registered table was loaded (false: lazy, not used yet); null for an unknown name.
    #[napi]
    pub fn is_loaded(&self, name: String) -> Option<bool> {
        self.inner.is_loaded(&name)
    }

    #[napi(catch_unwind)]
    pub fn register_dataframe(&self, name: String, df: &JsDataFrame) -> Result<()> {
        self.inner.register_batches(&name, df.schema_ref(), df.batches()?).js()
    }

    #[napi(catch_unwind)]
    pub fn register_lazy(&self, name: String, frame: &JsLazyFrame) -> Result<()> {
        self.inner.register_view(&name, frame.inner.plan.clone()).js()
    }

    #[napi]
    pub fn deregister(&self, name: String) -> bool {
        self.inner.deregister(&name)
    }

    #[napi]
    pub fn fork(&self) -> JsSessionContext {
        Self { inner: self.inner.fork() }
    }

    /// Where `CREATE TABLE ... AS` writes tables (null: in memory).
    #[napi]
    pub fn set_warehouse(&self, path: Option<String>, storage_options: Option<HashMap<String, Unknown<'_>>>) -> Result<()> {
        self.inner.set_warehouse(path.as_deref(), &store::options(storage_options)?);
        Ok(())
    }

    #[napi]
    pub fn warehouse(&self) -> Option<String> {
        self.inner.warehouse().map(|(p, _)| p)
    }

    /// The tables' display names: in the default catalog bare in `main` and
    /// `schema.table` elsewhere; in any other catalog `catalog.schema.table`.
    #[napi]
    pub fn tables(&self) -> Vec<String> {
        self.inner.table_names()
    }

    /// The catalogs: the default one first, then the others sorted.
    #[napi]
    pub fn catalogs(&self) -> Vec<String> {
        self.inner.catalogs()
    }

    /// The catalog `USE CATALOG` selected (the default one at first).
    #[napi]
    pub fn current_catalog(&self) -> String {
        self.inner.current_catalog()
    }

    /// The catalog that registrations and `table()` names belong to.
    #[napi]
    pub fn default_catalog(&self) -> String {
        self.inner.default_catalog()
    }

    /// The schemas of a catalog (null: the current one): `main` first, then the others sorted.
    #[napi(catch_unwind)]
    pub fn schemas(&self, catalog: Option<String>) -> Result<Vec<String>> {
        match catalog {
            Some(c) => self.inner.schemas_of(&c).js(),
            None => Ok(self.inner.schemas()),
        }
    }

    /// The schema `USE` selected in the current catalog (`main` at first).
    #[napi]
    pub fn current_schema(&self) -> String {
        self.inner.current_schema()
    }

    /// A registered table, named like in `register*` (relative to the default catalog).
    #[napi(ts_return_type = "Promise<JsLazyFrame>")]
    pub fn table(&self, name: String) -> AsyncTask<Job<JsLazyFrame>> {
        // a lazily registered table may be loaded now (remote I/O)
        let ctx = self.inner.clone();
        spawn(move || Ok(JsLazyFrame::new(ctx.table(&name).js()?)))
    }

    /// `params`: an array (`$1`, `$2`, `?`) or an object (`:name`, `$name`).
    #[napi(ts_return_type = "Promise<JsLazyFrame>")]
    pub fn sql(&self, query: String, params: Option<Unknown<'_>>) -> Result<AsyncTask<Job<JsLazyFrame>>> {
        let params = sql_params(params)?;
        let ctx = self.inner.clone();
        Ok(spawn(move || Ok(JsLazyFrame::new(ctx.sql_with(&query, &params).js()?))))
    }

    #[napi(ts_return_type = "Promise<JsLazyFrame>")]
    pub fn read_parquet(&self, path: String, storage_options: Option<HashMap<String, Unknown<'_>>>) -> Result<AsyncTask<Job<JsLazyFrame>>> {
        let storage = store::options(storage_options)?;
        let ctx = self.inner.clone();
        Ok(spawn(move || Ok(JsLazyFrame::new(ctx.read_parquet_with(&path, &storage).js()?))))
    }

    /// A Delta table; `timestamp` is milliseconds since the epoch.
    #[napi(ts_return_type = "Promise<JsLazyFrame>")]
    pub fn read_delta(&self, path: String, version: Option<i64>, timestamp: Option<i64>, storage_options: Option<HashMap<String, Unknown<'_>>>) -> Result<AsyncTask<Job<JsLazyFrame>>> {
        let spec = match (version, timestamp) {
            (Some(_), Some(_)) => return Err(invalid("give a version or a timestamp, not both")),
            (Some(v), None) => Some(VersionSpec::Version(count(v, "version")? as u64)),
            (None, Some(t)) => Some(VersionSpec::Timestamp(t)),
            (None, None) => None,
        };
        let storage = store::options(storage_options)?;
        let ctx = self.inner.clone();
        Ok(spawn(move || Ok(JsLazyFrame::new(ctx.read_delta(&path, &storage, spec).js()?))))
    }

    #[napi(ts_return_type = "Promise<JsLazyFrame>")]
    #[allow(clippy::too_many_arguments)]
    pub fn read_csv(
        &self,
        path: String,
        has_header: Option<bool>,
        delimiter: Option<String>,
        infer_rows: Option<i64>,
        parallel: Option<bool>,
        storage_options: Option<HashMap<String, Unknown<'_>>>,
        options: Option<HashMap<String, Unknown<'_>>>,
    ) -> Result<AsyncTask<Job<JsLazyFrame>>> {
        let opts = csv_options(has_header, delimiter, infer_rows, parallel, options)?;
        let storage = store::options(storage_options)?;
        let ctx = self.inner.clone();
        Ok(spawn(move || Ok(JsLazyFrame::new(ctx.read_csv_with(&path, opts, &storage).js()?))))
    }

    #[allow(clippy::wrong_self_convention)]
    #[napi(catch_unwind)]
    pub fn from_dataframe(&self, df: &JsDataFrame) -> Result<JsLazyFrame> {
        Ok(JsLazyFrame::new(self.inner.from_batches(df.schema_ref(), df.batches()?).js()?))
    }
}
