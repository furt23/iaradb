//! Session context (catalog) and the lazy DataFrame API.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use arrow::datatypes::SchemaRef;
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use parking_lot::{Mutex, RwLock};

use crate::catalog_names::{DEFAULT_CATALOG, MAIN, Missing, SchemaName, SchemaSpec, TableName, TableRef, parse_catalog, unknown_catalog};
use crate::error::{Result, WhError};
use crate::exec::query::{QueryStats, with_query};
use crate::expr::{Expr, SortExpr};
use crate::io::TableProvider;
use crate::io::csv::{CsvOptions, CsvTable};
use crate::io::memory::MemTable;
use crate::io::options::StorageOptions;
use crate::io::parquet::ParquetTable;
use crate::logical::{JoinType, LogicalPlan};
use crate::optimizer::optimize;
use crate::physical::planner::{PhysicalPlan, PlanNode, create_physical_plan, execute, execute_stream};
use crate::schema::{Column, PlanSchema, PlanSchemaRef};
use crate::sql::Params;

mod tables;
mod unnest;

pub use tables::TableListing;

#[derive(Clone, Debug)]
pub enum TableEntry {
    Table(Arc<dyn TableProvider>),
    View(Arc<LogicalPlan>),
}

type Loader = Box<dyn Fn() -> Result<Arc<dyn TableProvider>> + Send + Sync>;

/// A table loaded on first use (its files listed, footers read): a
/// workspace registers all its tables up front without touching storage,
/// and one that cannot be read fails only the queries that use it.
pub struct DeferredTable {
    load: Loader,
    loaded: parking_lot::Mutex<Option<Arc<dyn TableProvider>>>,
}

impl DeferredTable {
    pub fn new(load: impl Fn() -> Result<Arc<dyn TableProvider>> + Send + Sync + 'static) -> Self {
        Self { load: Box::new(load), loaded: parking_lot::Mutex::new(None) }
    }

    /// The table, loading it if needed. Failures are not remembered: a later
    /// use retries (credentials or network may have been fixed meanwhile).
    pub fn resolve(&self) -> Result<Arc<dyn TableProvider>> {
        let mut loaded = self.loaded.lock();
        if let Some(t) = loaded.as_ref() {
            return Ok(t.clone());
        }
        let t = (self.load)()?;
        *loaded = Some(t.clone());
        Ok(t)
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded.lock().is_some()
    }

    /// What the table reads, if it is loaded.
    fn loaded_origin(&self) -> Option<crate::exec::query::TableRead> {
        self.loaded.lock().as_ref()?.origin()
    }

    /// The kind of the table, if it is loaded.
    pub(crate) fn loaded_kind(&self) -> Option<&'static str> {
        self.loaded.lock().as_ref().map(|t| t.kind())
    }
}

#[derive(Clone)]
enum Slot {
    Entry(TableEntry),
    Deferred(Arc<DeferredTable>),
}

/// The tables by name, the catalogs with their schemas (`main` always), the
/// default catalog (named when the session is created) and the current
/// catalog and schema.
#[derive(Clone)]
struct Catalog {
    tables: HashMap<TableName, Slot>,
    /// each catalog's schemas
    catalogs: BTreeMap<String, BTreeSet<String>>,
    default: String,
    current_catalog: String,
    current_schema: String,
}

impl Default for Catalog {
    fn default() -> Self {
        Self::new(DEFAULT_CATALOG)
    }
}

impl Catalog {
    fn new(default: &str) -> Self {
        Self {
            tables: HashMap::new(),
            catalogs: BTreeMap::from([(default.to_string(), BTreeSet::from([MAIN.to_string()]))]),
            default: default.to_string(),
            current_catalog: default.to_string(),
            current_schema: MAIN.to_string(),
        }
    }

    /// Register under `name`, creating its schema; its catalog must exist.
    fn insert(&mut self, name: &TableName, slot: Slot) -> Result<()> {
        let schemas = self.catalogs.get_mut(&name.catalog).ok_or_else(|| unknown_catalog(&name.catalog))?;
        schemas.insert(name.schema.clone());
        self.tables.insert(name.clone(), slot);
        Ok(())
    }

    /// Where a table name written in a query resolves: `c.s.t` exactly; `s.t`
    /// in schema `s` of the current catalog; `t` in the current catalog, in
    /// the current schema and then in `main`.
    fn resolve(&self, r: &TableRef) -> Option<TableName> {
        let catalog = r.catalog.as_deref().unwrap_or(&self.current_catalog);
        let schemas = match &r.schema {
            Some(s) => vec![s.as_str()],
            None => vec![self.current_schema.as_str(), MAIN],
        };
        schemas.into_iter().map(|s| TableName::new(catalog, s, &r.table)).find(|t| self.tables.contains_key(t))
    }

    /// Why a schema cannot hold tables: its catalog or it does not exist.
    fn missing_schema(&self, schema: &SchemaName) -> Option<Missing> {
        let Some(schemas) = self.catalogs.get(&schema.catalog) else { return Some(Missing::Catalog(schema.catalog.clone())) };
        (!schemas.contains(&schema.schema)).then(|| Missing::Schema(schema.display(&self.default)))
    }

    /// What a table name written in a query refers to that does not exist (a
    /// bare name has no schema to miss).
    fn missing_parent(&self, r: &TableRef) -> Option<Missing> {
        let catalog = r.catalog.as_deref().unwrap_or(&self.current_catalog);
        self.missing_schema(&SchemaName::new(catalog, r.schema.as_deref().unwrap_or(MAIN)))
    }

    fn tables_in(&self, schema: &SchemaName) -> Vec<TableName> {
        let mut v: Vec<TableName> = self.tables.keys().filter(|t| t.catalog == schema.catalog && t.schema == schema.schema).cloned().collect();
        v.sort_by(|a, b| a.table.cmp(&b.table));
        v
    }

    fn tables_of(&self, catalog: &str) -> Vec<TableName> {
        let mut v: Vec<TableName> = self.tables.keys().filter(|t| t.catalog == catalog).cloned().collect();
        v.sort_by(|a, b| (&a.schema, &a.table).cmp(&(&b.schema, &b.table)));
        v
    }

    /// The schemas of a catalog: `main` first, then the others sorted.
    fn schemas_of(&self, catalog: &str) -> Option<Vec<String>> {
        let schemas = self.catalogs.get(catalog)?;
        Some(std::iter::once(MAIN.to_string()).chain(schemas.iter().filter(|s| *s != MAIN).cloned()).collect())
    }

    fn display(&self, tables: &[TableName]) -> Vec<String> {
        tables.iter().map(|t| t.display(&self.default)).collect()
    }
}

#[derive(Default)]
pub struct SessionState {
    catalog: RwLock<Catalog>,
    /// where `CREATE TABLE ... AS` writes tables (none: they stay in memory)
    warehouse: RwLock<Option<(String, StorageOptions)>>,
    /// per-schema folders: tables created in the schema are written under them
    schema_locations: RwLock<HashMap<SchemaName, (String, StorageOptions)>>,
}

