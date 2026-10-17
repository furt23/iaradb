//! Catalog, schema and table names: `table`, `schema.table` and
//! `catalog.schema.table` (Unity Catalog style).
//!
//! Each part is `[A-Za-z_][A-Za-z0-9_]*`, matched case-insensitively and kept
//! lowercase. A table lives in a schema of a catalog; `main` is the schema
//! every catalog has, and the session names its default catalog when it is
//! created (`main` unless told otherwise).

use crate::error::{Result, WhError};

/// The schema every catalog has: always exists, cannot be dropped.
pub const MAIN: &str = "main";

/// The name of the default catalog of a session that was not given another.
pub const DEFAULT_CATALOG: &str = "main";

/// Whether `s` is one valid name part.
pub fn is_valid_part(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A catalog name, validated and lowercased.
pub fn parse_catalog(name: &str) -> Result<String> {
    if is_valid_part(name) {
        return Ok(name.to_ascii_lowercase());
    }
    Err(WhError::Plan(format!("invalid catalog name '{name}': use letters, digits and underscores")))
}

/// The error for a catalog that does not exist.
pub fn unknown_catalog(catalog: &str) -> WhError {
    WhError::Plan(format!("catalog '{catalog}' does not exist (CREATE CATALOG {catalog} first)"))
}

/// The error for a schema that does not exist (`schema` is how it is written: `s` or `c.s`).
pub fn unknown_schema(schema: &str) -> WhError {
    WhError::Plan(format!("schema '{schema}' does not exist (CREATE SCHEMA {schema} first)"))
}

/// What a name refers to that does not exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Missing {
    Catalog(String),
    /// the schema as it is written to refer to it: `s`, or `c.s` outside the default catalog
    Schema(String),
}

impl Missing {
    /// `catalog 'c' does not exist`
    pub fn reason(&self) -> String {
        match self {
            Missing::Catalog(c) => format!("catalog '{c}' does not exist"),
            Missing::Schema(s) => format!("schema '{s}' does not exist"),
        }
    }

    /// The reason, with what to do about it.
    pub fn error(&self) -> WhError {
        match self {
            Missing::Catalog(c) => unknown_catalog(c),
            Missing::Schema(s) => unknown_schema(s),
        }
    }
}

/// A schema of a catalog: both parts lowercase.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SchemaName {
    pub catalog: String,
    pub schema: String,
}

impl SchemaName {
    pub fn new(catalog: &str, schema: &str) -> Self {
        Self { catalog: catalog.to_ascii_lowercase(), schema: schema.to_ascii_lowercase() }
    }

    /// The name people see: `schema` in the default catalog, `catalog.schema` elsewhere.
    pub fn display(&self, default_catalog: &str) -> String {
        if self.catalog == default_catalog { self.schema.clone() } else { format!("{}.{}", self.catalog, self.schema) }
    }
}

/// A schema as written: `schema` (in a catalog told by the context) or `catalog.schema`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaSpec {
    pub catalog: Option<String>,
    pub schema: String,
}

impl SchemaSpec {
    /// `s` or `c.s`, else an error (this also keeps `..` and `/` out of the warehouse paths).
    pub fn parse(name: &str) -> Result<Self> {
        match valid_parts(name).as_deref() {
            Some([s]) => Ok(Self { catalog: None, schema: s.clone() }),
            Some([c, s]) => Ok(Self { catalog: Some(c.clone()), schema: s.clone() }),
            _ => Err(WhError::Plan(format!(
                "invalid schema name '{name}': use letters, digits and underscores, optionally as catalog.schema"
            ))),
        }
    }

    /// The schema in its catalog, `default` when none was written.
    pub fn in_catalog(&self, default: &str) -> SchemaName {
        SchemaName::new(self.catalog.as_deref().unwrap_or(default), &self.schema)
    }
}

/// Where a table lives: all three parts lowercase.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TableName {
    pub catalog: String,
    pub schema: String,
    pub table: String,
}

impl TableName {
    pub fn new(catalog: &str, schema: &str, table: &str) -> Self {
        Self { catalog: catalog.to_ascii_lowercase(), schema: schema.to_ascii_lowercase(), table: table.to_ascii_lowercase() }
    }

