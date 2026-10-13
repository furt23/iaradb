//! Registering tables by location (Delta detected once, at registration)
//! and listing the catalog without loading deferred tables.

use std::sync::Arc;

use super::{Slot, SessionContext, TableEntry};
use crate::catalog_names::TableName;
use crate::delta::{DeltaTable, is_delta_table};
use crate::error::Result;
use crate::io::TableProvider;
use crate::io::dataset;
use crate::io::options::StorageOptions;
use crate::io::parquet::ParquetTable;

/// A catalog entry as `SHOW TABLES` lists it.
#[derive(Debug, Clone)]
pub struct TableListing {
    pub name: TableName,
    pub is_view: bool,
    /// `delta`, `parquet`, ... when the table is loaded (deferred ones are not loaded to find out)
    pub kind: Option<&'static str>,
}

impl SessionContext {
    /// Register the table at `path`: a Delta table if the folder holds a Delta
    /// log, else Parquet files. Detected when the table loads (on first use
    /// if `lazy`), so a registration costs nothing until then.
    pub fn register_table_at(&self, name: &str, path: &str, storage: &StorageOptions, lazy: bool) -> Result<()> {
        let (path, storage) = (path.to_string(), storage.clone());
        self.register_loader(name, lazy, move || {
            if dataset::is_folder(&path) && is_delta_table(&path, &storage) {
                return Ok(Arc::new(DeltaTable::open(&path, &storage, None)?) as Arc<dyn TableProvider>);
            }
            Ok(Arc::new(ParquetTable::try_new_with(&path, &storage)?))
        })
    }

    /// The tables and views of a schema, sorted by name, without loading any.
    pub fn list_tables(&self, schema: &str) -> Vec<TableListing> {
        let catalog = self.state.catalog.read();
        catalog
            .tables_in(schema)
            .into_iter()
            .map(|name| {
                let slot = catalog.tables.get(&name.key());
                let (is_view, kind) = match slot {
                    Some(Slot::Entry(TableEntry::View(_))) => (true, None),
                    Some(Slot::Entry(TableEntry::Table(t))) => (false, Some(t.kind())),
                    Some(Slot::Deferred(d)) => (false, d.loaded_kind()),
                    None => (false, None),
                };
                TableListing { name, is_view, kind }
            })
            .collect()
    }
}