/// The catalog tables a restricted context may read, as an allow list.
#[derive(Debug)]
pub struct ReadPolicy {
    /// `*`, `catalog`, `catalog.schema` or `catalog.schema.table`, lowercase
    pub allow: Vec<String>,
    /// the covered tables read so far, as `catalog.schema.table` (what `covers` compares)
    read: Mutex<BTreeSet<String>>,
}

impl ReadPolicy {
    /// Whether an entry of the list covers the table `catalog.schema.table`.
    pub fn covers(&self, catalog: &str, schema: &str, table: &str) -> bool {
        let (c, s, t) = (catalog.to_ascii_lowercase(), schema.to_ascii_lowercase(), table.to_ascii_lowercase());
        self.allow.iter().any(|a| a == "*" || *a == c || *a == format!("{c}.{s}") || *a == format!("{c}.{s}.{t}"))
    }

    fn covers_table(&self, t: &TableName) -> bool {
        self.covers(&t.catalog, &t.schema, &t.table)
    }
}

#[derive(Clone, Default)]
pub struct SessionContext {
    state: Arc<SessionState>,
    /// what the context may read (none: everything); a restricted context
    /// refuses files and statements that write
    policy: Option<Arc<ReadPolicy>>,
}

impl SessionContext {
    /// A context whose default catalog is called `main`.
    pub fn new() -> Self {
        Self::default()
    }

    /// A context whose default catalog has this name (the catalog that names
    /// given to the registry belong to, and the one the session starts in).
    pub fn with_default_catalog(name: &str) -> Result<Self> {
        let name = parse_catalog(name)?;
        Ok(Self { state: Arc::new(SessionState { catalog: RwLock::new(Catalog::new(&name)), ..Default::default() }), policy: None })
    }

    /// This context limited by an allow list (the tables and settings are
    /// shared, not copied): its queries read only the tables the list covers
    /// (see [`ReadPolicy`]; `[]` covers none), and files and statements other
    /// than queries are refused.
    pub fn restricted(&self, allow: Vec<String>) -> SessionContext {
        let allow = allow.into_iter().map(|a| a.trim().to_ascii_lowercase()).collect();
        SessionContext { state: self.state.clone(), policy: Some(Arc::new(ReadPolicy { allow, read: Mutex::default() })) }
    }

    /// The allow list of a restricted context.
    pub fn read_policy(&self) -> Option<&ReadPolicy> {
        self.policy.as_deref()
    }

    /// The covered tables (and views) read through this context's policy, as
    /// sorted `catalog.schema.table` names; none when it is not restricted.
    /// Forks share the policy, so they share the record.
    pub fn tables_read(&self) -> Vec<String> {
        self.policy.as_ref().map_or_else(Vec::new, |p| p.read.lock().iter().cloned().collect())
    }

    /// `(location, catalog.schema.table)` of every registered table that is loaded and lives in
    /// storage. A deferred table that has not loaded yet is left out, never loaded here.
    pub fn table_locations(&self) -> Vec<(String, String)> {
        let catalog = self.state.catalog.read();
        catalog
            .tables
            .iter()
            .filter_map(|(name, slot)| {
                let origin = match slot {
                    Slot::Entry(TableEntry::Table(t)) => t.origin(),
                    Slot::Entry(TableEntry::View(_)) => None,
                    Slot::Deferred(d) => d.loaded_origin(),
                };
                origin.map(|o| (o.location, name.key()))
            })
            .collect()
    }

    /// Fail unless a table may be read (always when the context is not
    /// restricted); a restricted context records the tables it reads.
    fn check_read(&self, name: &TableName) -> Result<()> {
        match &self.policy {
            Some(p) if !p.covers_table(name) => Err(WhError::Plan(format!("no read grant on table {}", name.key()))),
            Some(p) => {
                p.read.lock().insert(name.key());
                Ok(())
            }
            None => Ok(()),
        }
    }

    /// Fail if the context is restricted: files are not catalog tables.
    pub(crate) fn check_files(&self) -> Result<()> {
        match self.policy {
            Some(_) => Err(WhError::Plan("reading files directly is not allowed here; query a catalog table".into())),
            None => Ok(()),
        }
    }

    /// A new context starting with this one's tables, catalogs, schemas and
    /// current catalog and schema (providers are shared, so cached metadata
    /// and statistics are reused); later registrations on either side are
    /// independent.
    pub fn fork(&self) -> Self {
        let catalog = self.state.catalog.read().clone();
        let warehouse = self.state.warehouse.read().clone();
        let schema_locations = self.state.schema_locations.read().clone();
        Self {
            state: Arc::new(SessionState {
                catalog: RwLock::new(catalog),
                warehouse: RwLock::new(warehouse),
                schema_locations: RwLock::new(schema_locations),
            }),
            policy: self.policy.clone(),
        }
    }

    /// The folder (or object prefix) where `CREATE TABLE name AS ...` writes
    /// `name/` as Parquet; without one, created tables stay in memory.
    pub fn set_warehouse(&self, path: Option<&str>, storage: &StorageOptions) {
        *self.state.warehouse.write() = path.map(|p| (p.to_string(), storage.clone()));
    }

    pub fn warehouse(&self) -> Option<(String, StorageOptions)> {
        self.state.warehouse.read().clone()
    }

    /// A schema named for the registry: `s` (in the default catalog) or `c.s`.
    fn registry_schema(&self, schema: &str) -> Result<SchemaName> {
        Ok(SchemaSpec::parse(schema)?.in_catalog(&self.default_catalog()))
    }

    /// The folder (or object prefix) where `CREATE TABLE schema.name AS ...`
    /// writes `name/`, instead of the warehouse; `None` removes it. The schema
    /// is `s` (of the default catalog) or `c.s`.
    pub fn set_schema_location(&self, schema: &str, path: Option<&str>, storage: &StorageOptions) -> Result<()> {
        let key = self.registry_schema(schema)?;
        let mut map = self.state.schema_locations.write();
        match path {
            Some(p) => map.insert(key, (p.to_string(), storage.clone())),
            None => map.remove(&key),
        };
        Ok(())
    }

    /// The location of a schema named like in [`Self::set_schema_location`].
    pub fn schema_location(&self, schema: &str) -> Option<(String, StorageOptions)> {
        self.schema_location_of(&self.registry_schema(schema).ok()?)
    }

    pub(crate) fn schema_location_of(&self, schema: &SchemaName) -> Option<(String, StorageOptions)> {
        self.state.schema_locations.read().get(schema).cloned()
    }

    /// A table name given to the registry: relative to the default catalog
    /// (`main`'s schema when bare), whatever the current catalog and schema are.
    fn exact(&self, name: &str) -> TableName {
        TableRef::lenient(name).with_defaults(&self.default_catalog(), MAIN)
    }

    /// Whether a table or view of that name is registered (without loading
    /// it). Like every call taking a table name but `sql`, a name is relative
    /// to the default catalog (bare: its `main` schema), whatever `USE` says.
    pub fn contains(&self, name: &str) -> bool {
        self.table_exists(&self.exact(name))
    }

    pub fn table_exists(&self, name: &TableName) -> bool {
        self.state.catalog.read().tables.contains_key(name)
    }

