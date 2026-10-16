//! SQL for structs: `{'a': 1}` literals, `struct_pack(a := 1)`, `row(..)`,
//! `named_struct('a', 1)`, `s.a` / `s['a']` / `(expr).a`, `unnest(s)` and `s.*`.

use sqlparser::ast as sql;

use super::{Scope, SqlPlanner, ident};
use crate::error::{Result, WhError};
use crate::expr::{Expr, ScalarFunc};
use crate::nested::struct_fields;
use crate::scalar::Scalar;

fn name_lit(name: &str) -> Expr {
    Expr::Literal(Scalar::utf8(name))
}

fn extract(s: Expr, field: &str) -> Expr {
    Expr::Function { func: ScalarFunc::StructExtract, args: vec![s, name_lit(field)] }
}

/// A function argument as (its name, its expression). `a := 1` and `a => 1`
/// name the argument; `a = 1` is a comparison, the parser reads it as a name too.
pub(super) fn split_argument(a: &sql::FunctionArg) -> Option<(Option<String>, sql::Expr)> {
    let compare = |left: sql::Expr, right: &sql::Expr| sql::Expr::BinaryOp {
        left: Box::new(left),
        op: sql::BinaryOperator::Eq,
        right: Box::new(right.clone()),
    };
    match a {
        sql::FunctionArg::Unnamed(sql::FunctionArgExpr::Expr(x)) => Some((None, x.clone())),
        sql::FunctionArg::Named { name, arg: sql::FunctionArgExpr::Expr(x), operator } => {
            if matches!(operator, sql::FunctionArgOperator::Equals) {
                return Some((None, compare(sql::Expr::Identifier(name.clone()), x)));
            }
            Some((Some(ident(name)), x.clone()))
        }
        sql::FunctionArg::ExprNamed { name, arg: sql::FunctionArgExpr::Expr(x), operator } => {
            if matches!(operator, sql::FunctionArgOperator::Equals) {
                return Some((None, compare(name.clone(), x)));
            }
            let field = match name {
                sql::Expr::Identifier(id) => Some(ident(id)),
                sql::Expr::Value(v) => v.value.clone().into_string(),
                _ => None,
            };
            Some((field, x.clone()))
        }
        _ => None,
    }
}

impl<'a> SqlPlanner<'a> {
    /// `{'a': 1, 'b': x}`.
    pub(super) fn sql_dictionary(&mut self, fields: &[sql::DictionaryField], scope: Scope<'_>) -> Result<Expr> {
        let mut args = vec![];
        for f in fields {
            args.push(name_lit(&ident(&f.key)));
            args.push(self.sql_expr(&f.value, scope)?);
        }
        Ok(Expr::Function { func: ScalarFunc::StructPack, args })
    }

    /// The struct functions with named arguments: `struct_pack(a := 1)`,
    /// `struct_insert(s, b := 2)`; `named_struct('a', 1)` already has its names
    /// as constants, and `row(x, y)` / `struct(x, y)` name fields after the
    /// column or `v1`, `v2`, ...
    pub(super) fn struct_call(name: &str, args: Vec<Expr>, names: Vec<Option<String>>) -> Result<Option<Expr>> {
        match name {
            "named_struct" => Ok(Some(Expr::Function { func: ScalarFunc::StructPack, args })),
            "struct_pack" | "row" | "struct" => {
                let mut out = vec![];
                for (i, (a, n)) in args.into_iter().zip(names).enumerate() {
                    let field = n.or_else(|| match name {
                        "struct_pack" => None,
                        _ => Some(positional_name(&a, i)),
                    });
                    let field = field.ok_or_else(|| WhError::Sql("struct_pack arguments need names: struct_pack(a := 1)".into()))?;
                    out.push(name_lit(&field));
                    out.push(a);
                }
                Ok(Some(Expr::Function { func: ScalarFunc::StructPack, args: out }))
            }
            "struct_insert" => {
                let mut it = args.into_iter().zip(names);
                let (base, _) = it.next().ok_or_else(|| WhError::Sql("struct_insert(struct, name := value, ..)".into()))?;
                let mut out = vec![base];
                for (a, n) in it {
                    out.push(name_lit(&n.ok_or_else(|| WhError::Sql("struct_insert arguments need names: struct_insert(s, b := 1)".into()))?));
                    out.push(a);
                }
                Ok(Some(Expr::Function { func: ScalarFunc::StructInsert, args: out }))
            }
            _ => Ok(None),
        }
    }

    /// `a.b`, `t.a.b`, `a.b.c`: a table alias wins over a struct field
    /// (`t.s` is the column `s` of `t`, if there is one), as in DuckDB.
    pub(super) fn resolve_compound(&mut self, ids: &[sql::Ident], scope: Scope<'_>) -> Result<Expr> {
        let parts: Vec<String> = ids.iter().map(ident).collect();
        match self.resolve_parts(&parts, scope)? {
            Some(e) => Ok(e),
            // the usual error for the whole name
            None => self.resolve(Some(parts[parts.len() - 2].clone()), parts[parts.len() - 1].clone(), scope),
        }
    }