    /// The full name, `catalog.schema.table`.
    pub fn key(&self) -> String {
        format!("{}.{}.{}", self.catalog, self.schema, self.table)
    }

    /// The name people see: in the default catalog bare in `main` and
    /// `schema.table` elsewhere; in any other catalog always `catalog.schema.table`.
    pub fn display(&self, default_catalog: &str) -> String {
        if self.catalog != default_catalog {
            return self.key();
        }
        if self.schema == MAIN { self.table.clone() } else { format!("{}.{}", self.schema, self.table) }
    }

    pub fn schema_name(&self) -> SchemaName {
        SchemaName { catalog: self.catalog.clone(), schema: self.schema.clone() }
    }
}

/// A table name as written: `t`, `schema.t` or `catalog.schema.t`. What is not
/// written is told by the context: a bare name is looked in the current schema
/// first, then in `main`; a name with a schema, in the current catalog (a
/// two-part name is never `catalog.table`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableRef {
    /// written only together with the schema
    pub catalog: Option<String>,
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
            Some([t]) => Self { catalog: None, schema: None, table: t.clone() },
            Some([s, t]) => Self { catalog: None, schema: Some(s.clone()), table: t.clone() },
            Some([c, s, t]) => Self { catalog: Some(c.clone()), schema: Some(s.clone()), table: t.clone() },
            _ => Self { catalog: None, schema: None, table: name.to_ascii_lowercase() },
        }
    }

    /// For statements that write: `t`, `s.t` or `c.s.t`, else an error (this
    /// also keeps `..` and `/` out of the warehouse paths).
    pub fn strict(name: &str) -> Result<Self> {
        match valid_parts(name).as_deref() {
            Some([_] | [_, _] | [_, _, _]) => Ok(Self::lenient(name)),
            _ => Err(WhError::Plan(format!(
                "invalid table name '{name}': use letters, digits and underscores, optionally as schema.table or catalog.schema.table"
            ))),
        }
    }

    /// The table with `catalog` and `schema` for whatever was not written.
    pub fn with_defaults(&self, catalog: &str, schema: &str) -> TableName {
        TableName::new(self.catalog.as_deref().unwrap_or(catalog), self.schema.as_deref().unwrap_or(schema), &self.table)
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
    fn catalog_names_are_validated_and_lowercased() {
        assert_eq!(parse_catalog("Lake").unwrap(), "lake");
        for bad in ["a.b", "../x", "", "a b", "1a"] {
            assert!(parse_catalog(bad).unwrap_err().to_string().contains("invalid catalog name"), "{bad}");
        }
        assert_eq!(unknown_catalog("x").to_string(), "Planning error: catalog 'x' does not exist (CREATE CATALOG x first)");
    }

    #[test]
    fn schema_names_are_validated_and_lowercased() {
        assert_eq!(SchemaSpec::parse("TPCH").unwrap(), SchemaSpec { catalog: None, schema: "tpch".into() });
        assert_eq!(SchemaSpec::parse("Lake.TPCH").unwrap(), SchemaSpec { catalog: Some("lake".into()), schema: "tpch".into() });
        for bad in ["a.b.c", "../x", "", "a.", ".a", "a b"] {
            assert!(SchemaSpec::parse(bad).unwrap_err().to_string().contains("invalid schema name"), "{bad}");
        }
        assert_eq!(unknown_schema("s").to_string(), "Planning error: schema 's' does not exist (CREATE SCHEMA s first)");
        assert_eq!(unknown_schema("c.s").to_string(), "Planning error: schema 'c.s' does not exist (CREATE SCHEMA c.s first)");
    }

    #[test]
    fn schemas_take_the_catalog_that_was_not_written() {
        let bare = SchemaSpec::parse("s").unwrap();
        assert_eq!(bare.in_catalog("lake"), SchemaName::new("lake", "s"));
        assert_eq!(SchemaSpec::parse("c.s").unwrap().in_catalog("lake"), SchemaName::new("c", "s"));
        assert_eq!(SchemaName::new("lake", "s").display("lake"), "s");
        assert_eq!(SchemaName::new("c", "s").display("lake"), "c.s");
        assert_eq!(SchemaName::new("c", "main").display("lake"), "c.main");
    }

    #[test]
    fn missing_parts_say_what_to_create() {
        assert_eq!(Missing::Catalog("x".into()).reason(), "catalog 'x' does not exist");
        assert_eq!(Missing::Schema("c.s".into()).reason(), "schema 'c.s' does not exist");
        assert_eq!(Missing::Catalog("x".into()).error().to_string(), unknown_catalog("x").to_string());
        assert_eq!(Missing::Schema("s".into()).error().to_string(), unknown_schema("s").to_string());
    }

    #[test]
    fn table_names_key_and_display() {
        let t = TableName::new("Main", "Main", "Orders");
        assert_eq!((t.key().as_str(), t.display("main").as_str()), ("main.main.orders", "orders"));
        // in the default catalog: bare in `main`, `schema.table` elsewhere
        let t = TableName::new("main", "tpch", "lineitem");
        assert_eq!((t.key().as_str(), t.display("main").as_str()), ("main.tpch.lineitem", "tpch.lineitem"));
        // any other catalog: always the full name, `main` schema included
        assert_eq!(t.display("lake"), "main.tpch.lineitem");
        assert_eq!(TableName::new("lake", "main", "t").display("main"), "lake.main.t");
        assert_eq!(TableName::new("lake", "main", "t").display("lake"), "t");
        assert_eq!(t.schema_name(), SchemaName::new("main", "tpch"));
        // a name with dots in it is a table name all the same
        assert_eq!(TableName::new("c", "main", "my.odd name").key(), "c.main.my.odd name");
    }

    fn lenient(name: &str) -> (Option<String>, Option<String>, String) {
        let r = TableRef::lenient(name);
        (r.catalog, r.schema, r.table)
    }

    fn some(s: &str) -> Option<String> {
        Some(s.to_string())
    }

    #[test]
    fn lenient_reads_bare_qualified_and_three_part_names() {
        assert_eq!(lenient("Orders"), (None, None, "orders".to_string()));
        assert_eq!(lenient("tpch.LineItem"), (None, some("tpch"), "lineitem".to_string()));
        assert_eq!(lenient("main.orders"), (None, some("main"), "orders".to_string()));
        assert_eq!(lenient("Cat.tpch.lineitem"), (some("cat"), some("tpch"), "lineitem".to_string()));
        // not a name: kept whole, bare
        assert_eq!(lenient("Sales 2024"), (None, None, "sales 2024".to_string()));
        assert_eq!(lenient("a.b.c.d"), (None, None, "a.b.c.d".to_string()));
        assert_eq!(lenient("lake.main.Sales 2024"), (None, None, "lake.main.sales 2024".to_string()));
    }

    #[test]
    fn strict_rejects_what_cannot_be_a_table() {
        assert_eq!(TableRef::strict("T").unwrap(), TableRef { catalog: None, schema: None, table: "t".into() });
        assert_eq!(TableRef::strict("s.T").unwrap(), TableRef { catalog: None, schema: some("s"), table: "t".into() });
        assert_eq!(TableRef::strict("C.s.T").unwrap(), TableRef { catalog: some("c"), schema: some("s"), table: "t".into() });
        for bad in ["../x", "a/b", "a.b.c.d", "Sales 2024", "", ".", "s.", ".t", "a..b", "a\\b", "c.s.t."] {
            let e = TableRef::strict(bad).unwrap_err().to_string();
            assert!(e.contains("invalid table name") && e.contains("catalog.schema.table"), "{bad}: {e}");
        }
    }

    #[test]
    fn unwritten_parts_take_the_defaults() {
        let r = TableRef::strict("t").unwrap();
        assert_eq!(r.with_defaults("lake", "tpch").key(), "lake.tpch.t");
        // a schema without a catalog is in the catalog the context says
        assert_eq!(TableRef::strict("main.t").unwrap().with_defaults("lake", "tpch").key(), "lake.main.t");
        assert_eq!(TableRef::strict("c.s.t").unwrap().with_defaults("lake", "tpch").key(), "c.s.t");
    }
}