    /// Where a name written in a query resolves to: `c.s.t` exactly, `s.t` in
    /// the current catalog, `t` in the current catalog's current schema and
    /// then its `main`.
    pub fn resolve_table(&self, r: &TableRef) -> Option<TableName> {
        self.state.catalog.read().resolve(r)
    }

    /// What a name written in a query refers to that does not exist (its
    /// catalog or its schema), if that is why it resolves to nothing.
    pub fn unknown_parent(&self, r: &TableRef) -> Option<Missing> {
        self.state.catalog.read().missing_parent(r)
    }

    /// Where a statement that creates a table puts the name it was given:
    /// `c.s.t` there, `s.t` in the current catalog, `t` in the current
    /// catalog and schema. The catalog and the schema must exist.
    pub fn creation_target(&self, r: &TableRef) -> Result<TableName> {
        let catalog = self.state.catalog.read();
        let target = r.with_defaults(&catalog.current_catalog, &catalog.current_schema);
        match catalog.missing_schema(&target.schema_name()) {
            Some(missing) => Err(missing.error()),
            None => Ok(target),
        }
    }

    /// The name people see for a table (see [`TableName::display`]).
    pub fn display_name(&self, name: &TableName) -> String {
        name.display(&self.default_catalog())
    }

    /// The name people see for a schema (see [`SchemaName::display`]).
    pub fn display_schema(&self, schema: &SchemaName) -> String {
        schema.display(&self.default_catalog())
    }

    /// A name registers in its catalog and schema, the catalog existing; a
    /// schema that does not exist yet is created.
    fn put(&self, name: &TableName, slot: Slot) -> Result<()> {
        let mut catalog = self.state.catalog.write();
        // a Delta table replaced by its newer self: plans on the old one follow
        if let (Some(Slot::Entry(TableEntry::Table(old))), Slot::Entry(TableEntry::Table(new))) = (catalog.tables.get(name), &slot) {
            if let Some(d) = old.as_delta() {
                d.set_successor(new.clone());
            }
        } else if let (Some(Slot::Deferred(old)), Slot::Entry(TableEntry::Table(new))) = (catalog.tables.get(name), &slot) {
            if let Some(old) = old.loaded.lock().as_ref().and_then(|o| o.as_delta().map(|_| o.clone())) {
                old.as_delta().expect("delta").set_successor(new.clone());
            }
        }
        catalog.insert(name, slot)
    }

    /// Fail now if the catalog of `name` does not exist (before any loading).
    fn require_catalog(&self, name: &TableName) -> Result<()> {
        if self.has_catalog(&name.catalog) { Ok(()) } else { Err(unknown_catalog(&name.catalog)) }
    }

    pub(crate) fn put_table(&self, name: &TableName, provider: Arc<dyn TableProvider>) -> Result<()> {
        self.put(name, Slot::Entry(TableEntry::Table(provider)))
    }

    pub(crate) fn put_view(&self, name: &TableName, plan: Arc<LogicalPlan>) -> Result<()> {
        self.put(name, Slot::Entry(TableEntry::View(plan)))
    }

    pub(crate) fn put_batches(&self, name: &TableName, schema: SchemaRef, batches: Vec<RecordBatch>) -> Result<()> {
        self.put_table(name, Arc::new(MemTable::new(schema, batches)))
    }

    /// A Delta table at its newest version, opened now.
    pub(crate) fn put_delta(&self, name: &TableName, path: &str, storage: &StorageOptions) -> Result<()> {
        self.put_table(name, Arc::new(crate::delta::DeltaTable::open(path, storage, None)?))
    }

    /// The Parquet files at `path`, listed now.
    pub(crate) fn put_parquet(&self, name: &TableName, path: &str, storage: &StorageOptions) -> Result<()> {
        self.put_table(name, Arc::new(ParquetTable::try_new_with(path, storage)?))
    }

    pub(crate) fn remove_table(&self, name: &TableName) -> bool {
        self.state.catalog.write().tables.remove(name).is_some()
    }

    /// Register a table: relative to the default catalog, which must exist
    /// when the name is `c.s.t`.
    pub fn register_table(&self, name: &str, provider: Arc<dyn TableProvider>) -> Result<()> {
        self.put_table(&self.exact(name), provider)
    }

    pub fn register_view(&self, name: &str, plan: Arc<LogicalPlan>) -> Result<()> {
        self.put_view(&self.exact(name), plan)
    }

    /// Register a table built by `load`: now, or on first use when `lazy`.
    pub fn register_loader(
        &self,
        name: &str,
        lazy: bool,
        load: impl Fn() -> Result<Arc<dyn TableProvider>> + Send + Sync + 'static,
    ) -> Result<()> {
        let name = self.exact(name);
        self.require_catalog(&name)?;
        if lazy {
            self.put(&name, Slot::Deferred(Arc::new(DeferredTable::new(load))))
        } else {
            self.put_table(&name, load()?)
        }
    }

    pub fn deregister(&self, name: &str) -> bool {
        self.remove_table(&self.exact(name))
    }

    pub fn register_parquet(&self, name: &str, path: &str) -> Result<()> {
        self.register_parquet_with(name, path, &StorageOptions::default(), false)
    }

    pub fn register_parquet_with(&self, name: &str, path: &str, storage: &StorageOptions, lazy: bool) -> Result<()> {
        let (path, storage) = (path.to_string(), storage.clone());
        self.register_loader(name, lazy, move || Ok(Arc::new(ParquetTable::try_new_with(&path, &storage)?)))
    }

    pub fn register_csv(&self, name: &str, path: &str, options: CsvOptions) -> Result<()> {
        self.register_csv_with(name, path, options, &StorageOptions::default(), false)
    }

    pub fn register_csv_with(&self, name: &str, path: &str, options: CsvOptions, storage: &StorageOptions, lazy: bool) -> Result<()> {
        let (path, storage) = (path.to_string(), storage.clone());
        self.register_loader(name, lazy, move || Ok(Arc::new(CsvTable::try_new_with(&path, options.clone(), &storage)?)))
    }

    pub fn register_batches(&self, name: &str, schema: SchemaRef, batches: Vec<RecordBatch>) -> Result<()> {
        self.register_table(name, Arc::new(MemTable::new(schema, batches)))
    }

    /// The display names of all the tables, sorted (see [`TableName::display`]).
    /// A restricted context lists only the tables it may read.
    pub fn table_names(&self) -> Vec<String> {
        let catalog = self.state.catalog.read();
        let readable: Vec<TableName> = catalog.tables.keys().filter(|t| self.policy.as_ref().is_none_or(|p| p.covers_table(t))).cloned().collect();
        let mut v = catalog.display(&readable);
        v.sort();
        v
    }

    /// The name of the default catalog.
    pub fn default_catalog(&self) -> String {
        self.state.catalog.read().default.clone()
    }

    /// The catalog that names written in a query are looked in (`USE`).
    pub fn current_catalog(&self) -> String {
        self.state.catalog.read().current_catalog.clone()
    }

