//! `UPDATE`: copy-on-write. The files holding a row the predicate is true for
//! are found as for `delete`; each is rewritten with
//! `CASE WHEN pred THEN new ELSE old END` for the assigned columns (a NULL
//! predicate leaves the row alone), the new value cast to the column's type.
//! The rewritten rows go through the partitioned writer, so a row whose
//! partition column changes lands in its new partition. One commit holds the
//! removals and the new files; nothing is committed if no row matches.

use super::check_not_append_only;
use super::rewrite::{DmlSummary, Target, predicates_param, rows_written};
use crate::delta::provider::DeltaTable;
use crate::error::{Result, WhError};
use crate::expr::Expr;
use crate::session::SessionContext;

/// Set `assignments` (column, new value) on the rows of `table` that `predicate` is true for (all
/// rows without one). The values may read any column of the row. `alias` names the table in the
/// expressions; columns can always be written bare.
pub fn update(ctx: &SessionContext, table: &DeltaTable, alias: Option<&str>, assignments: Vec<(String, Expr)>, predicate: Option<Expr>) -> Result<DmlSummary> {
    if assignments.is_empty() {
        return Err(WhError::Plan("UPDATE needs at least one assignment".into()));
    }
    let t = Target::new(ctx, table, alias)?;
    let set = t.resolve_assignments(assignments)?;
    let snapshot = table.snapshot();
    if snapshot.files.is_empty() {
        return Ok(t.unchanged());
    }
    check_not_append_only(snapshot)?;
    let mut txn = t.transaction("UPDATE");
    let (touched, updated) = match &predicate {
        None => (t.all(), t.total_rows(&t.all())?),
        Some(p) => {
            let counts = t.matches(p)?;
            txn = txn.parameter("predicate", predicates_param(&[p]));
            (counts.iter().map(|(i, _)| *i).collect(), counts.iter().map(|(_, n)| n).sum())
        }
    };
    if touched.is_empty() {
        return Ok(t.unchanged());
    }
    let outputs: Vec<Expr> = t
        .columns
        .iter()
        .enumerate()
        .map(|(k, (name, ty))| {
            let old = t.col(name);
            let new = match set.iter().find(|(j, _)| *j == k) {
                None => old,
                Some((_, value)) => {
                    let value = value.clone().cast(ty.clone());
                    match &predicate {
                        None => value,
                        Some(p) => Expr::Case { when_then: vec![(p.clone(), value)], otherwise: Some(Box::new(old)) },
                    }
                }
            };
            new.alias(name.clone())
        })
        .collect();
    let mut written = vec![];
    for group in t.groups(&touched) {
        written.push(t.write(&t.scan(&group)?.select(outputs.clone())?)?);
    }
    let copied = rows_written(&written).saturating_sub(updated);
    txn = txn.metric("numUpdatedRows", updated as i64).metric("numCopiedRows", copied as i64);
    let version = t.commit(txn, &touched, &mut written)?;
    Ok(t.summary(version, updated, &touched, &written))
}
