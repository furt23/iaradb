//! `MERGE INTO`: copy-on-write, with SQL's semantics: for each target row and
//! source row, the clauses of the kind that applies (matched, not matched by
//! source; for source rows that match nothing, not matched) are tried in
//! order and the first whose condition is true is the action; none, no change.
//!
//! 1. One query joins the target (every file) with the source and counts, per
//!    file, the rows each clause acts on. Only files with such rows are
//!    rewritten. A merge with no matched and no not-matched-by-source clause
//!    touches no file.
//! 2. If a matched clause updates or deletes, no target row may match two
//!    source rows ("MERGE matched multiple source rows"; only a single
//!    unconditional `DELETE` clause tolerates it), like Delta. When the source
//!    is unique on the equality keys of the `ON` condition that cannot happen
//!    and nothing more is read; otherwise matches are counted per target row.
//! 3. The touched files are rewritten by a left join with the source, one
//!    query per group of files; a merge without matched clauses rewrites as a
//!    semi join (rows kept) plus an anti join (not-matched-by-source actions),
//!    which also keeps rows matching several source rows once.
//! 4. Source rows with no match in the target (an anti join) become new rows by
//!    the `NOT MATCHED` clauses, in new files.
//!
//! One commit holds the removals and all new files; nothing is committed if
//! nothing changes. The source query runs once for each of these steps.

use std::sync::Arc;

use serde_json::json;

use super::check_not_append_only;
use super::rewrite::{DmlSummary, FILE_COLUMN, Target, int_column, lit_bool, lit_i64, rows_written};
use crate::delta::provider::DeltaTable;
use crate::delta::write_files::DataFiles;
use crate::error::{Result, WhError};
use crate::expr::{Expr, Operator, WindowExpr, WindowFrame, WindowFunc, col, count_star, qcol, split_conjunction};
use crate::logical::{JoinType, LogicalPlan};
use crate::scalar::Scalar;
use crate::schema::PlanSchema;
use crate::session::{LazyFrame, SessionContext};

/// The source's marker: true for a source row, NULL where a left join found none.
const MATCHED: &str = "__wh_matched";
const ACTION: &str = "__wh_action";
const ROW_ID: &str = "__wh_rid";

/// One `WHEN ... THEN ...` of a `MERGE`. Conditions and values may read the target (by its alias)
/// and, except in the not-matched-by-source clauses, the source (by its alias).
#[derive(Debug, Clone)]
pub enum MergeClause {
    /// `WHEN MATCHED [AND cond] THEN UPDATE SET col = value, ...`
    MatchedUpdate { cond: Option<Expr>, set: Vec<(String, Expr)> },
    /// `WHEN MATCHED [AND cond] THEN UPDATE SET *`: the columns the source has by the same name
    /// (case-insensitively); the others keep their values
    MatchedUpdateAll { cond: Option<Expr> },
    /// `WHEN MATCHED [AND cond] THEN DELETE`
    MatchedDelete { cond: Option<Expr> },
    /// `WHEN NOT MATCHED [AND cond] THEN INSERT (cols) VALUES (values)`: the other columns are NULL
    NotMatchedInsert { cond: Option<Expr>, values: Vec<(String, Expr)> },
    /// `WHEN NOT MATCHED [AND cond] THEN INSERT *`: the columns the source has by the same name; the others are NULL
    NotMatchedInsertAll { cond: Option<Expr> },
    /// `WHEN NOT MATCHED BY SOURCE [AND cond] THEN DELETE`
    NotMatchedBySourceDelete { cond: Option<Expr> },
    /// `WHEN NOT MATCHED BY SOURCE [AND cond] THEN UPDATE SET ...`
    NotMatchedBySourceUpdate { cond: Option<Expr>, set: Vec<(String, Expr)> },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Group {
    Matched,
    NotMatched,
    BySource,
}

impl MergeClause {
    fn group(&self) -> Group {
        use MergeClause::*;
        match self {
            MatchedUpdate { .. } | MatchedUpdateAll { .. } | MatchedDelete { .. } => Group::Matched,
            NotMatchedInsert { .. } | NotMatchedInsertAll { .. } => Group::NotMatched,
            NotMatchedBySourceDelete { .. } | NotMatchedBySourceUpdate { .. } => Group::BySource,
        }
    }