    /// The catalogs: the default one first, then the others sorted.
    pub fn catalogs(&self) -> Vec<String> {
        let catalog = self.state.catalog.read();
        let others = catalog.catalogs.keys().filter(|c| **c != catalog.default).cloned();
        std::iter::once(catalog.default.clone()).chain(others).collect()
    }

    pub fn has_catalog(&self, name: &str) -> bool {
        self.state.catalog.read().catalogs.contains_key(&name.to_ascii_lowercase())
    }

    pub fn create_catalog(&self, name: &str, if_not_exists: bool) -> Result<()> {
        let name = parse_catalog(name)?;
        let mut catalog = self.state.catalog.write();
        if catalog.catalogs.contains_key(&name) {
            return if if_not_exists { Ok(()) } else { Err(WhError::Plan(format!("catalog '{name}' already exists"))) };
        }
        catalog.catalogs.insert(name, BTreeSet::from([MAIN.to_string()]));
        Ok(())
    }

    /// Drop a catalog; with `cascade` its schemas and tables leave the session
    /// too (their files stay), otherwise it must hold no table and no schema
    /// but `main`. The default catalog cannot be dropped; dropping the
    /// current one makes the default current. Returns the display names of
    /// the tables dropped.
    pub fn drop_catalog(&self, name: &str, if_exists: bool, cascade: bool) -> Result<Vec<String>> {
        let name = parse_catalog(name)?;
        let mut catalog = self.state.catalog.write();
        if name == catalog.default {
            return Err(WhError::Plan(format!("catalog '{name}' is the default catalog and cannot be dropped")));
        }
        let Some(schemas) = catalog.catalogs.get(&name) else {
            return if if_exists { Ok(vec![]) } else { Err(WhError::Plan(format!("catalog '{name}' does not exist"))) };
        };
        let others = schemas.iter().filter(|s| *s != MAIN).count();
        let tables = catalog.tables_of(&name);
        if (!tables.is_empty() || others > 0) && !cascade {
            return Err(WhError::Plan(format!(
                "catalog '{name}' is not empty ({} tables, {others} schemas besides main): use DROP CATALOG {name} CASCADE",
                tables.len()
            )));
        }
        for t in &tables {
            catalog.tables.remove(t);
        }
        catalog.catalogs.remove(&name);
        if catalog.current_catalog == name {
            catalog.current_catalog = catalog.default.clone();
            catalog.current_schema = MAIN.to_string();
        }
        Ok(catalog.display(&tables))
    }

    /// `USE CATALOG`: names are looked in this catalog from now on, starting
    /// with its `main` schema.
    pub fn use_catalog(&self, name: &str) -> Result<()> {
        let name = parse_catalog(name)?;
        let mut catalog = self.state.catalog.write();
        if !catalog.catalogs.contains_key(&name) {
            return Err(unknown_catalog(&name));
        }
        catalog.current_catalog = name;
        catalog.current_schema = MAIN.to_string();
        Ok(())
    }

    /// The schemas of the current catalog: `main` first, then the others sorted.
    pub fn schemas(&self) -> Vec<String> {
        let catalog = self.state.catalog.read();
        catalog.schemas_of(&catalog.current_catalog).expect("the current catalog exists")
    }

    /// The schemas of a catalog: `main` first, then the others sorted.
    pub fn schemas_of(&self, catalog: &str) -> Result<Vec<String>> {
        let catalog = parse_catalog(catalog)?;
        self.state.catalog.read().schemas_of(&catalog).ok_or_else(|| unknown_catalog(&catalog))
    }

    /// Whether a catalog has a schema.
    pub fn has_schema(&self, catalog: &str, schema: &str) -> bool {
        let name = SchemaName::new(catalog, schema);
        self.state.catalog.read().missing_schema(&name).is_none()
    }

    /// The schema a bare table name in a query is looked up in first (`USE`),
    /// in the current catalog.
    pub fn current_schema(&self) -> String {
        self.state.catalog.read().current_schema.clone()
    }

    /// A schema as SQL writes it, `s` (in the current catalog) or `c.s`; it
    /// need not exist.
    pub fn schema_name(&self, name: &str) -> Result<SchemaName> {
        Ok(SchemaSpec::parse(name)?.in_catalog(&self.current_catalog()))
    }

    /// [`Self::schema_name`] for a schema that must exist; none: the current one.
    pub fn existing_schema(&self, name: Option<&str>) -> Result<SchemaName> {
        let catalog = self.state.catalog.read();
        let schema = match name {
            Some(n) => SchemaSpec::parse(n)?.in_catalog(&catalog.current_catalog),
            None => SchemaName::new(&catalog.current_catalog, &catalog.current_schema),
        };
        match catalog.missing_schema(&schema) {
            Some(missing) => Err(missing.error()),
            None => Ok(schema),
        }
    }

    /// `USE s` (in the current catalog) or `USE c.s`.
    pub fn use_schema(&self, name: &str) -> Result<()> {
        let schema = self.existing_schema(Some(name))?;
        let mut catalog = self.state.catalog.write();
        catalog.current_catalog = schema.catalog;
        catalog.current_schema = schema.schema;
        Ok(())
    }

    /// `s` (in the current catalog) or `c.s`.
    pub fn create_schema(&self, name: &str, if_not_exists: bool) -> Result<()> {
        let schema = self.schema_name(name)?;
        let mut catalog = self.state.catalog.write();
        let label = schema.display(&catalog.default);
        let schemas = catalog.catalogs.get_mut(&schema.catalog).ok_or_else(|| unknown_catalog(&schema.catalog))?;
        if schemas.contains(&schema.schema) {
            return if if_not_exists { Ok(()) } else { Err(WhError::Plan(format!("schema '{label}' already exists"))) };
        }
        schemas.insert(schema.schema);
        Ok(())
    }

    /// Drop a schema (`s` in the current catalog, or `c.s`); with `cascade`
    /// its tables leave the session too (their files stay), otherwise it must
    /// be empty. Returns the display names of the tables dropped.
    pub fn drop_schema(&self, name: &str, if_exists: bool, cascade: bool) -> Result<Vec<String>> {
        let schema = self.schema_name(name)?;
        if schema.schema == MAIN {
            return Err(WhError::Plan("schema 'main' cannot be dropped".into()));
        }
        let mut catalog = self.state.catalog.write();
        let label = schema.display(&catalog.default);
        match catalog.missing_schema(&schema) {
            Some(Missing::Catalog(c)) => return if if_exists { Ok(vec![]) } else { Err(unknown_catalog(&c)) },
            Some(Missing::Schema(_)) => {
                return if if_exists { Ok(vec![]) } else { Err(WhError::Plan(format!("schema '{label}' does not exist"))) };
            }
            None => {}
        }
        let tables = catalog.tables_in(&schema);
        if !tables.is_empty() && !cascade {
            return Err(WhError::Plan(format!(
                "schema '{label}' is not empty ({} tables): use DROP SCHEMA {label} CASCADE",
                tables.len()
            )));
        }
        for t in &tables {
            catalog.tables.remove(t);
        }
        if let Some(schemas) = catalog.catalogs.get_mut(&schema.catalog) {
            schemas.remove(&schema.schema);
        }
        if catalog.current_catalog == schema.catalog && catalog.current_schema == schema.schema {
            catalog.current_schema = MAIN.to_string();
        }
        Ok(catalog.display(&tables))
    }

