//! Arrow schemas as Delta `schemaString` JSON, and back.
//!
//! Arrow to Delta: integers map to the signed type of their width, unsigned
//! ones to the next wider signed type (`UInt64` to `decimal(20,0)`: Delta has
//! no 64-bit unsigned type and a lossy cast would be worse than a wider
//! type; the data must be cast to `Decimal128(20, 0)` when written).
//! Timestamps in any unit become `timestamp` (zone-aware) or `timestamp_ntz`
//! (no zone); the Parquet files must hold microseconds. Strings, binaries
//! and lists in their large / view / fixed forms map to the plain Delta type,
//! dictionaries to their value type. Time, duration and interval have no
//! Delta type and are rejected.
//!
//! Delta to Arrow: `timestamp` is `Timestamp(Microsecond, "UTC")`,
//! `timestamp_ntz` has no zone, `array` is a `List` of field `item`, `map`
//! a `Map` of entries `key_value` { `key`, `value` } (the Parquet layout).
//! Field metadata is kept as strings (a non-string JSON value as its JSON
//! text), so values such as column mapping ids come back as text.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::datatypes::{DataType, Field, Fields, Schema, TimeUnit};
use serde_json::{Map, Value, json};

use super::actions::Protocol;
use crate::error::{Result, WhError};

fn err(msg: impl Into<String>) -> WhError {
    WhError::Plan(msg.into())
}

/// The `schemaString` of a table with this schema.
pub fn schema_to_json(schema: &Schema) -> Result<String> {
    Ok(struct_to_json(schema.fields())?.to_string())
}

/// The Arrow schema of a `schemaString`.
pub fn schema_from_json(s: &str) -> Result<Schema> {
    let v: Value = serde_json::from_str(s).map_err(|e| err(format!("invalid Delta schema JSON: {e}")))?;
    let DataType::Struct(fields) = arrow_type_of(&v)? else {
        return Err(err("a Delta table schema must be a struct"));
    };
    Ok(Schema::new(fields))
}

fn struct_to_json(fields: &Fields) -> Result<Value> {
    let fields: Result<Vec<Value>> = fields
        .iter()
        .map(|f| {
            let meta: Map<String, Value> = f.metadata().iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
            Ok(json!({"name": f.name(), "type": delta_type_of(f.data_type())?, "nullable": f.is_nullable(), "metadata": meta}))
        })
        .collect();
    Ok(json!({"type": "struct", "fields": fields?}))
}

/// The Delta type (a JSON string, or an object for nested types) of an Arrow type.
pub fn delta_type_of(dt: &DataType) -> Result<Value> {
    use DataType::*;
    Ok(match dt {
        Utf8 | LargeUtf8 | Utf8View => "string".into(),
        Int64 | UInt32 => "long".into(),
        Int32 | UInt16 => "integer".into(),
        Int16 | UInt8 => "short".into(),
        Int8 => "byte".into(),
        UInt64 => "decimal(20,0)".into(),
        Float32 | Float16 => "float".into(),
        Float64 => "double".into(),
        Boolean => "boolean".into(),
        Binary | LargeBinary | BinaryView | FixedSizeBinary(_) => "binary".into(),
        Date32 | Date64 => "date".into(),
        Timestamp(_, Some(_)) => "timestamp".into(),
        Timestamp(_, None) => "timestamp_ntz".into(),
        Null => "void".into(),
        Decimal128(p, s) | Decimal256(p, s) => {
            if *p > 38 || *s < 0 || *s > *p as i8 {
                return Err(err(format!("decimal({p},{s}) is not a Delta type (precision up to 38, scale 0..=precision)")));
            }
            format!("decimal({p},{s})").into()
        }
        Dictionary(_, value) => delta_type_of(value)?,
        List(f) | LargeList(f) | FixedSizeList(f, _) | ListView(f) | LargeListView(f) => {
            json!({"type": "array", "elementType": delta_type_of(f.data_type())?, "containsNull": f.is_nullable()})
        }
        Struct(fields) => struct_to_json(fields)?,
        Map(entries, _) => {
            let Struct(kv) = entries.data_type() else { return Err(err("malformed Arrow map type")) };
            if kv.len() != 2 {
                return Err(err("malformed Arrow map type"));
            }
            json!({
                "type": "map",
                "keyType": delta_type_of(kv[0].data_type())?,
                "valueType": delta_type_of(kv[1].data_type())?,
                "valueContainsNull": kv[1].is_nullable(),
            })
        }
        other => return Err(err(format!("type {other} has no Delta equivalent"))),
    })
}

