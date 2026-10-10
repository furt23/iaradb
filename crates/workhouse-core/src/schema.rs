//! Plan schemas: Arrow fields optionally qualified by a relation name, so SQL
//! like `a.id = b.id` can be resolved after joins.

use std::fmt;
use std::sync::Arc;

use arrow::datatypes::{Field, FieldRef, Schema, SchemaRef};

use crate::error::{Result, WhError};

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Column {
    pub relation: Option<String>,
    pub name: String,
}

impl Column {
    pub fn new(relation: Option<String>, name: impl Into<String>) -> Self {
        Self { relation, name: name.into() }
    }
    pub fn from_name(name: impl Into<String>) -> Self {
        Self { relation: None, name: name.into() }
    }
}

impl fmt::Display for Column {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.relation {
            Some(r) => write!(f, "{r}.{}", self.name),
            None => write!(f, "{}", self.name),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct QualifiedField {
    pub qualifier: Option<String>,
    pub field: FieldRef,
}

impl QualifiedField {
    pub fn new(qualifier: Option<String>, field: Field) -> Self {
        Self { qualifier, field: Arc::new(field) }
    }
    pub fn name(&self) -> &str {
        self.field.name()
    }
    pub fn column(&self) -> Column {
        Column::new(self.qualifier.clone(), self.field.name().clone())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlanSchema {
    fields: Vec<QualifiedField>,
    arrow: SchemaRef,
}

pub type PlanSchemaRef = Arc<PlanSchema>;

impl PlanSchema {
    pub fn new(fields: Vec<QualifiedField>) -> Self {
        let arrow = Arc::new(Schema::new(
            fields.iter().map(|f| f.field.clone()).collect::<Vec<_>>(),
        ));
        Self { fields, arrow }
    }

    pub fn empty() -> Self {
        Self::new(vec![])
    }

    pub fn from_arrow(qualifier: Option<&str>, schema: &Schema) -> Self {
        Self::new(
            schema
                .fields()
                .iter()
                .map(|f| QualifiedField {
                    qualifier: qualifier.map(|q| q.to_string()),
                    field: f.clone(),
                })
                .collect(),
        )
    }

    pub fn fields(&self) -> &[QualifiedField] {
        &self.fields
    }
    pub fn field(&self, i: usize) -> &Field {
        &self.fields[i].field
    }
    pub fn qualified_field(&self, i: usize) -> &QualifiedField {
        &self.fields[i]
    }
    pub fn len(&self) -> usize {
        self.fields.len()
    }
    pub fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }
    pub fn arrow_schema(&self) -> &SchemaRef {
        &self.arrow
    }
    pub fn column(&self, i: usize) -> Column {
        self.fields[i].column()
    }
    pub fn columns(&self) -> Vec<Column> {
        self.fields.iter().map(|f| f.column()).collect()
    }

    /// Requalify every field with `alias` (subquery alias / table alias).
    pub fn with_qualifier(&self, alias: &str) -> Self {
        Self::new(
            self.fields
                .iter()
                .map(|f| QualifiedField { qualifier: Some(alias.to_string()), field: f.field.clone() })
                .collect(),
        )
    }

    pub fn join(left: &PlanSchema, right: &PlanSchema) -> Self {
        let mut fields = left.fields.clone();
        fields.extend(right.fields.iter().cloned());
        Self::new(fields)
    }

    fn matches(&self, col: &Column, case_insensitive: bool) -> Vec<usize> {
        let eq = |a: &str, b: &str| if case_insensitive { a.eq_ignore_ascii_case(b) } else { a == b };
        self.fields
            .iter()
            .enumerate()
            .filter(|(_, f)| {
                eq(f.field.name(), &col.name)
                    && match (&col.relation, &f.qualifier) {
                        (None, _) => true,
                        (Some(r), Some(q)) => eq(r, q),
                        (Some(_), None) => false,
                    }
            })
            .map(|(i, _)| i)
            .collect()
    }

    pub fn maybe_index_of(&self, col: &Column) -> Result<Option<usize>> {
        for ci in [false, true] {
            let m = self.matches(col, ci);
            match m.len() {
                0 => continue,
                1 => return Ok(Some(m[0])),
                _ => {
                    return Err(WhError::Plan(format!(
                        "ambiguous column reference '{col}' (candidates: {})",
                        m.iter()
                            .map(|i| self.fields[*i].column().to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )));
                }
            }
        }
        // `a.b` written as a single name (e.g. from the Python API)
        if col.relation.is_none() {
            if let Some((rel, name)) = col.name.split_once('.') {
                return self.maybe_index_of(&Column::new(Some(rel.to_string()), name));
            }
        }
        Ok(None)
    }

    pub fn index_of(&self, col: &Column) -> Result<usize> {
        match self.maybe_index_of(col)? {
            Some(i) => Ok(i),
            None => Err(WhError::ColumnNotFound(format!(
                "'{col}' not found. Available columns: [{}]",
                self.fields
                    .iter()
                    .map(|f| f.column().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))),
        }
    }

    pub fn has_column(&self, col: &Column) -> bool {
        matches!(self.maybe_index_of(col), Ok(Some(_)))
    }
}

impl fmt::Display for PlanSchema {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let parts: Vec<String> = self
            .fields
            .iter()
            .map(|fl| format!("{}: {}", fl.column(), crate::nested::type_name(fl.field.data_type())))
            .collect();
        write!(f, "[{}]", parts.join(", "))
    }
}
