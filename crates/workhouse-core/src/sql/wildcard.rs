//! `*` and `t.*` with `EXCLUDE`, `REPLACE` and `RENAME`.

use sqlparser::ast as sql;

use super::{Scope, SqlPlanner, ident, object_name_parts};
use crate::error::{Result, WhError};
use crate::expr::Expr;

/// The options of one wildcard select item.
pub(super) struct WildcardOpts {
    pub exclude: Vec<String>,
    replace: Vec<(String, sql::Expr)>,
    rename: Vec<(String, String)>,
}

impl WildcardOpts {
    pub fn new(opts: &sql::WildcardAdditionalOptions) -> Result<Self> {
        if opts.opt_ilike.is_some() {
            return Err(WhError::NotSupported("* ILIKE".into()));
        }
        if opts.opt_alias.is_some() {
            return Err(WhError::NotSupported("an alias on *".into()));
        }
        let mut exclude: Vec<String> = match &opts.opt_exclude {
            Some(sql::ExcludeSelectItem::Single(n)) => vec![last_part(n)],
            Some(sql::ExcludeSelectItem::Multiple(v)) => v.iter().map(last_part).collect(),
            None => vec![],
        };
        if let Some(e) = &opts.opt_except {
            exclude.push(ident(&e.first_element));
            exclude.extend(e.additional_elements.iter().map(ident));
        }
        let replace = match &opts.opt_replace {
            Some(r) => r.items.iter().map(|i| (ident(&i.column_name), i.expr.clone())).collect(),
            None => vec![],
        };
        let rename = match &opts.opt_rename {
            Some(sql::RenameSelectItem::Single(i)) => vec![(ident(&i.ident), ident(&i.alias))],
            Some(sql::RenameSelectItem::Multiple(v)) => v.iter().map(|i| (ident(&i.ident), ident(&i.alias))).collect(),
            None => vec![],
        };
        Ok(Self { exclude, replace, rename })
    }

    fn is_empty(&self) -> bool {
        self.exclude.is_empty() && self.replace.is_empty() && self.rename.is_empty()
    }

    /// `columns` (name, expression) after dropping the excluded ones,
    /// replacing and renaming. Every column an option names must exist.
    pub fn apply(&self, planner: &mut SqlPlanner<'_>, columns: Vec<(String, Expr)>, scope: Scope<'_>) -> Result<Vec<Expr>> {
        if self.is_empty() {
            return Ok(columns.into_iter().map(|(_, e)| e).collect());
        }
        let named = self.exclude.iter().chain(self.replace.iter().map(|r| &r.0)).chain(self.rename.iter().map(|r| &r.0));
        for n in named {
            if !columns.iter().any(|(c, _)| c.eq_ignore_ascii_case(n)) {
                return Err(WhError::ColumnNotFound(format!("'{n}' in the * options; available: {:?}", names(&columns))));
            }
        }
        let same = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
        let mut out = vec![];
        for (name, expr) in columns {
            if self.exclude.iter().any(|x| same(x, &name)) {
                continue;
            }
            let mut e = expr;
            if let Some((_, r)) = self.replace.iter().find(|r| same(&r.0, &name)) {
                e = planner.sql_expr(r, scope)?.alias(name.clone());
            }
            if let Some((_, to)) = self.rename.iter().find(|r| same(&r.0, &name)) {
                e = e.unalias().alias(to.clone());
            }
            out.push(e);
        }
        Ok(out)
    }
}

fn last_part(n: &sql::ObjectName) -> String {
    object_name_parts(n).last().cloned().unwrap_or_default()
}

fn names(columns: &[(String, Expr)]) -> Vec<&str> {
    columns.iter().map(|(n, _)| n.as_str()).collect()
}
