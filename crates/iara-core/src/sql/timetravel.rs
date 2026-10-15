//! Time travel: `FROM t VERSION AS OF n`, `FROM t TIMESTAMP AS OF '...'` (the
//! table must be a Delta table), and the version arguments of `read_delta`.

use std::sync::Arc;

use arrow::array::{Array, Int64Array};
use arrow::datatypes::DataType;
use sqlparser::ast as sql;

use super::{Scope, SqlPlanner};
use crate::catalog_names::TableRef;
use crate::delta::{DeltaTable, VersionSpec};
use crate::error::{Result, WhError};
use crate::logical::LogicalPlan;
use crate::physical::expr::evaluate_constant;
use crate::schema::PlanSchema;
use crate::session::TableEntry;

/// `2026-10-11 12:00:00`, `2026-10-11T12:00:00Z`, `2026-10-11` (UTC unless an offset is given) as milliseconds since the epoch.
pub(super) fn timestamp_millis(s: &str) -> Result<i64> {
    let s = s.trim();
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Ok(t.timestamp_millis());
    }
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M"] {
        if let Ok(t) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            return Ok(t.and_utc().timestamp_millis());
        }
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Ok(d.and_hms_opt(0, 0, 0).expect("midnight").and_utc().timestamp_millis());
    }
    Err(WhError::Sql(format!("invalid timestamp '{s}' (expected 'YYYY-MM-DD HH:MM:SS')")))
}

impl SqlPlanner<'_> {
    /// The version a time travel clause asks for.
    fn version_spec(&mut self, v: &sql::TableVersion) -> Result<VersionSpec> {
        let empty = PlanSchema::empty();
        let (e, is_version) = match v {
            sql::TableVersion::VersionAsOf(e) => (e, true),
            sql::TableVersion::TimestampAsOf(e) => (e, false),
            other => return Err(WhError::NotSupported(format!("table version clause {other:?}"))),
        };
        let x = self.sql_expr(e, Scope::new(&empty, None))?;
        let value = evaluate_constant(&x)?.ok_or_else(|| WhError::Sql(format!("expected a constant after AS OF, got {e}")))?;
        if is_version {
            let n = value.as_i64().filter(|n| *n >= 0).ok_or_else(|| WhError::Sql(format!("VERSION AS OF expects a version number, got {e}")))?;
            return Ok(VersionSpec::Version(n as u64));
        }
        if let Some(text) = value.as_str() {
            return Ok(VersionSpec::Timestamp(timestamp_millis(text)?));
        }
        let micros = arrow::compute::cast(value.array(), &DataType::Timestamp(arrow::datatypes::TimeUnit::Microsecond, None))
            .and_then(|a| arrow::compute::cast(&a, &DataType::Int64))
            .map_err(|_| WhError::Sql(format!("TIMESTAMP AS OF expects a timestamp, got {e}")))?;
        let micros = micros.as_any().downcast_ref::<Int64Array>().and_then(|a| (!a.is_empty() && !a.is_null(0)).then(|| a.value(0)));
        micros.map(|m| VersionSpec::Timestamp(m.div_euclid(1000))).ok_or_else(|| WhError::Sql(format!("TIMESTAMP AS OF expects a timestamp, got {e}")))
    }

    /// A Delta table at a version, scanned under its name or alias.
    pub(super) fn plan_versioned_table(&mut self, parts: &[String], alias_name: Option<String>, version: &sql::TableVersion) -> Result<LogicalPlan> {
        let spec = self.version_spec(version)?;
        let full = parts.join(".");
        let tname = full.rsplit('.').next().unwrap_or_default().to_string();
        let q = alias_name.unwrap_or_else(|| tname.clone());
        let table_ref = TableRef::lenient(&full);
        match self.ctx.lookup_ref(&table_ref)? {
            Some(TableEntry::Table(t)) => {
                let d = t.as_delta().ok_or_else(|| {
                    WhError::NotSupported(format!("time travel (VERSION / TIMESTAMP AS OF) needs a Delta table: '{full}' is a {} table", t.kind()))
                })?;
                let at = DeltaTable::open(d.root(), d.storage(), Some(spec))?;
                LogicalPlan::scan(&tname, Some(q), Arc::new(at), None, vec![], None)
            }
            Some(TableEntry::View(_)) => Err(WhError::NotSupported(format!("time travel needs a Delta table: '{full}' is a view"))),
            None => Err(self.table_not_found(&full, &table_ref)),
        }
    }
}