    fn cond(&self) -> Option<&Expr> {
        use MergeClause::*;
        match self {
            MatchedUpdate { cond, .. }
            | MatchedUpdateAll { cond }
            | MatchedDelete { cond }
            | NotMatchedInsert { cond, .. }
            | NotMatchedInsertAll { cond }
            | NotMatchedBySourceDelete { cond }
            | NotMatchedBySourceUpdate { cond, .. } => cond.as_ref(),
        }
    }

    fn deletes(&self) -> bool {
        matches!(self, MergeClause::MatchedDelete { .. } | MergeClause::NotMatchedBySourceDelete { .. })
    }

    fn action_type(&self) -> &'static str {
        match self.group() {
            Group::NotMatched => "insert",
            _ if self.deletes() => "delete",
            _ => "update",
        }
    }
}

/// Only the last clause of a kind may lack a condition.
fn check_clauses(clauses: &[MergeClause]) -> Result<()> {
    if clauses.is_empty() {
        return Err(WhError::Plan("MERGE needs at least one WHEN clause".into()));
    }
    for g in [Group::Matched, Group::NotMatched, Group::BySource] {
        let of: Vec<_> = clauses.iter().filter(|c| c.group() == g).collect();
        if of.iter().rev().skip(1).any(|c| c.cond().is_none()) {
            return Err(WhError::Plan("in MERGE only the last clause of a kind (MATCHED, NOT MATCHED, NOT MATCHED BY SOURCE) may omit its condition".into()));
        }
    }
    Ok(())
}