/// The Arrow type of a Delta type.
pub fn arrow_type_of(v: &Value) -> Result<DataType> {
    match v {
        Value::String(s) => primitive(s),
        Value::Object(o) => match o.get("type").and_then(Value::as_str) {
            Some("struct") => {
                let fields = o.get("fields").and_then(Value::as_array).ok_or_else(|| err("struct without fields"))?;
                fields.iter().map(field_from_json).collect::<Result<Vec<Field>>>().map(|f| DataType::Struct(f.into()))
            }
            Some("array") => {
                let elem = arrow_type_of(o.get("elementType").ok_or_else(|| err("array without elementType"))?)?;
                let nullable = o.get("containsNull").and_then(Value::as_bool).unwrap_or(true);
                Ok(DataType::List(Arc::new(Field::new("item", elem, nullable))))
            }
            Some("map") => {
                let key = arrow_type_of(o.get("keyType").ok_or_else(|| err("map without keyType"))?)?;
                let value = arrow_type_of(o.get("valueType").ok_or_else(|| err("map without valueType"))?)?;
                let nullable = o.get("valueContainsNull").and_then(Value::as_bool).unwrap_or(true);
                let entries = Field::new_struct("key_value", vec![Field::new("key", key, false), Field::new("value", value, nullable)], false);
                Ok(DataType::Map(Arc::new(entries), false))
            }
            other => Err(err(format!("unknown Delta type {other:?}"))),
        },
        other => Err(err(format!("invalid Delta type {other}"))),
    }
}

fn primitive(s: &str) -> Result<DataType> {
    Ok(match s {
        "string" => DataType::Utf8,
        "long" => DataType::Int64,
        "integer" => DataType::Int32,
        "short" => DataType::Int16,
        "byte" => DataType::Int8,
        "float" => DataType::Float32,
        "double" => DataType::Float64,
        "boolean" => DataType::Boolean,
        "binary" => DataType::Binary,
        "date" => DataType::Date32,
        "timestamp" => DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
        "timestamp_ntz" => DataType::Timestamp(TimeUnit::Microsecond, None),
        "void" => DataType::Null,
        "decimal" => DataType::Decimal128(10, 0),
        _ => {
            let args = s.strip_prefix("decimal(").and_then(|r| r.strip_suffix(')'));
            let (p, sc) = args.and_then(|a| a.split_once(',')).ok_or_else(|| err(format!("unknown Delta type '{s}'")))?;
            let (p, sc): (u8, i8) = (p.trim().parse().map_err(|_| err(format!("bad decimal '{s}'")))?, sc.trim().parse().map_err(|_| err(format!("bad decimal '{s}'")))?);
            if p == 0 || p > 38 || sc < 0 || sc > p as i8 {
                return Err(err(format!("bad decimal '{s}'")));
            }
            DataType::Decimal128(p, sc)
        }
    })
}

fn field_from_json(v: &Value) -> Result<Field> {
    let o = v.as_object().ok_or_else(|| err("struct field must be an object"))?;
    let name = o.get("name").and_then(Value::as_str).ok_or_else(|| err("struct field without name"))?;
    let dt = arrow_type_of(o.get("type").ok_or_else(|| err(format!("field '{name}' without type")))?)?;
    let nullable = o.get("nullable").and_then(Value::as_bool).unwrap_or(true);
    let metadata: HashMap<String, String> = o
        .get("metadata")
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().map_or_else(|| v.to_string(), str::to_string))).collect())
        .unwrap_or_default();
    Ok(Field::new(name, dt, nullable).with_metadata(metadata))
}

/// The protocol a table of this schema needs: 1 / 2, or reader 3 / writer 7
/// with the `timestampNtz` feature when a column (at any depth) is a
/// `timestamp_ntz`.
pub fn protocol_for(schema: &Schema) -> Protocol {
    if schema.fields().iter().any(|f| uses_ntz(f.data_type())) {
        let features = vec!["timestampNtz".to_string()];
        Protocol { min_reader_version: 3, min_writer_version: 7, reader_features: Some(features.clone()), writer_features: Some(features) }
    } else {
        Protocol { min_reader_version: 1, min_writer_version: 2, reader_features: None, writer_features: None }
    }
}

