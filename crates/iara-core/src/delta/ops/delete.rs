//! `DELETE FROM`: copy-on-write. The files holding a row the predicate is
//! true for are found with the statistics and partition values of the log
//! and one counting query; a file whose rows all match is just removed, the
//! others are rewritten without the matching rows. Rows the predicate is NULL
//! for stay (`pred IS NOT TRUE`). Without a predicate every file is removed.
//! One commit holds the removals and the new files; nothing is committed if
//! no row matches.

use super::check_not_append_only;
use super::rewrite::{DmlSummary, Target, is_not_true, predicates_param, rows_written};
use crate::delta::provider::DeltaTable;
use crate::error::Result;
use crate::expr::Expr;
use crate::session::SessionContext;

/// Delete the rows of `table` that `predicate` is true for (all rows without one). `alias`
/// names the table in the predicate (`DELETE FROM t AS x WHERE x.id > 1`); columns can always
/// be written bare.
pub fn delete(ctx: &SessionContext, table: &DeltaTable, alias: Option<&str>, predicate: Option<Expr>) -> Result<DmlSummary> {
    let t = Target::new(ctx, table, alias)?;
    let snapshot = table.snapshot();
    if snapshot.files.is_empty() {
        return Ok(t.unchanged());
    }
    check_not_append_only(snapshot)?;
    let mut txn = t.transaction("DELETE");
    let (removed, deleted, copied, mut written) = match &predicate {
        None => (t.all(), t.total_rows(&t.all())?, 0, vec![]),
        Some(p) => {
            let counts = t.matches(p)?;
            if counts.is_empty() {
                return Ok(t.unchanged());
            }
            txn = txn.parameter("predicate", predicates_param(&[p]));
            // files whose every row matches need no rewrite
            let (whole, partial): (Vec<(usize, u64)>, Vec<(usize, u64)>) = counts.iter().copied().partition(|(i, n)| t.num_records(*i) == Some(*n));
            let partial: Vec<usize> = partial.into_iter().map(|(i, _)| i).collect();
            let mut written = vec![];
            for group in t.groups(&partial) {
                let kept = t.scan(&group)?.filter(is_not_true(p.clone()))?.select(t.identity())?;
                written.push(t.write(&kept)?);
            }
            let removed: Vec<usize> = whole.iter().map(|(i, _)| *i).chain(partial).collect();
            let copied = rows_written(&written);
            (removed, counts.iter().map(|(_, n)| n).sum(), copied, written)
        }
    };
    txn = txn.metric("numDeletedRows", deleted as i64).metric("numCopiedRows", copied as i64);
    let version = t.commit(txn, &removed, &mut written)?;
    Ok(t.summary(version, deleted, &removed, &written))
}