    /// `[relation.]column` followed by the struct fields in the rest of `parts`.
    pub(super) fn resolve_parts(&mut self, parts: &[String], scope: Scope<'_>) -> Result<Option<Expr>> {
        let n = parts.len();
        for fields in 0..n {
            let base = &parts[..n - fields];
            let found = match base {
                [name] => self.try_resolve(None, name.clone(), scope)?,
                [.., rel, name] => self.try_resolve(Some(rel.clone()), name.clone(), scope)?,
                [] => None,
            };
            if let Some(mut e) = found {
                for f in &parts[n - fields..] {
                    e = self.field_of(e, f, scope)?;
                }
                return Ok(Some(e));
            }
        }
        Ok(None)
    }

    /// The expression a chain of accesses starts from. In `x.s.l[2]` the parser
    /// makes `x` the root and `.s`, `.l` accesses: the leading names are
    /// resolved together, so that a table alias wins over a struct field.
    pub(super) fn subscript_root<'c>(
        &mut self,
        root: &sql::Expr,
        chain: &'c [sql::AccessExpr],
        scope: Scope<'_>,
    ) -> Result<(Expr, &'c [sql::AccessExpr])> {
        let mut parts: Vec<String> = match root {
            sql::Expr::Identifier(id) => vec![ident(id)],
            sql::Expr::CompoundIdentifier(ids) => ids.iter().map(ident).collect(),
            _ => return Ok((self.sql_expr(root, scope)?, chain)),
        };
        let dots = chain.iter().take_while(|a| matches!(a, sql::AccessExpr::Dot(sql::Expr::Identifier(_)))).count();
        for a in &chain[..dots] {
            parts.extend(super::structs::access_field(a));
        }
        match self.resolve_parts(&parts, scope)? {
            Some(e) if dots > 0 => Ok((e, &chain[dots..])),
            _ => Ok((self.sql_expr(root, scope)?, chain)),
        }
    }

    /// The field `name` of the struct expression `e`.
    pub(super) fn field_of(&mut self, e: Expr, name: &str, scope: Scope<'_>) -> Result<Expr> {
        let t = e.data_type(scope.schema)?;
        if struct_fields(&t).is_none() {
            return Err(WhError::Plan(format!("cannot read field '{name}' of {}: not a struct", crate::nested::type_name(&t))));
        }
        let out = extract(e, name);
        // the field must exist: report it here, with the known fields
        out.data_type(scope.schema)?;
        Ok(out)
    }

    /// Whether `e` is a struct (access with `.field` / `['field']` applies).
    pub(super) fn is_struct_expr(e: &Expr, scope: Scope<'_>) -> bool {
        e.data_type(scope.schema).is_ok_and(|t| struct_fields(&t).is_some())
    }

    /// `unnest(s)` of a struct as a whole select item: one column per field.
    pub(super) fn expand_struct_unnest(e: Expr, alias: bool, scope: Scope<'_>) -> Result<Vec<Expr>> {
        let Expr::Function { func: ScalarFunc::Unnest, args } = &e else { return Ok(vec![e]) };
        let [arg] = args.as_slice() else { return Ok(vec![e]) };
        let Some(fields) = arg.data_type(scope.schema).ok().and_then(|t| struct_fields(&t).cloned()) else { return Ok(vec![e]) };
        if alias {
            return Err(WhError::NotSupported("an alias on unnest(struct); alias its fields instead".into()));
        }
        Ok(fields.iter().map(|f| extract(arg.clone(), f.name()).alias(f.name().clone())).collect())
    }

    /// `s.*` where `s` is a struct column.
    pub(super) fn expand_struct_star(&mut self, e: Expr, excluded: &[String], scope: Scope<'_>) -> Result<Option<Vec<Expr>>> {
        let Some(fields) = e.data_type(scope.schema).ok().and_then(|t| struct_fields(&t).cloned()) else { return Ok(None) };
        Ok(Some(
            fields
                .iter()
                .filter(|f| !excluded.iter().any(|x| x.eq_ignore_ascii_case(f.name())))
                .map(|f| extract(e.clone(), f.name()).alias(f.name().clone()))
                .collect(),
        ))
    }
}

/// The field name of an unnamed `row(..)` / `struct(..)` argument.
fn positional_name(a: &Expr, i: usize) -> String {
    match a {
        Expr::Column(c) => c.name.clone(),
        Expr::Alias(_, n) => n.clone(),
        _ => format!("v{}", i + 1),
    }
}

/// `root['field']`, `root.field`: the field a subscript or dot access names.
pub(super) fn access_field(access: &sql::AccessExpr) -> Option<String> {
    match access {
        sql::AccessExpr::Dot(sql::Expr::Identifier(id)) => Some(ident(id)),
        sql::AccessExpr::Subscript(sql::Subscript::Index { index: sql::Expr::Value(v) }) => v.value.clone().into_string(),
        _ => None,
    }
}