/// `t.col = s.col` conjuncts of the `ON` condition: the source's side of each.
fn source_keys(on: &Expr, source: &PlanSchema, target: &PlanSchema) -> Vec<Expr> {
    let side = |e: &Expr| -> Option<bool> {
        let refs = e.column_refs();
        let (mut in_source, mut in_target) = (false, false);
        for c in &refs {
            let s = source.maybe_index_of(c).ok().flatten().is_some();
            let t = target.maybe_index_of(c).ok().flatten().is_some();
            match (s, t) {
                (true, false) => in_source = true,
                (false, true) => in_target = true,
                _ => return None,
            }
        }
        (in_source != in_target).then_some(in_source)
    };
    split_conjunction(on)
        .into_iter()
        .filter_map(|c| match c {
            Expr::Binary { left, op: Operator::Eq, right } => match (side(&left), side(&right)) {
                (Some(true), Some(false)) => Some(*left),
                (Some(false), Some(true)) => Some(*right),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

struct Merge<'a> {
    t: Target<'a>,
    /// the source with its alias and the [`MATCHED`] marker
    src: LazyFrame,
    source_alias: &'a str,
    on: &'a Expr,
    clauses: &'a [MergeClause],
    /// per clause: the (column, value) pairs an update sets, or an insert's value for every column
    sets: Vec<Vec<(usize, Expr)>>,
    inserts: Vec<Vec<Expr>>,
}

impl Merge<'_> {
    fn join(&self, left: &LazyFrame, right: &LazyFrame, kind: JoinType) -> Result<LazyFrame> {
        let plan = LogicalPlan::join(left.plan.clone(), right.plan.clone(), vec![], Some(self.on.clone()), kind)?;
        Ok(LazyFrame::new(Arc::new(plan), self.t.ctx.clone()))
    }

    fn of(&self, g: Group) -> Vec<usize> {
        (0..self.clauses.len()).filter(|&i| self.clauses[i].group() == g).collect()
    }

    fn cond(&self, i: usize) -> Expr {
        self.clauses[i].cond().cloned().unwrap_or_else(|| lit_bool(true))
    }

    /// The number (clause + 1) of the first clause of `ix` whose condition is true, else 0.
    fn pick(&self, ix: &[usize]) -> Expr {
        if ix.is_empty() {
            return lit_i64(0);
        }
        Expr::Case { when_then: ix.iter().map(|&i| (self.cond(i), lit_i64(i as i64 + 1))).collect(), otherwise: Some(Box::new(lit_i64(0))) }
    }

    /// What happens to a row of a join: for rows with a source match the matched clauses decide,
    /// for the others the not-matched-by-source ones (either only, when the join has just one kind of row).
    fn action(&self, matched: bool, by_source: bool) -> Expr {
        let marker = qcol(self.source_alias, MATCHED);
        match (matched, by_source) {
            (true, true) => Expr::Case {
                when_then: vec![(marker.is_not_null(), self.pick(&self.of(Group::Matched)))],
                otherwise: Some(Box::new(self.pick(&self.of(Group::BySource)))),
            },
            (true, false) => self.pick(&self.of(Group::Matched)),
            (false, _) => self.pick(&self.of(Group::BySource)),
        }
    }

    fn all_target_rows(&self) -> Result<LazyFrame> {
        self.t.scan(&self.t.all())
    }

    /// (file, clause, rows) for every clause that acts on rows of a file.
    fn touched(&self, matched: bool, by_source: bool) -> Result<Vec<(usize, usize, u64)>> {
        let kind = match (matched, by_source) {
            (true, true) => JoinType::Left,
            (true, false) => JoinType::Inner,
            _ => JoinType::Anti,
        };
        let joined = self.join(&self.all_target_rows()?, &self.src, kind)?;
        let counted = joined
            .select(vec![self.t.col(FILE_COLUMN).alias("f"), self.action(matched, by_source).alias("a")])?
            .filter(col("a").gt(lit_i64(0)))?
            .aggregate(vec![col("f"), col("a")], vec![count_star().alias("n")])?;
        let (_, batches) = counted.collect()?;
        let (f, a, n) = (int_column(&batches, 0)?, int_column(&batches, 1)?, int_column(&batches, 2)?);
        let mut out = vec![];
        for ((f, a), n) in f.into_iter().zip(a).zip(n) {
            if let (Some(f), Some(a), Some(n)) = (f, a, n) {
                out.push((f as usize, a as usize - 1, n.max(0) as u64));
            }
        }
        out.sort_unstable();
        Ok(out)
    }

    /// Error if a target row matches several source rows.
    fn check_single_match(&self) -> Result<()> {
        let many = || WhError::Execution("MERGE matched multiple source rows: a target row matched more than one source row (the source must be unique on the keys)".into());
        let keys = source_keys(self.on, self.src.schema(), self.all_target_rows()?.schema());
        if !keys.is_empty() {
            let keys = keys.into_iter().enumerate().map(|(i, k)| k.alias(format!("__wh_k{i}"))).collect();
            let repeated = self.src.aggregate(keys, vec![count_star().alias("n")])?.filter(col("n").gt(lit_i64(1)))?.limit(1);
            if repeated.collect()?.1.iter().all(|b| b.num_rows() == 0) {
                return Ok(());
            }
        }
        // exact: number the target's rows and count the source rows each matches
        let row_id = Expr::Window(Box::new(WindowExpr {
            func: WindowFunc::RowNumber,
            args: vec![],
            distinct: false,
            filter: None,
            ignore_nulls: false,
            partition_by: vec![self.t.col(FILE_COLUMN)],
            order_by: vec![],
            frame: WindowFrame::whole(),
        }));
        let numbered = self.all_target_rows()?.with_columns(vec![row_id.alias(ROW_ID)])?;
        let joined = self.join(&numbered, &self.src, JoinType::Inner)?;
        let repeated = joined
            .select(vec![self.t.col(FILE_COLUMN).alias("f"), col(ROW_ID)])?
            .aggregate(vec![col("f"), col(ROW_ID)], vec![count_star().alias("n")])?
            .filter(col("n").gt(lit_i64(1)))?
            .limit(1);
        if repeated.collect()?.1.iter().any(|b| b.num_rows() > 0) {
            return Err(many());
        }
        Ok(())
    }

    /// The new value of every column of the rows of the kept clauses: the first clause that
    /// acts on the row sets its columns, the others keep theirs.
    fn rewritten_columns(&self) -> Vec<Expr> {
        let updating: Vec<usize> = (0..self.clauses.len()).filter(|&i| self.clauses[i].group() != Group::NotMatched && !self.clauses[i].deletes()).collect();
        self.t
            .columns
            .iter()
            .enumerate()
            .map(|(k, (name, ty))| {
                let branches: Vec<(Expr, Expr)> = updating
                    .iter()
                    .filter_map(|&i| {
                        let (_, value) = self.sets[i].iter().find(|(j, _)| *j == k)?;
                        Some((col(ACTION).eq(lit_i64(i as i64 + 1)), value.clone().cast(ty.clone())))
                    })
                    .collect();
                let old = self.t.col(name);
                let e = if branches.is_empty() { old } else { Expr::Case { when_then: branches, otherwise: Some(Box::new(old)) } };
                e.alias(name.clone())
            })
            .collect()
    }

    /// Drop the rows a delete clause acts on.
    fn without_deleted(&self, lf: LazyFrame) -> Result<LazyFrame> {
        let codes: Vec<Expr> = (0..self.clauses.len()).filter(|&i| self.clauses[i].deletes()).map(|i| lit_i64(i as i64 + 1)).collect();
        if codes.is_empty() {
            return Ok(lf);
        }
        lf.filter(Expr::InList { expr: Box::new(col(ACTION)), list: codes, negated: true })
    }

    /// The rows of a group of touched files after the merge.
    fn rewrite(&self, group: &[usize], has_matched: bool) -> Result<LazyFrame> {
        let scan = self.t.scan(group)?;
        if has_matched {
            let joined = self.join(&scan, &self.src, JoinType::Left)?.with_columns(vec![self.action(true, true).alias(ACTION)])?;
            return self.without_deleted(joined)?.select(self.rewritten_columns());
        }
        let kept = self.join(&scan, &self.src, JoinType::Semi)?.select(self.t.identity())?;
        let unmatched = self.join(&scan, &self.src, JoinType::Anti)?.with_columns(vec![self.action(false, true).alias(ACTION)])?;
        let changed = self.without_deleted(unmatched)?.select(self.rewritten_columns())?;
        kept.union(&[changed])
    }

    /// The rows the not-matched clauses insert: source rows with no match in the target.
    fn inserted(&self, insert: &[usize]) -> Result<LazyFrame> {
        let new = self.join(&self.src, &self.all_target_rows()?, JoinType::Anti)?;
        let any = if insert.iter().any(|&i| self.clauses[i].cond().is_none()) {
            None
        } else {
            insert.iter().map(|&i| self.cond(i)).reduce(|a, b| a.or(b))
        };
        let new = match any {
            Some(c) => new.filter(c)?,
            None => new,
        };
        let columns = self
            .t
            .columns
            .iter()
            .enumerate()
            .map(|(k, (name, _))| {
                let branches = insert.iter().map(|&i| (self.cond(i), self.inserts[i][k].clone())).collect();
                Expr::Case { when_then: branches, otherwise: None }.alias(name.clone())
            })
            .collect();
        new.select(columns)
    }
}

/// The source with its alias and the marker column.
fn tagged_source(source: &LazyFrame, alias: &str) -> Result<LazyFrame> {
    let mut columns: Vec<Expr> = source.schema().fields().iter().map(|f| Expr::Column(f.column())).collect();
    columns.push(lit_bool(true).alias(MATCHED));
    Ok(source.select(columns)?.alias(alias))
}

/// Merge `source` into `table` by the `on` condition and the `clauses`. `target_alias` and
/// `source_alias` qualify the columns of the two in `on` and in the clauses.
pub fn merge(
    ctx: &SessionContext,
    table: &DeltaTable,
    source: &LazyFrame,
    source_alias: &str,
    target_alias: &str,
    on: Expr,
    clauses: Vec<MergeClause>,
) -> Result<DmlSummary> {
    check_clauses(&clauses)?;
    let t = Target::new(ctx, table, Some(target_alias))?;
    let src = tagged_source(source, source_alias)?;
    let source_column = |name: &str| -> Option<Expr> {
        let found = src.schema().fields().iter().filter(|f| f.name() != MATCHED);
        let found: Vec<_> = found.collect();
        let f = found.iter().find(|f| f.name() == name).or_else(|| found.iter().find(|f| f.name().eq_ignore_ascii_case(name)))?;
        Some(Expr::Column(f.column()))
    };
    let mut sets = vec![];
    let mut inserts = vec![];
    for c in &clauses {
        let (mut set, mut insert) = (vec![], vec![]);
        match c {
            MergeClause::MatchedUpdate { set: s, .. } | MergeClause::NotMatchedBySourceUpdate { set: s, .. } => set = t.resolve_assignments(s.clone())?,
            MergeClause::MatchedUpdateAll { .. } => {
                set = t.columns.iter().enumerate().filter_map(|(k, (name, _))| Some((k, source_column(name)?))).collect();
            }
            MergeClause::NotMatchedInsert { values, .. } => {
                let given = t.resolve_assignments(values.clone())?;
                insert = null_unless(&t, given);
            }
            MergeClause::NotMatchedInsertAll { .. } => {
                let given = t.columns.iter().enumerate().filter_map(|(k, (name, _))| Some((k, source_column(name)?))).collect();
                insert = null_unless(&t, given);
            }
            MergeClause::MatchedDelete { .. } | MergeClause::NotMatchedBySourceDelete { .. } => {}
        }
        sets.push(set);
        inserts.push(insert);
    }
    let m = Merge { t, src, source_alias, on: &on, clauses: &clauses, sets, inserts };
    let snapshot = table.snapshot();

    let matched = m.of(Group::Matched);
    let by_source = m.of(Group::BySource);
    let insert = m.of(Group::NotMatched);
    let (has_matched, has_by_source) = (!matched.is_empty(), !by_source.is_empty());

    // 1. the files with rows to change
    let acting = if has_matched || has_by_source { m.touched(has_matched, has_by_source)? } else { vec![] };
    let mut touched: Vec<usize> = acting.iter().map(|(f, _, _)| *f).collect();
    touched.dedup();
    let rows_of = |pred: &dyn Fn(&MergeClause) -> bool| -> u64 { acting.iter().filter(|(_, c, _)| pred(&clauses[*c])).map(|(_, _, n)| n).sum() };
    let any_delete = clauses.iter().any(|c| c.deletes());
    let updated = rows_of(&|c| !c.deletes());

    // 2. no target row may match two source rows (only one unconditional delete tolerates it)
    let tolerant = matched.len() == 1 && matches!(&clauses[matched[0]], MergeClause::MatchedDelete { cond: None });
    if has_matched && !tolerant && !touched.is_empty() {
        m.check_single_match()?;
    }
    if !touched.is_empty() {
        check_not_append_only(snapshot)?;
    }

    // 3. rewrite the touched files, 4. insert the new rows
    let mut written: Vec<DataFiles> = vec![];
    for group in m.t.groups(&touched) {
        written.push(m.t.write(&m.rewrite(&group, has_matched)?)?);
    }
    let rewritten = rows_written(&written);
    let copied = rewritten.saturating_sub(updated);
    // rows read minus rows kept: exact even when a tolerated delete matched a row twice
    let deleted = if any_delete { m.t.total_rows(&touched)?.saturating_sub(rewritten) } else { 0 };
    let mut inserted_rows = 0;
    if !insert.is_empty() {
        let new = m.t.write(&m.inserted(&insert)?)?;
        inserted_rows = new.rows;
        written.push(new);
    }
    if touched.is_empty() && inserted_rows == 0 {
        return Ok(m.t.unchanged());
    }

    let described = |g: Group| -> String {
        let of: Vec<_> = clauses
            .iter()
            .filter(|c| c.group() == g)
            .map(|c| match c.cond() {
                Some(e) => json!({ "actionType": c.action_type(), "predicate": e.to_string() }),
                None => json!({ "actionType": c.action_type() }),
            })
            .collect();
        serde_json::to_string(&of).unwrap_or_else(|_| "[]".into())
    };
    let txn = m
        .t
        .transaction("MERGE")
        .parameter("predicate", on.to_string())
        .parameter("matchedPredicates", described(Group::Matched))
        .parameter("notMatchedPredicates", described(Group::NotMatched))
        .parameter("notMatchedBySourcePredicates", described(Group::BySource))
        .metric("numTargetRowsInserted", inserted_rows as i64)
        .metric("numTargetRowsUpdated", updated as i64)
        .metric("numTargetRowsDeleted", deleted as i64)
        .metric("numTargetRowsCopied", copied as i64)
        .metric("numOutputRows", rows_written(&written) as i64);
    let version = m.t.commit(txn, &touched, &mut written)?;
    Ok(m.t.summary(version, inserted_rows + updated + deleted, &touched, &written))
}

/// The value of every column of an inserted row: the given one cast to the column's type, else NULL.
fn null_unless(t: &Target, given: Vec<(usize, Expr)>) -> Vec<Expr> {
    t.columns
        .iter()
        .enumerate()
        .map(|(k, (_, ty))| match given.iter().find(|(j, _)| *j == k) {
            Some((_, v)) => v.clone().cast(ty.clone()),
            None => Expr::Literal(Scalar::null()).cast(ty.clone()),
        })
        .collect()
}
