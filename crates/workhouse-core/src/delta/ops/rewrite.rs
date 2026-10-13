//! What the copy-on-write DML operations (`delete`, `update`, `merge`) share:
//! the table's files as a scan that knows which file each row comes from,
//! rewriting groups of files through the partitioned writer, and the commit.
//!
//! Row-to-file attribution: the scan of the active files is a
//! [`ParquetTable::from_files`] table with one more partition column,
//! [`FILE_COLUMN`], whose value for each file is the file's index in the
//! snapshot. Like any partition value it is known per file before the file is
//! read, costs nothing per row, and lets one query count, join or rewrite the
//! rows of many files at once; the engine spills what does not fit in memory.
//!
//! Files that hold no row a statement changes are never rewritten. Files that
//! are rewritten go through [`write_data_files`] like any other write, so rows
//! land in the folder of their (possibly new) partition values. Rewrites are
//! grouped by size, one query each; if anything fails before the commit, the
//! files written ([`DataFiles`]) delete themselves.

use std::sync::Arc;

use arrow::array::{Array, Int64Array};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

use super::{check_writable, now_ms};
use crate::delta::actions::{Action, Remove};
use crate::delta::log_store::LogStore;
use crate::delta::provider::{DeltaTable, table_files};
use crate::delta::txn::Transaction;
use crate::delta::write_files::{DataFiles, write_data_files};
use crate::error::{Result, WhError};
use crate::expr::{Expr, count_star, qcol};
use crate::io::TableProvider;
use crate::io::memory::MemTable;
use crate::io::parquet::file::engine_schema;
use crate::io::parquet::{ParquetTable, TableFile};
use crate::logical::LogicalPlan;
use crate::scalar::Scalar;
use crate::session::{LazyFrame, SessionContext};

/// The hidden column of the scan: the index in the snapshot of the file a row is read from.
pub const FILE_COLUMN: &str = "__wh_file";

/// Compressed bytes of the files one rewrite query reads, at most (a single larger file goes alone).
const GROUP_BYTES: u64 = 1 << 30;

/// What a `delete`, `update` or `merge` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DmlSummary {
    /// the table's version after the statement (the one it read if nothing changed: no commit is made)
    pub version: u64,
    /// rows deleted, updated or inserted
    pub rows_affected: u64,
    /// data files the commit removes
    pub files_removed: usize,
    /// data files the commit adds
    pub files_added: usize,
}

pub fn lit_i64(v: i64) -> Expr {
    Expr::Literal(Scalar::int64(v))
}

pub fn lit_bool(v: bool) -> Expr {
    Expr::Literal(Scalar::boolean(v))
}

/// `CASE WHEN e THEN false ELSE true END`: the rows `e` is not true for (NULL included).
pub fn is_not_true(e: Expr) -> Expr {
    Expr::Case { when_then: vec![(e, lit_bool(false))], otherwise: Some(Box::new(lit_bool(true))) }
}

/// The predicates as the JSON list of text Delta records in `operationParameters`.
pub fn predicates_param(predicates: &[&Expr]) -> String {
    serde_json::to_string(&predicates.iter().map(|e| e.to_string()).collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into())
}

/// The whole of column `i` of the batches as integers.
pub fn int_column(batches: &[RecordBatch], i: usize) -> Result<Vec<Option<i64>>> {
    let mut out = vec![];
    for b in batches {
        let c = arrow::compute::cast(b.column(i), &DataType::Int64)?;
        out.extend(c.as_any().downcast_ref::<Int64Array>().expect("an Int64 array").iter());
    }
    Ok(out)
}

/// A table being changed: its snapshot's files, scanned with their index.
pub struct Target<'a> {
    pub ctx: &'a SessionContext,
    pub table: &'a DeltaTable,
    /// what the columns of the table are called in expressions (`UPDATE t AS x`)
    pub alias: String,
    files: Vec<TableFile>,
    /// the table's columns and the types the scan gives them
    pub columns: Vec<(String, DataType)>,
}