    /// A registered table or view (loading a deferred table). A name is
    /// relative to the default catalog, like in `register_*`.
    pub fn lookup(&self, name: &str) -> Result<Option<TableEntry>> {
        self.entry(&self.exact(name))
    }

    /// The table or view a name written in a query refers to (see
    /// [`Self::resolve_table`]).
    pub fn lookup_ref(&self, r: &TableRef) -> Result<Option<TableEntry>> {
        match self.resolve_table(r) {
            Some(t) => self.entry(&t),
            None => Ok(None),
        }
    }

    /// Every read of a table goes through here, so a restricted context
    /// refuses an uncovered one before loading it. A view that is covered
    /// may read what it reads: the grant is on the view.
    pub(crate) fn entry(&self, name: &TableName) -> Result<Option<TableEntry>> {
        let slot = self.state.catalog.read().tables.get(name).cloned();
        if slot.is_some() {
            self.check_read(name)?;
        }
        Ok(match slot {
            None => None,
            Some(Slot::Entry(e)) => Some(e),
            Some(Slot::Deferred(d)) => Some(TableEntry::Table(d.resolve()?)),
        })
    }

    /// Whether a registered table is loaded (`Some(false)`: deferred, not
    /// used yet); `None` if there is no such table.
    pub fn is_loaded(&self, name: &str) -> Option<bool> {
        let name = self.exact(name);
        self.state.catalog.read().tables.get(&name).map(|s| match s {
            Slot::Entry(_) => true,
            Slot::Deferred(d) => d.is_loaded(),
        })
    }

    pub fn scan_provider(&self, name: &str, provider: Arc<dyn TableProvider>) -> Result<LazyFrame> {
        Ok(LazyFrame::new(Arc::new(LogicalPlan::scan(name, None, provider, None, vec![], None)?), self.clone()))
    }

    pub fn read_parquet(&self, path: &str) -> Result<LazyFrame> {
        self.read_parquet_with(path, &StorageOptions::default())
    }

    pub fn read_parquet_with(&self, path: &str, storage: &StorageOptions) -> Result<LazyFrame> {
        self.check_files()?;
        self.scan_provider(path, Arc::new(ParquetTable::try_new_with(path, storage)?))
    }

    /// A Delta table, at a version or its newest.
    pub fn read_delta(&self, path: &str, storage: &StorageOptions, version: Option<crate::delta::VersionSpec>) -> Result<LazyFrame> {
        self.check_files()?;
        self.scan_provider(path, Arc::new(crate::delta::DeltaTable::open(path, storage, version)?))
    }

    /// Register a Delta table under `name` (opened on first use when `lazy`).
    pub fn register_delta(&self, name: &str, path: &str, storage: &StorageOptions, version: Option<crate::delta::VersionSpec>, lazy: bool) -> Result<()> {
        let (path, storage) = (path.to_string(), storage.clone());
        self.register_loader(name, lazy, move || Ok(Arc::new(crate::delta::DeltaTable::open(&path, &storage, version)?)))
    }

    pub fn read_csv(&self, path: &str, options: CsvOptions) -> Result<LazyFrame> {
        self.read_csv_with(path, options, &StorageOptions::default())
    }

    pub fn read_csv_with(&self, path: &str, options: CsvOptions, storage: &StorageOptions) -> Result<LazyFrame> {
        self.check_files()?;
        self.scan_provider(path, Arc::new(CsvTable::try_new_with(path, options, storage)?))
    }

    pub fn from_batches(&self, schema: SchemaRef, batches: Vec<RecordBatch>) -> Result<LazyFrame> {
        self.scan_provider("memory", Arc::new(MemTable::new(schema, batches)))
    }

    /// A table or view as a frame, its columns qualified by the bare table name (as in a query).
    fn frame_of(&self, entry: Option<TableEntry>, name: &str) -> Result<LazyFrame> {
        let qualifier = name.rsplit('.').next().unwrap_or(name);
        match entry {
            Some(TableEntry::Table(t)) => Ok(LazyFrame::new(
                Arc::new(LogicalPlan::scan(qualifier, Some(qualifier.to_string()), t, None, vec![], None)?),
                self.clone(),
            )),
            Some(TableEntry::View(p)) => {
                Ok(LazyFrame::new(Arc::new(LogicalPlan::subquery_alias(p, qualifier)), self.clone()))
            }
            None => Err(WhError::Plan(format!("table '{name}' not found"))),
        }
    }

    /// A registered table, named like in `register_*`: relative to the
    /// default catalog (bare: its `main` schema), whatever `USE` says.
    pub fn table(&self, name: &str) -> Result<LazyFrame> {
        self.frame_of(self.lookup(name)?, name)
    }

    /// A table named in a statement (`MERGE ... USING t`): resolved as in a
    /// query, from the current catalog and schema.
    pub(crate) fn query_table(&self, name: &str) -> Result<LazyFrame> {
        let r = TableRef::lenient(name);
        if let Some(missing) = self.unknown_parent(&r) {
            return Err(WhError::Plan(format!("table '{name}' not found: {}", missing.reason())));
        }
        self.frame_of(self.lookup_ref(&r)?, name)
    }

    /// A query, planned (it runs when collected or streamed); or a statement
    /// that writes (`COPY`, `CREATE TABLE ... AS`, `INSERT`, `DROP TABLE`) or
    /// changes the catalog (`CREATE`/`DROP CATALOG`, `CREATE`/`DROP SCHEMA`, `USE`), run now,
    /// returning what it did.
    pub fn sql(&self, query: &str) -> Result<LazyFrame> {
        self.sql_with(query, &Params::None)
    }

    /// [`sql`](Self::sql) with values for the placeholders of the statement:
    /// `$1`, `$2`, `?` (positional) or `:name`, `$name` (named).
    pub fn sql_with(&self, query: &str, params: &Params) -> Result<LazyFrame> {
        match crate::sql::command::parse_command(query)? {
            crate::sql::command::Command::Query => {
                let plan = crate::sql::plan_sql(self, query, params)?;
                Ok(LazyFrame::new(Arc::new(plan), self.clone()))
            }
            _ if self.policy.is_some() => Err(WhError::Plan("only queries are allowed here".into())),
            command => crate::sql::write::run(self, command, params),
        }
    }
}

/// Rewrite expressions that mix aggregates and group keys into
/// `Aggregate(group_by, aggs)` + expressions over its output.
pub struct AggregateRewrite {
    pub plan: LogicalPlan,
    pub exprs: Vec<Expr>,
}