fn uses_ntz(dt: &DataType) -> bool {
    match dt {
        DataType::Timestamp(_, None) => true,
        DataType::Struct(fs) => fs.iter().any(|f| uses_ntz(f.data_type())),
        DataType::List(f) | DataType::LargeList(f) | DataType::FixedSizeList(f, _) | DataType::Map(f, _) => uses_ntz(f.data_type()),
        DataType::Dictionary(_, v) => uses_ntz(v),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_types() -> Schema {
        let item = |dt| Arc::new(Field::new("item", dt, true));
        let meta: HashMap<String, String> = [("comment".to_string(), "hello".to_string())].into();
        Schema::new(vec![
            Field::new("s", DataType::Utf8, true).with_metadata(meta),
            Field::new("l", DataType::Int64, false),
            Field::new("i", DataType::Int32, true),
            Field::new("sh", DataType::Int16, true),
            Field::new("b", DataType::Int8, true),
            Field::new("f", DataType::Float32, true),
            Field::new("d", DataType::Float64, true),
            Field::new("bo", DataType::Boolean, true),
            Field::new("bin", DataType::Binary, true),
            Field::new("dt", DataType::Date32, true),
            Field::new("ts", DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())), true),
            Field::new("ntz", DataType::Timestamp(TimeUnit::Microsecond, None), true),
            Field::new("dec", DataType::Decimal128(12, 3), true),
            Field::new("arr", DataType::List(item(DataType::Utf8)), true),
            Field::new("st", DataType::Struct(vec![Field::new("a", DataType::Int32, false), Field::new("n", DataType::List(item(DataType::Int8)), true)].into()), true),
            Field::new(
                "m",
                DataType::Map(
                    Arc::new(Field::new_struct("key_value", vec![Field::new("key", DataType::Utf8, false), Field::new("value", DataType::Float64, true)], false)),
                    false,
                ),
                true,
            ),
        ])
    }

    #[test]
    fn schema_round_trips_for_every_type() {
        let schema = all_types();
        let json = schema_to_json(&schema).unwrap();
        assert!(json.contains("\"decimal(12,3)\"") && json.contains("\"timestamp_ntz\"") && json.contains("\"valueContainsNull\":true"));
        assert_eq!(schema_from_json(&json).unwrap(), schema);
    }

    #[test]
    fn arrow_types_without_a_twin_are_widened_or_renamed() {
        let t = |dt: DataType| delta_type_of(&dt).unwrap();
        assert_eq!(t(DataType::UInt8), "short");
        assert_eq!(t(DataType::UInt16), "integer");
        assert_eq!(t(DataType::UInt32), "long");
        assert_eq!(t(DataType::UInt64), "decimal(20,0)");
        assert_eq!(t(DataType::LargeUtf8), "string");
        assert_eq!(t(DataType::Utf8View), "string");
        assert_eq!(t(DataType::Timestamp(TimeUnit::Nanosecond, Some("+02:00".into()))), "timestamp");
        assert_eq!(t(DataType::Timestamp(TimeUnit::Second, None)), "timestamp_ntz");
        assert_eq!(t(DataType::Dictionary(Box::new(DataType::Int8), Box::new(DataType::Utf8))), "string");
        assert!(delta_type_of(&DataType::Duration(TimeUnit::Second)).is_err());
        assert!(delta_type_of(&DataType::Decimal128(39, 0)).is_err());
    }

    #[test]
    fn parses_a_spark_schema_string() {
        let s = r#"{"type":"struct","fields":[{"name":"id","type":"long","nullable":false,"metadata":{"delta.columnMapping.id":1}},{"name":"tags","type":{"type":"array","elementType":"string","containsNull":false},"nullable":true,"metadata":{}},{"name":"d","type":"decimal(5,2)","nullable":true,"metadata":{}}]}"#;
        let schema = schema_from_json(s).unwrap();
        assert_eq!(schema.field(0).metadata()["delta.columnMapping.id"], "1");
        assert!(!schema.field(0).is_nullable());
        assert_eq!(schema.field(2).data_type(), &DataType::Decimal128(5, 2));
        assert!(schema_from_json("\"long\"").is_err());
        assert!(schema_from_json(r#"{"type":"struct","fields":[{"name":"x","type":"nope"}]}"#).is_err());
    }

    #[test]
    fn timestamp_ntz_needs_the_newer_protocol() {
        let plain = Schema::new(vec![Field::new("a", DataType::Int64, true)]);
        let p = protocol_for(&plain);
        assert_eq!((p.min_reader_version, p.min_writer_version, p.reader_features), (1, 2, None));
        let nested = Schema::new(vec![Field::new("a", DataType::Struct(vec![Field::new("t", DataType::Timestamp(TimeUnit::Microsecond, None), true)].into()), true)]);
        let p = protocol_for(&nested);
        assert_eq!((p.min_reader_version, p.min_writer_version), (3, 7));
        assert_eq!(p.reader_features.as_deref(), Some(&["timestampNtz".to_string()][..]));
        assert_eq!(p.writer_features, p.reader_features);
        let zoned = Schema::new(vec![Field::new("t", DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())), true)]);
        assert_eq!(protocol_for(&zoned).min_reader_version, 1);
    }
}