impl<'a> Target<'a> {
    pub fn new(ctx: &'a SessionContext, table: &'a DeltaTable, alias: Option<&str>) -> Result<Target<'a>> {
        let snapshot = table.snapshot();
        check_writable(snapshot)?;
        let (files, _) = table_files(table.root(), snapshot);
        let columns = engine_schema(&snapshot.schema).fields().iter().map(|f| (f.name().clone(), f.data_type().clone())).collect();
        Ok(Target { ctx, table, alias: alias.unwrap_or("target").to_string(), files, columns })
    }

    /// The summary of a statement that changed nothing.
    pub fn unchanged(&self) -> DmlSummary {
        DmlSummary { version: self.table.version(), rows_affected: 0, files_removed: 0, files_added: 0 }
    }

    /// Every file of the snapshot (indexes into `snapshot.files`).
    pub fn all(&self) -> Vec<usize> {
        (0..self.files.len()).collect()
    }

    /// Rows of file `i` according to the log, if it says.
    pub fn num_records(&self, i: usize) -> Option<u64> {
        self.files[i].stats.as_ref().and_then(|s| s.num_records)
    }

    /// A column of the target in expressions.
    pub fn col(&self, name: &str) -> Expr {
        qcol(&self.alias, name)
    }

    /// Every column of the table, in the table's order, as plain names.
    pub fn identity(&self) -> Vec<Expr> {
        self.columns.iter().map(|(n, _)| self.col(n).alias(n.clone())).collect()
    }

    /// The columns an assignment list names (case-insensitively), as indexes into [`Target::columns`].
    pub fn resolve_assignments(&self, set: Vec<(String, Expr)>) -> Result<Vec<(usize, Expr)>> {
        let mut out: Vec<(usize, Expr)> = vec![];
        for (name, value) in set {
            let name = name.rsplit('.').next().unwrap_or(&name).to_string();
            let k = self
                .columns
                .iter()
                .position(|(c, _)| c == &name)
                .or_else(|| self.columns.iter().position(|(c, _)| c.eq_ignore_ascii_case(&name)))
                .ok_or_else(|| WhError::Plan(format!("cannot assign to '{name}': the table has no such column")))?;
            if out.iter().any(|(j, _)| *j == k) {
                return Err(WhError::Plan(format!("column '{}' is assigned twice", self.columns[k].0)));
            }
            out.push((k, value));
        }
        Ok(out)
    }

    /// The rows of these files (`FILE_COLUMN` as the last column; the target's alias qualifies every column).
    pub fn scan(&self, files: &[usize]) -> Result<LazyFrame> {
        let snapshot = self.table.snapshot();
        let mut fields: Vec<Field> = snapshot.schema.fields().iter().map(|f| f.as_ref().clone()).collect();
        fields.push(Field::new(FILE_COLUMN, DataType::Int64, true));
        let schema = Schema::new(fields);
        let provider: Arc<dyn TableProvider> = if files.is_empty() {
            Arc::new(MemTable::new(Arc::new(engine_schema(&schema)), vec![]))
        } else {
            let listed = files
                .iter()
                .map(|&i| {
                    let mut f = self.files[i].clone();
                    f.partition_values.push(Some(i.to_string()));
                    f
                })
                .collect();
            let mut partitions = snapshot.partition_columns.clone();
            partitions.push(FILE_COLUMN.to_string());
            Arc::new(ParquetTable::from_files(listed, &schema, &partitions, self.table.storage())?)
        };
        let plan = LogicalPlan::scan(&self.alias, Some(self.alias.clone()), provider, None, vec![], None)?;
        Ok(LazyFrame::new(Arc::new(plan), self.ctx.clone()))
    }

    /// The rows of the table `predicate` is true for, counted by file: files that
    /// statistics and partition values rule out are not read. Files without a match are not listed.
    pub fn matches(&self, predicate: &Expr) -> Result<Vec<(usize, u64)>> {
        let counted = self
            .scan(&self.all())?
            .filter(predicate.clone())?
            .aggregate(vec![self.col(FILE_COLUMN).alias("f")], vec![count_star().alias("n")])?;
        let (_, batches) = counted.collect()?;
        let (files, counts) = (int_column(&batches, 0)?, int_column(&batches, 1)?);
        let mut out: Vec<(usize, u64)> =
            files.into_iter().zip(counts).filter_map(|(f, n)| Some((f? as usize, n?.max(0) as u64))).filter(|(_, n)| *n > 0).collect();
        out.sort_unstable();
        Ok(out)
    }

    /// Rows of these files: from the log when it counts them all, else by reading.
    pub fn total_rows(&self, files: &[usize]) -> Result<u64> {
        let known: Option<u64> = files.iter().map(|&i| self.num_records(i)).sum();
        if let Some(n) = known {
            return Ok(n);
        }
        let (_, batches) = self.scan(files)?.aggregate(vec![], vec![count_star().alias("n")])?.collect()?;
        Ok(int_column(&batches, 0)?.first().copied().flatten().unwrap_or(0).max(0) as u64)
    }

    /// The files in groups for rewriting, each of at most [`GROUP_BYTES`].
    pub fn groups(&self, files: &[usize]) -> Vec<Vec<usize>> {
        let (mut out, mut group, mut bytes) = (vec![], vec![], 0u64);
        for &i in files {
            let size = self.files[i].size;
            if !group.is_empty() && bytes + size > GROUP_BYTES {
                out.push(std::mem::take(&mut group));
                bytes = 0;
            }
            group.push(i);
            bytes += size;
        }
        if !group.is_empty() {
            out.push(group);
        }
        out
    }

    /// Write the rows of `lf` (the table's columns, by name) as new data files.
    pub fn write(&self, lf: &LazyFrame) -> Result<DataFiles> {
        let snapshot = self.table.snapshot();
        write_data_files(lf, self.table.root(), self.table.storage(), &snapshot.partition_columns, &snapshot.schema)
    }

    /// A transaction on the version read, which depends on the files the table held.
    pub fn transaction(&self, operation: &str) -> Transaction {
        Transaction::new(Some(self.table.version()), operation).reads_table(true)
    }

    /// Commit the removal of `removed` files and the addition of the `written` ones; the
    /// written files are kept once the commit is in the log, deleted if it fails.
    pub fn commit(&self, mut txn: Transaction, removed: &[usize], written: &mut [DataFiles]) -> Result<u64> {
        let log = LogStore::open(self.table.root(), self.table.storage())?;
        let now = now_ms();
        txn.extend(removed.iter().map(|&i| Action::Remove(Remove::of(&self.table.snapshot().files[i], now, true))));
        for d in written.iter() {
            txn.extend(d.adds.iter().cloned().map(Action::Add));
        }
        let version = txn.commit(&log)?;
        for d in written.iter_mut() {
            d.keep();
        }
        Ok(version)
    }

    /// The summary of a committed statement.
    pub fn summary(&self, version: u64, rows_affected: u64, removed: &[usize], written: &[DataFiles]) -> DmlSummary {
        DmlSummary { version, rows_affected, files_removed: removed.len(), files_added: written.iter().map(|d| d.adds.len()).sum() }
    }
}

/// Rows written by the files.
pub fn rows_written(written: &[DataFiles]) -> u64 {
    written.iter().map(|d| d.rows).sum()
}
