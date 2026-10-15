//! Table and schema names: `table` (in schema `main`), `schema.table` and, in
//! queries only, `catalog.schema.table` (the catalog is ignored).
//!
//! Each part is `[A-Za-z_][A-Za-z0-9_]*`, matched case-insensitively and kept
//! lowercase. The catalog registry is keyed by `schema.table`.

use crate::error::{Result, WhError};

/// The default schema: always exists, cannot be dropped.
pub const MAIN: &str = "main";

/// Whether `s` is one valid name part.
pub fn is_valid_part(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A schema name, validated and lowercased.
pub fn parse_schema(name: &str) -> Result<String> {
    if is_valid_part(name) {
        return Ok(name.to_ascii_lowercase());
    }
    Err(WhError::Plan(format!("invalid schema name '{name}': use letters, digits and underscores")))
}

/// The error for a schema that does not exist.
pub fn unknown_schema(schema: &str) -> WhError {
    WhError::Plan(format!("schema '{schema}' does not exist (CREATE SCHEMA {schema} first)"))
}

/// Where a table lives: both parts lowercase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableName {
    pub schema: String,
    pub table: String,
}

impl TableName {
    pub fn new(schema: &str, table: &str) -> Self {
        Self { schema: schema.to_ascii_lowercase(), table: table.to_ascii_lowercase() }
    }

    /// The registry key, `schema.table`.
    pub fn key(&self) -> String {
        format!("{}.{}", self.schema, self.table)
    }

    /// The name people see: bare in `main`, `schema.table` elsewhere.
    pub fn display(&self) -> String {
        if self.schema == MAIN { self.table.clone() } else { self.key() }
    }

    /// From a registry key (the schema is what precedes the first dot).
    pub fn from_key(key: &str) -> Self {
        match key.split_once('.') {
            Some((schema, table)) => Self { schema: schema.into(), table: table.into() },
            None => Self { schema: MAIN.into(), table: key.into() },
        }
    }
}

/// A table name as written: with its schema or without (then the current
/// schema is looked in first, then `main`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableRef {
    pub schema: Option<String>,
    pub table: String,
}

/// The valid, lowercase parts of a dotted name, if every part is valid.
fn valid_parts(name: &str) -> Option<Vec<String>> {
    let parts: Vec<String> = name.split('.').map(str::to_ascii_lowercase).collect();
    parts.iter().all(|p| is_valid_part(p)).then_some(parts)
}

impl TableRef {
    /// A name that is not `t`, `s.t` or `c.s.t` stays one bare name as it is:
    /// registrations never fail.
    pub fn lenient(name: &str) -> Self {
        match valid_parts(name).as_deref() {
            Some([t]) => Self { schema: None, table: t.clone() },
            Some([s, t]) | Some([_, s, t]) => Self { schema: Some(s.clone()), table: t.clone() },
            _ => Self { schema: None, table: name.to_ascii_lowercase() },
        }
    }

    /// For statements that write: `t` or `s.t`, else an error (this also
    /// keeps `..` and `/` out of the warehouse paths).
    pub fn strict(name: &str) -> Result<Self> {
        match valid_parts(name).as_deref() {
            Some([t]) => Ok(Self { schema: None, table: t.clone() }),
            Some([s, t]) => Ok(Self { schema: Some(s.clone()), table: t.clone() }),
            _ => Err(WhError::Plan(format!(
                "invalid table name '{name}': use letters, digits and underscores, optionally as schema.table"
            ))),
        }
    }

    /// The table in its schema, `default` when none was written.
    pub fn in_schema(&self, default: &str) -> TableName {
        TableName::new(self.schema.as_deref().unwrap_or(default), &self.table)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_are_identifiers() {
        for ok in ["a", "_a", "A1", "orders_2024"] {
            assert!(is_valid_part(ok), "{ok}");
        }
        for bad in ["", "1a", "a b", "a-b", "..", "a/b", "a.b", "é"] {
            assert!(!is_valid_part(bad), "{bad}");
        }
    }

    #[test]
    fn schema_names_are_validated_and_lowercased() {
        assert_eq!(parse_schema("TPCH").unwrap(), "tpch");
        assert!(parse_schema("a.b").is_err());
        assert!(parse_schema("../x").is_err());
        assert_eq!(unknown_schema("s").to_string(), "Planning error: schema 's' does not exist (CREATE SCHEMA s first)");
    }

    #[test]
    fn table_names_key_and_display() {
        let t = TableName::new("Main", "Orders");
        assert_eq!((t.key().as_str(), t.display().as_str()), ("main.orders", "orders"));
        let t = TableName::new("tpch", "lineitem");
        assert_eq!((t.key().as_str(), t.display().as_str()), ("tpch.lineitem", "tpch.lineitem"));
        assert_eq!(TableName::from_key("tpch.lineitem"), t);
        assert_eq!(TableName::from_key("main.my.odd name"), TableName::new("main", "my.odd name"));
    }

    fn lenient(name: &str) -> (Option<String>, String) {
        let r = TableRef::lenient(name);
        (r.schema, r.table)
    }

    #[test]
    fn lenient_reads_bare_qualified_and_three_part_names() {
        assert_eq!(lenient("Orders"), (None, "orders".to_string()));
        assert_eq!(lenient("tpch.LineItem"), (Some("tpch".to_string()), "lineitem".to_string()));
        assert_eq!(lenient("main.orders"), (Some("main".to_string()), "orders".to_string()));
        assert_eq!(lenient("cat.tpch.lineitem"), (Some("tpch".to_string()), "lineitem".to_string()));
        // not a name: kept whole, in the default schema
        assert_eq!(lenient("Sales 2024"), (None, "sales 2024".to_string()));
        assert_eq!(lenient("a.b.c.d"), (None, "a.b.c.d".to_string()));
    }

    #[test]
    fn strict_rejects_what_cannot_be_a_table() {
        assert_eq!(TableRef::strict("T").unwrap(), TableRef { schema: None, table: "t".into() });
        assert_eq!(TableRef::strict("s.T").unwrap(), TableRef { schema: Some("s".into()), table: "t".into() });
        for bad in ["../x", "a/b", "s.t.u", "Sales 2024", "", ".", "s.", ".t", "a..b", "a\\b"] {
            let e = TableRef::strict(bad).unwrap_err().to_string();
            assert!(e.contains("invalid table name"), "{bad}: {e}");
        }
    }

    #[test]
    fn unqualified_refs_take_the_default_schema() {
        let r = TableRef::strict("t").unwrap();
        assert_eq!(r.in_schema("tpch").key(), "tpch.t");
        assert_eq!(TableRef::strict("main.t").unwrap().in_schema("tpch").key(), "main.t");
    }
}