pub fn plan_aggregate(input: Arc<LogicalPlan>, group_by: Vec<Expr>, exprs: Vec<Expr>) -> Result<AggregateRewrite> {
    let in_schema = input.schema().clone();
    // name non-column group expressions
    let group_by: Vec<Expr> = group_by
        .into_iter()
        .map(|g| match g {
            Expr::Column(_) | Expr::Alias(..) => g,
            other => {
                let n = other.output_name();
                other.alias(n)
            }
        })
        .collect();
    let mut aggs: Vec<Expr> = vec![];
    let mut agg_names: Vec<String> = vec![];
    // collect aggregate calls
    for e in &exprs {
        e.visit(&mut |x| {
            if let Expr::Agg { .. } = x {
                let name = x.to_string();
                if !agg_names.contains(&name) {
                    agg_names.push(name.clone());
                    aggs.push(x.clone().alias(name));
                }
                return false;
            }
            true
        });
    }
    let plan = LogicalPlan::aggregate(input, group_by.clone(), aggs)?;
    let out_schema = plan.schema().clone();
    let group_cols: Vec<(Expr, Expr)> = group_by
        .iter()
        .enumerate()
        .map(|(i, g)| (g.clone().unalias(), Expr::Column(out_schema.column(i))))
        .collect();
    let rewritten = exprs
        .into_iter()
        .map(|e| {
            let name = e.output_name();
            let had_alias = matches!(e, Expr::Alias(..));
            let r = e.unalias().transform_down(&mut |x| {
                if let Some((_, c)) = group_cols.iter().find(|(g, _)| *g == x) {
                    return Ok((c.clone(), false));
                }
                if let Expr::Agg { .. } = &x {
                    return Ok((Expr::Column(Column::from_name(x.to_string())), false));
                }
                Ok((x, true))
            })?;
            // verify every column now refers to the aggregate output
            for c in r.column_refs() {
                if !out_schema.has_column(&c) {
                    let exists_below = in_schema.has_column(&c);
                    return Err(WhError::Plan(if exists_below {
                        format!("column '{c}' must appear in GROUP BY or be used in an aggregate function")
                    } else {
                        format!("column '{c}' not found")
                    }));
                }
            }
            let keep_name = had_alias || !matches!(r, Expr::Column(_)) || r.output_name() != name;
            Ok(if keep_name { r.alias(name) } else { r })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(AggregateRewrite { plan, exprs: rewritten })
}

#[derive(Clone)]
pub struct LazyFrame {
    pub plan: Arc<LogicalPlan>,
    ctx: SessionContext,
}

fn qualify(e: Expr, alias: &str) -> Result<Expr> {
    e.transform_up(&mut |x| match x {
        Expr::Column(c) if c.relation.is_none() => Ok(Expr::Column(Column::new(Some(alias.to_string()), c.name))),
        o => Ok(o),
    })
}

impl LazyFrame {
    pub fn new(plan: Arc<LogicalPlan>, ctx: SessionContext) -> Self {
        Self { plan, ctx }
    }

    pub fn context(&self) -> &SessionContext {
        &self.ctx
    }

    fn wrap(&self, plan: LogicalPlan) -> LazyFrame {
        LazyFrame::new(Arc::new(plan), self.ctx.clone())
    }

    pub fn schema(&self) -> &PlanSchemaRef {
        self.plan.schema()
    }

    pub fn filter(&self, predicate: Expr) -> Result<LazyFrame> {
        if predicate.contains_agg() {
            return Err(WhError::Plan("aggregates are not allowed in filter(); use group_by().agg()".into()));
        }
        if predicate.contains_window() {
            // evaluate the windows, filter on them, then drop the helper columns
            let (plan, mut p) = crate::window::plan_windows(self.plan.clone(), vec![predicate])?;
            let filtered = LogicalPlan::filter(Arc::new(plan), p.remove(0).unalias())?;
            let keep = self.schema().fields().iter().map(|f| Expr::Column(f.column())).collect();
            return Ok(self.wrap(LogicalPlan::project(Arc::new(filtered), keep)?));
        }
        Ok(self.wrap(LogicalPlan::filter(self.plan.clone(), predicate)?))
    }

    pub fn select(&self, exprs: Vec<Expr>) -> Result<LazyFrame> {
        if exprs.iter().any(|e| e.contains_window()) {
            let (plan, exprs) = crate::window::plan_windows(self.plan.clone(), exprs)?;
            return LazyFrame::new(Arc::new(plan), self.ctx.clone()).select(exprs);
        }
        if exprs.iter().any(|e| e.contains_agg()) {
            let r = plan_aggregate(self.plan.clone(), vec![], exprs)?;
            return Ok(self.wrap(LogicalPlan::project(Arc::new(r.plan), r.exprs)?));
        }
        Ok(self.wrap(LogicalPlan::project(self.plan.clone(), exprs)?))
    }

    pub fn with_columns(&self, exprs: Vec<Expr>) -> Result<LazyFrame> {
        let schema = self.plan.schema();
        let mut out: Vec<Expr> = vec![];
        let mut used = vec![false; exprs.len()];
        for f in schema.fields() {
            match exprs.iter().position(|e| e.output_name() == *f.name()) {
                Some(i) => {
                    used[i] = true;
                    out.push(exprs[i].clone().alias(f.name()));
                }
                None => out.push(Expr::Column(f.column())),
            }
        }
        for (i, e) in exprs.into_iter().enumerate() {
            if !used[i] {
                out.push(e);
            }
        }
        self.select(out)
    }

    pub fn aggregate(&self, group_by: Vec<Expr>, aggs: Vec<Expr>) -> Result<LazyFrame> {
        let mut exprs: Vec<Expr> = group_by
            .iter()
            .map(|g| match g {
                Expr::Alias(_, n) => Expr::Column(Column::from_name(n.clone())),
                e => e.clone(),
            })
            .collect();
        exprs.extend(aggs);
        let r = plan_aggregate(self.plan.clone(), group_by, exprs)?;
        Ok(self.wrap(LogicalPlan::project(Arc::new(r.plan), r.exprs)?))
    }

    pub fn join(
        &self,
        other: &LazyFrame,
        left_on: Vec<Expr>,
        right_on: Vec<Expr>,
        how: JoinType,
        suffix: &str,
    ) -> Result<LazyFrame> {
        if left_on.len() != right_on.len() {
            return Err(WhError::Plan("left_on and right_on must have the same length".into()));
        }
        let l = Arc::new(LogicalPlan::subquery_alias(self.plan.clone(), "__l"));
        let r = Arc::new(LogicalPlan::subquery_alias(other.plan.clone(), "__r"));
        let on = left_on
            .into_iter()
            .zip(right_on)
            .map(|(a, b)| Ok((qualify(a, "__l")?, qualify(b, "__r")?)))
            .collect::<Result<Vec<_>>>()?;
        let right_keys: Vec<String> = on
            .iter()
            .filter_map(|(_, r)| match r {
                Expr::Column(c) => Some(c.name.clone()),
                _ => None,
            })
            .collect();
        let joined = Arc::new(LogicalPlan::join(l.clone(), r.clone(), on, None, how)?);
        let mut exprs = vec![];
        let left_names: Vec<String> = self.schema().fields().iter().map(|f| f.name().to_string()).collect();
        for n in &left_names {
            exprs.push(Expr::Column(Column::new(Some("__l".into()), n.clone())).alias(n.clone()));
        }
        if !matches!(how, JoinType::Semi | JoinType::Anti) {
            let drop_keys = matches!(how, JoinType::Inner | JoinType::Left);
            for f in other.schema().fields() {
                let n = f.name().to_string();
                if drop_keys && right_keys.contains(&n) {
                    continue;
                }
                let out = if left_names.contains(&n) { format!("{n}{suffix}") } else { n.clone() };
                exprs.push(Expr::Column(Column::new(Some("__r".into()), n)).alias(out));
            }
        }
        Ok(self.wrap(LogicalPlan::project(joined, exprs)?))
    }

    pub fn cross_join(&self, other: &LazyFrame, suffix: &str) -> Result<LazyFrame> {
        self.join(other, vec![], vec![], JoinType::Inner, suffix)
    }

    pub fn sort(&self, by: Vec<SortExpr>) -> Result<LazyFrame> {
        Ok(self.wrap(LogicalPlan::sort(self.plan.clone(), by, None)?))
    }

    pub fn limit(&self, n: usize) -> LazyFrame {
        self.wrap(LogicalPlan::limit(self.plan.clone(), 0, Some(n)))
    }

    pub fn slice(&self, offset: usize, len: Option<usize>) -> LazyFrame {
        self.wrap(LogicalPlan::limit(self.plan.clone(), offset, len))
    }

    pub fn distinct(&self) -> Result<LazyFrame> {
        let cols: Vec<Expr> = self.schema().fields().iter().map(|f| Expr::Column(f.column())).collect();
        Ok(self.wrap(LogicalPlan::aggregate(self.plan.clone(), cols, vec![])?))
    }

    pub fn union(&self, others: &[LazyFrame]) -> Result<LazyFrame> {
        let mut inputs = vec![self.plan.clone()];
        inputs.extend(others.iter().map(|o| o.plan.clone()));
        Ok(self.wrap(LogicalPlan::union(inputs)?))
    }

    pub fn drop(&self, names: &[String]) -> Result<LazyFrame> {
        let exprs: Vec<Expr> = self
            .schema()
            .fields()
            .iter()
            .filter(|f| !names.iter().any(|n| n == f.name()))
            .map(|f| Expr::Column(f.column()))
            .collect();
        self.select(exprs)
    }

    pub fn rename(&self, mapping: &[(String, String)]) -> Result<LazyFrame> {
        let exprs: Vec<Expr> = self
            .schema()
            .fields()
            .iter()
            .map(|f| match mapping.iter().find(|(from, _)| from == f.name()) {
                Some((_, to)) => Expr::Column(f.column()).alias(to.clone()),
                None => Expr::Column(f.column()),
            })
            .collect();
        self.select(exprs)
    }

    /// Polars' `explode`: one row per element of the list columns (several
    /// are zipped), in place of the columns. A NULL or empty list gives one
    /// row holding NULL.
    pub fn explode(&self, columns: &[String]) -> Result<LazyFrame> {
        let helper = |c: &String| format!("__explode_{c}");
        let lists = columns.iter().map(|c| Expr::Column(Column::from_name(c.clone()))).collect();
        let outputs = columns.iter().map(|c| (None, helper(c))).collect();
        let unnest = LogicalPlan::unnest(self.plan.clone(), lists, outputs, true)?;
        let out = self
            .schema()
            .fields()
            .iter()
            .map(|f| match columns.iter().find(|c| c.as_str() == f.name()) {
                Some(c) => Expr::Column(Column::from_name(helper(c))).alias(f.name()),
                None => Expr::Column(f.column()),
            })
            .collect();
        Ok(self.wrap(LogicalPlan::project(Arc::new(unnest), out)?))
    }

    pub fn alias(&self, name: &str) -> LazyFrame {
        self.wrap(LogicalPlan::subquery_alias(self.plan.clone(), name))
    }

    pub fn optimized_plan(&self) -> Result<LogicalPlan> {
        optimize(&self.plan)
    }

    pub fn physical_plan(&self) -> Result<PhysicalPlan> {
        create_physical_plan(&self.optimized_plan()?)
    }

    pub fn explain(&self, optimized: bool) -> Result<String> {
        if !optimized {
            return Ok(self.plan.display_indent());
        }
        let opt = self.optimized_plan()?;
        let phys = create_physical_plan(&opt)?;
        Ok(format!(
            "== Optimized logical plan ==\n{}\n== Physical plan ==\n{}",
            opt.display_indent(),
            phys.display_indent()
        ))
    }

    /// The physical plan as a tree (for display).
    pub fn plan_tree(&self) -> Result<PlanNode> {
        Ok(self.physical_plan()?.tree())
    }

    pub fn collect(&self) -> Result<(SchemaRef, Vec<RecordBatch>)> {
        execute_logical(&self.plan)
    }

    pub fn collect_lazy(&self) -> Result<Collected> {
        with_query(|_| execute_logical_collected(&self.plan))
    }

    /// The result batch by batch, in order, while the query runs (nothing is
    /// collected); returns its schema and run profile.
    pub fn stream(
        &self,
        start: &mut dyn FnMut(&SchemaRef) -> Result<()>,
        emit: &mut (dyn FnMut(RecordBatch) -> Result<()> + Send),
    ) -> Result<(SchemaRef, QueryStats)> {
        stream_logical(&self.plan, start, emit)
    }

    /// Write the result to Parquet (a local path or an object store URL) as it is
    /// produced: one file, or a Hive-partitioned folder with `partition_by`;
    /// returns the number of rows written.
    pub fn sink_parquet(&self, path: &str, opts: &crate::io::parquet::ParquetOptions, storage: &crate::io::StorageOptions) -> Result<usize> {
        Ok(self.sink_parquet_files(path, opts, storage)?.iter().map(|f| f.rows as usize).sum())
    }

    /// [`LazyFrame::sink_parquet`], returning the files written (with their footers).
    pub fn sink_parquet_files(
        &self,
        path: &str,
        opts: &crate::io::parquet::ParquetOptions,
        storage: &crate::io::StorageOptions,
    ) -> Result<Vec<crate::io::output::WrittenFile>> {
        crate::io::parquet::sink_parquet_files(self, path, opts, storage)
    }

    /// Write the result to CSV as it is produced; returns the number of rows written.
    pub fn sink_csv(&self, path: &str, has_header: bool, delimiter: u8, storage: &crate::io::StorageOptions) -> Result<usize> {
        use crate::io::csv::CsvSink;
        let sink = parking_lot::Mutex::new(None::<CsvSink>);
        let rows = std::sync::atomic::AtomicUsize::new(0);
        self.stream(
            &mut |_| {
                *sink.lock() = Some(CsvSink::create(path, has_header, delimiter, storage)?);
                Ok(())
            },
            &mut |b| {
                rows.fetch_add(b.num_rows(), std::sync::atomic::Ordering::Relaxed);
                sink.lock().as_mut().expect("writer").write(&b)
            },
        )?;
        sink.into_inner().expect("writer").finish()?;
        Ok(rows.into_inner())
    }

    /// Collect, also returning the per-pipeline profile of the run.
    pub fn collect_profiled(&self) -> Result<(SchemaRef, Vec<RecordBatch>, QueryStats)> {
        with_query(|q| {
            let (schema, batches) = execute_logical(&self.plan)?;
            Ok((schema, batches, q.stats()))
        })
    }

    pub fn collect_lazy_profiled(&self) -> Result<(Collected, QueryStats)> {
        with_query(|q| {
            let collected = execute_logical_collected(&self.plan)?;
            Ok((collected, q.stats()))
        })
    }
}

pub enum Collected {
    Batches(SchemaRef, Vec<RecordBatch>),
    Sorted {
        schema: SchemaRef,
        batches: Vec<RecordBatch>,
        idx: Arc<[u32]>,
    },
}

/// Optimize, plan and run a logical plan as a (cancellable, observable) query.
pub fn execute_logical(plan: &LogicalPlan) -> Result<(SchemaRef, Vec<RecordBatch>)> {
    with_query(|_| execute_logical_inner(plan))
}

fn execute_logical_inner(plan: &LogicalPlan) -> Result<(SchemaRef, Vec<RecordBatch>)> {
    let opt = optimize(plan)?;
    let phys = create_physical_plan(&opt)?;
    let batches = execute(&phys)?;
    let schema = final_schema(opt.schema(), &phys.schema());
    use rayon::prelude::*;
    let batches = batches.into_par_iter().map(|b| conform(b, &schema)).collect::<Result<Vec<_>>>()?;
    Ok((schema, batches.into_iter().flatten().collect()))
}

fn execute_logical_collected(plan: &LogicalPlan) -> Result<Collected> {
    let opt = optimize(plan)?;
    let phys = create_physical_plan(&opt)?;
    let schema = final_schema(opt.schema(), &phys.schema());
    use rayon::prelude::*;
    if matches!(&phys, PhysicalPlan::Sort { fetch: None, .. }) {
        match crate::physical::execute::execute_sorted(&phys)? {
            crate::exec::sort::Sorted::Gather(g) => {
                let (_, batches, idx) = g.into_parts();
                let batches = batches.into_par_iter().map(|b| conform(b, &schema)).collect::<Result<Vec<_>>>()?;
                let batches = batches.into_iter().flatten().collect();
                return Ok(Collected::Sorted { schema, batches, idx: Arc::from(idx) });
            }
            other => {
                let batches = other.into_batches()?;
                let batches = batches.into_par_iter().map(|b| conform(b, &schema)).collect::<Result<Vec<_>>>()?;
                return Ok(Collected::Batches(schema, batches.into_iter().flatten().collect()));
            }
        }
    }
    let batches = execute(&phys)?;
    let batches = batches.into_par_iter().map(|b| conform(b, &schema)).collect::<Result<Vec<_>>>()?;
    Ok(Collected::Batches(schema, batches.into_iter().flatten().collect()))
}

/// A result batch as the query's final schema says (None: drop it, empty).
fn conform(b: RecordBatch, schema: &SchemaRef) -> Result<Option<RecordBatch>> {
    if b.num_rows() == 0 && !schema.fields().is_empty() {
        return Ok(None);
    }
    // results should not pin the (large) buffers they were sliced from
    let b = crate::exec::ops::compact_batch_views(b)?;
    if b.schema() == *schema {
        return Ok(Some(b));
    }
    let cols = b
        .columns()
        .iter()
        .zip(schema.fields())
        .map(|(c, f)| if c.data_type() == f.data_type() { Ok(c.clone()) } else { arrow::compute::cast(c, f.data_type()) })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(RecordBatch::try_new_with_options(schema.clone(), cols, &RecordBatchOptions::new().with_row_count(Some(b.num_rows())))?))
}

/// Run a plan as a (cancellable, observable) query, streaming its result:
/// `start` gets the result's schema first, then `emit` every batch in order.
pub fn stream_logical(
    plan: &LogicalPlan,
    start: &mut dyn FnMut(&SchemaRef) -> Result<()>,
    emit: &mut (dyn FnMut(RecordBatch) -> Result<()> + Send),
) -> Result<(SchemaRef, QueryStats)> {
    with_query(|q| {
        let opt = optimize(plan)?;
        let phys = create_physical_plan(&opt)?;
        let schema = final_schema(opt.schema(), &phys.schema());
        start(&schema)?;
        let mut out = |b: RecordBatch| -> Result<()> {
            match conform(b, &schema)? {
                Some(b) => emit(b),
                None => Ok(()),
            }
        };
        execute_stream(&phys, &mut out)?;
        Ok((schema, q.stats()))
    })
}

/// A common table expression that is referenced more than once: computed a
/// single time (on first scan) and shared by every reference, so all of them
/// observe exactly the same rows (and the work is not repeated).
#[derive(Debug)]
pub struct MaterializedCte {
    name: String,
    plan: Arc<LogicalPlan>,
    cache: parking_lot::Mutex<Option<Arc<MemTable>>>,
}

impl MaterializedCte {
    pub fn new(name: &str, plan: Arc<LogicalPlan>) -> Self {
        Self { name: name.to_string(), plan, cache: parking_lot::Mutex::new(None) }
    }

    fn table(&self) -> Result<Arc<MemTable>> {
        let mut guard = self.cache.lock();
        if let Some(t) = guard.as_ref() {
            return Ok(t.clone());
        }
        let (schema, batches) = execute_logical(&self.plan)?;
        let schema = Arc::new(arrow::datatypes::Schema::new(
            schema
                .fields()
                .iter()
                .zip(self.plan.schema().fields())
                .map(|(f, l)| f.as_ref().clone().with_name(l.name()))
                .collect::<Vec<_>>(),
        ));
        let batches = batches
            .into_iter()
            .map(|b| RecordBatch::try_new_with_options(schema.clone(), b.columns().to_vec(), &RecordBatchOptions::new().with_row_count(Some(b.num_rows()))))
            .collect::<Result<Vec<_>, _>>()?;
        let t = Arc::new(MemTable::new(schema, batches));
        *guard = Some(t.clone());
        Ok(t)
    }
}

impl TableProvider for MaterializedCte {
    fn schema(&self) -> SchemaRef {
        let s = self.plan.schema().arrow_schema();
        Arc::new(arrow::datatypes::Schema::new(
            s.fields().iter().map(|f| f.as_ref().clone().with_nullable(true)).collect::<Vec<_>>(),
        ))
    }
    fn num_rows(&self) -> Option<usize> {
        Some(crate::physical::planner::estimate_rows(&self.plan) as usize)
    }
    fn kind(&self) -> &'static str {
        "materialized cte"
    }
    fn create_source(
        &self,
        projection: Option<&[usize]>,
        filters: &[Expr],
        fetch: Option<usize>,
    ) -> Result<Arc<dyn crate::exec::pipeline::Source>> {
        let _ = &self.name;
        self.table()?.create_source(projection, filters, fetch)
    }
}

fn final_schema(logical: &PlanSchema, physical: &SchemaRef) -> SchemaRef {
    let fields: Vec<_> = logical
        .fields()
        .iter()
        .zip(physical.fields())
        .map(|(l, p)| arrow::datatypes::Field::new(l.name(), p.data_type().clone(), true))
        .collect();
    Arc::new(arrow::datatypes::Schema::new(fields))
}
