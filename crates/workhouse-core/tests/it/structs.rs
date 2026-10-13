//! Struct columns: plumbing through the operators, SQL constructors and
//! field access, aggregates and UNNEST. Expected values are what DuckDB
//! returns (the Python tests check them against DuckDB itself).


use std::sync::Arc;

use arrow::array::*;
use arrow::compute::{CastOptions, cast_with_options};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use crate::support::*;
use workhouse_core::SessionContext;
use workhouse_core::nested::{list_of, struct_of};

fn sample() -> Vec<StructRow> {
    vec![
        (1, Some((Some(1), Some("x")))),
        (2, None),
        (3, Some((None, Some("z")))),
        (4, Some((Some(4), None))),
        (5, Some((Some(5), Some("é")))),
    ]
}

/// Struct-of-list `s` and list-of-struct `ls`, built from SQL constructors.
const NESTED_SQL: &str = "\
    select 1 as id, {'a': 1, 'l': ['p','q']} as s, [{'x': 1, 'y': 'u'}, {'x': 2, 'y': NULL}] as ls \
    union all select 2, NULL::STRUCT(a BIGINT, l VARCHAR[]), NULL::STRUCT(x BIGINT, y VARCHAR)[] \
    union all select 3, {'a': NULL, 'l': []::VARCHAR[]}, []::STRUCT(x BIGINT, y VARCHAR)[] \
    union all select 4, {'a': 4, 'l': NULL::VARCHAR[]}, [NULL::STRUCT(x BIGINT, y VARCHAR), {'x': NULL, 'y': 'w'}] \
    union all select 5, {'a': 5, 'l': ['r', NULL]}, [{'x': 5, 'y': 'v'}]";

fn register_nested(ctx: &SessionContext, name: &str) {
    let (schema, batches) = ctx.sql(NESTED_SQL).unwrap().collect().unwrap();
    ctx.register_batches(name, schema, batches);
}

fn ctx() -> SessionContext {
    let ctx = SessionContext::new();
    structs_table(&ctx, "t", &sample());
    register_nested(&ctx, "n");
    ctx
}

fn q(sql: &str) -> String {
    rows_in(&ctx(), sql)
}

/// Same SQL, no table: constants only.
fn k(sql: &str) -> String {
    rows_in(&SessionContext::new(), sql)
}

fn err(sql: &str) -> String {
    ctx().sql(sql).and_then(|df| df.collect()).err().unwrap_or_else(|| panic!("{sql} should fail")).to_string()
}

// ---------------------------------------------------------------------------
// type plumbing
// ---------------------------------------------------------------------------

#[test]
fn canonical_types_and_names() {
    let s = struct_of([("a".to_string(), DataType::Int64), ("b".to_string(), list_of(DataType::Utf8))]);
    assert_eq!(workhouse_core::nested::type_name(&s), "Struct<a: Int64, b: List<Utf8>>");
    // string views and large strings inside a struct are plain strings
    let views = DataType::Struct(vec![Field::new("v", DataType::Utf8View, false)].into());
    assert_eq!(workhouse_core::nested::canonical_type(&views), struct_of([("v".to_string(), DataType::Utf8)]));
    let c = ctx();
    let df = c.sql("select s, ls from n").unwrap();
    assert_eq!(
        df.schema().to_string(),
        "[n.s: Struct<a: Int64, l: List<Utf8>>, n.ls: List<Struct<x: Int64, y: Utf8>>]"
    );
}

#[test]
fn type_names_parse() {
    use workhouse_core::types::parse_data_type;
    let want = struct_of([("a".to_string(), DataType::Int32), ("b".to_string(), DataType::Utf8)]);
    assert_eq!(parse_data_type("STRUCT(a INT, b VARCHAR)").unwrap(), want);
    assert_eq!(parse_data_type("struct<a:int, b:string>").unwrap(), want);
    assert_eq!(parse_data_type("ROW(a integer, \"b\" text)").unwrap(), want);
    assert_eq!(
        parse_data_type("STRUCT(Xy BIGINT, l VARCHAR[])[]").unwrap(),
        list_of(struct_of([("Xy".to_string(), DataType::Int64), ("l".to_string(), list_of(DataType::Utf8))]))
    );
    assert_eq!(
        parse_data_type("struct<a: struct<b: decimal(10,2)>, c: array<int>>").unwrap(),
        struct_of([
            ("a".to_string(), struct_of([("b".to_string(), DataType::Decimal128(10, 2))])),
            ("c".to_string(), list_of(DataType::Int32)),
        ])
    );
    assert!(parse_data_type("struct<a>").is_err());
    assert!(parse_data_type("struct(a int, A text)").is_err());
}

fn parquet_ctx(name: &str) -> (SessionContext, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("wh-structs-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.parquet");
    // from the nested table: items called "element" and required fields, as pyarrow and Spark write them
    let src = SessionContext::new();
    register_nested(&src, "n");
    let (schema, batches) = src.sql("select id, s, ls from n order by id").unwrap().collect().unwrap();
    let batch = arrow::compute::concat_batches(&schema, &batches).unwrap();
    let s_type = DataType::Struct(
        vec![
            Field::new("a", DataType::Int64, true),
            Field::new("l", DataType::List(Arc::new(Field::new("element", DataType::Utf8, true))), true),
        ]
        .into(),
    );
    let item = DataType::Struct(vec![Field::new("x", DataType::Int64, true), Field::new("y", DataType::Utf8, true)].into());
    let ls_type = DataType::List(Arc::new(Field::new("element", item, true)));
    let target = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, true),
        Field::new("s", s_type, true),
        Field::new("ls", ls_type, true),
    ]));
    let cols: Vec<ArrayRef> = batch
        .columns()
        .iter()
        .zip(target.fields())
        .map(|(c, f)| cast_with_options(c, f.data_type(), &CastOptions::default()).unwrap())
        .collect();
    let batch = RecordBatch::try_new(target.clone(), cols).unwrap();
    workhouse_core::io::parquet::write_parquet(path.to_str().unwrap(), target, &[batch], "zstd", None).unwrap();
    let ctx = SessionContext::new();
    ctx.register_parquet("p", path.to_str().unwrap()).unwrap();
    (ctx, dir)
}

#[test]
fn parquet_struct_columns_are_read() {
    let (ctx, dir) = parquet_ctx("scan");
    let all = rows_in(&ctx, "select id, s, ls from p order by id");
    let want = q("select id, s, ls from n order by id");
    assert_eq!(all, want);
    assert_eq!(all, "1,{a:1,l:['p','q']},[{x:1,y:'u'},{x:2,y:null}]|2,null,null|3,{a:null,l:[]},[]|4,{a:4,l:null},[null,{x:null,y:'w'}]|5,{a:5,l:['r',null]},[{x:5,y:'v'}]");
    // reading only a field, a filter on a flat column, counts
    assert_eq!(rows_in(&ctx, "select id, s.a, s.l[1], ls[1].y from p where id >= 4 order by id"), "4,4,null,null|5,5,r,v");
    assert_eq!(rows_in(&ctx, "select count(*), count(s), count(ls) from p"), "5,4,4");
    // canonical schema: the user sees Struct<..> / List<Struct<..>>
    let df = ctx.sql("select s, ls from p").unwrap();
    assert_eq!(
        df.schema().to_string(),
        "[p.s: Struct<a: Int64, l: List<Utf8>>, p.ls: List<Struct<x: Int64, y: Utf8>>]"
    );
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn structs_round_trip_through_parquet() {
    let dir = std::env::temp_dir().join(format!("wh-structs-{}-write", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let c = ctx();
    let out = dir.join("out.parquet");
    let none = workhouse_core::io::StorageOptions::default();
    let opts = workhouse_core::io::parquet::ParquetOptions::default();
    c.sql("select id, s, ls from n").unwrap().sink_parquet(out.to_str().unwrap(), &opts, &none).unwrap();
    let c2 = SessionContext::new();
    c2.register_parquet("o", out.to_str().unwrap()).unwrap();
    assert_eq!(rows_in(&c2, "select id, s, ls from o order by id"), q("select id, s, ls from n order by id"));
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn structs_flow_as_payload() {
    let c = ctx();
    assert_eq!(rows_in(&c, "select s from t where id > 3 order by id desc"), "{a:5,b:'é'}|{a:4,b:null}");
    assert_eq!(rows_in(&c, "select id, s from t order by id desc limit 2"), "5,{a:5,b:'é'}|4,{a:4,b:null}");
    assert_eq!(rows_in(&c, "select s from t limit 1 offset 2"), "{a:null,b:'z'}");
    assert_eq!(rows_in(&c, "select id, s from t where id = 1 union all select id, s from t where id = 5 order by id"), "1,{a:1,b:'x'}|5,{a:5,b:'é'}");
    // join with the struct as payload on either side
    let c2 = SessionContext::new();
    structs_table(&c2, "a", &sample());
    structs_table(&c2, "b", &[(1, Some((Some(9), Some("n")))), (4, None), (5, Some((None, None)))]);
    assert_eq!(
        rows_in(&c2, "select a.id, a.s, b.s from a join b on a.id = b.id order by a.id"),
        "1,{a:1,b:'x'},{a:9,b:'n'}|4,{a:4,b:null},null|5,{a:5,b:'é'},{a:null,b:null}"
    );
    assert_eq!(rows_in(&c2, "select a.id, b.s from a left join b on a.id = b.id order by a.id"), "1,{a:9,b:'n'}|2,null|3,null|4,null|5,{a:null,b:null}");
    // a struct column carried through a grouped query by first(), and counted
    assert_eq!(rows_in(&c, "select id % 2 as g, count(*), count(s) from t group by 1 order by 1"), "0,2,1|1,3,3");
    assert_eq!(rows_in(&c, "select id % 2 as g, first(s) from t group by 1 order by 1"), "0,{a:4,b:null}|1,{a:1,b:'x'}");
}

#[test]
fn structs_cannot_be_keys_yet() {
    for sql in [
        "select s, count(*) from t group by s",
        "select distinct s from t",
        "select * from t order by s",
        "select a.id from t a join t b on a.s = b.s",
        "select id, row_number() over (partition by s order by id) from t",
    ] {
        let e = err(sql);
        assert!(e.contains("Struct<a: Int64, b: Utf8>") && e.contains("yet"), "{sql}: {e}");
    }
    // the nested ones name their whole type
    let e = err("select s, count(*) from n group by s");
    assert!(e.contains("Struct<a: Int64, l: List<Utf8>>"), "{e}");
}

// ---------------------------------------------------------------------------
// constructors and access
// ---------------------------------------------------------------------------

#[test]
fn constructors() {
    assert_eq!(k("select {'a': 1, 'b': 'x'}"), "{a:1,b:'x'}");
    assert_eq!(k("select struct_pack(a := 1, b := 'x')"), "{a:1,b:'x'}");
    assert_eq!(k("select named_struct('a', 1, 'b', 2.5)"), "{a:1,b:2.5}");
    assert_eq!(k("select row(1, 'x')"), "{v1:1,v2:'x'}");
    assert_eq!(k("select {'a': NULL}, {'a': [1, NULL], 'b': {'c': 'd'}}"), "{a:null},{a:[1,null],b:{c:'d'}}");
    assert_eq!(k("select [{'x': 1}, {'x': 2}], [{'x': 1, 'y': 'a'}, NULL]"), "[{x:1},{x:2}],[{x:1,y:'a'},null]");
    assert_eq!(q("select struct_pack(i := id, doubled := id * 2) from t where id <= 2 order by id"), "{i:1,doubled:2}|{i:2,doubled:4}");
    assert_eq!(q("select {'who': s.b, 'orig': s} from t where id = 1"), "{who:'x',orig:{a:1,b:'x'}}");
    assert_eq!(k("select struct_insert({'a': 1}, b := 2, c := 'z')"), "{a:1,b:2,c:'z'}");
    assert_eq!(q("select struct_insert(s, c := id) from t where id in (1, 2) order by id"), "{a:1,b:'x',c:1}|{a:null,b:null,c:2}");
}

#[test]
fn constructor_errors() {
    assert!(err("select struct_pack(1, 2)").contains("names"));
    assert!(err("select {'a': 1, 'A': 2}").contains("twice"));
    assert!(err("select struct_insert({'a': 1}, a := 2)").contains("already exists"));
    assert!(err("select named_struct('a', 1, 'b')").contains("pairs"));
}

#[test]
fn field_access() {
    // s.a, t.s.a, s['a'], struct_extract, (expr).a: a NULL struct and a NULL field both read NULL
    let both = "1,x|null,null|null,z|4,null|5,é";
    assert_eq!(q("select s.a, s.b from t order by id"), both);
    assert_eq!(q("select struct_extract(s, 'a'), struct_extract(s, 'b') from t order by id"), both);
    assert_eq!(q("select t.s.a from t order by id"), "1|null|null|4|5");
    assert_eq!(q("select s['b'] from t order by id"), "x|null|z|null|é");
    assert_eq!(q("select (s).a from t order by id"), "1|null|null|4|5");
    assert_eq!(k("select {'a': 1}['a'], ({'a': {'b': 7}}).a.b, {'a': {'b': 7}}.a"), "1,7,{b:7}");
    assert_eq!(q("select s.a + 1 from t order by id"), "2|null|null|5|6");
    assert_eq!(q("select id from t where s.a > 1 order by id"), "4|5");
    assert_eq!(q("select s is null, s.a is null from t order by id"), "false,false|true,true|false,true|false,false|false,false");
    // field names are case-insensitive, an exact match wins
    assert_eq!(k("select struct_extract({'Abc': 1}, 'ABC'), {'Abc': 1, 'abc2': 2}.ABC2"), "1,2");
}

#[test]
fn field_access_on_nested_values() {
    assert_eq!(q("select id, s.l, ls[1].x, s.l[1] from n order by id"), "1,['p','q'],1,p|2,null,null,null|3,[],null,null|4,null,null,null|5,['r',null],5,r");
    assert_eq!(q("select ls[2].y, ls[-1] from n order by id"), "null,{x:2,y:null}|null,null|null,null|w,{x:null,y:'w'}|null,{x:5,y:'v'}");
    assert_eq!(q("select len(s.l), list_contains(s.l, 'r') from n order by id"), "2,false|null,null|0,false|null,null|2,true");
    assert_eq!(k("select [{'x': 1}, {'x': 2}][2].x, {'a': [{'b': 5}]}.a[1].b"), "2,5");
}

#[test]
fn table_alias_wins_over_a_struct_field() {
    // `t.s` is the column s of the table t, even if a column named t holds a struct with a field s
    let c = SessionContext::new();
    c.register_batches("x", structs_batch(&[(1, Some((Some(1), Some("x"))))]).0, vec![structs_batch(&[(1, Some((Some(1), Some("x"))))]).1]);
    assert_eq!(rows_in(&c, "select x.s from x"), "{a:1,b:'x'}");
    assert_eq!(rows_in(&c, "select s.a from x"), "1");
    assert_eq!(rows_in(&c, "select x.s.b from x"), "x");
    // a subquery whose column is named like its alias: the alias wins, the field is reached through it
    assert_eq!(rows_in(&c, "select s.a from (select s from x) s"), "1");
    assert_eq!(rows_in(&c, "select s.s.a from (select s from x) s"), "1");
    let e = c.sql("select s.zzz from x").err().unwrap().to_string();
    assert!(e.contains("zzz") && e.contains("fields: a, b"), "{e}");
}

#[test]
fn field_access_errors() {
    assert!(err("select struct_extract(1, 'a')").contains("struct"));
    assert!(err("select struct_extract(s, 'nope') from t").contains("fields: a, b"));
    assert!(err("select struct_extract(s, id) from t").contains("constant"));
}

// ---------------------------------------------------------------------------
// unnest and star
// ---------------------------------------------------------------------------

#[test]
fn unnest_a_struct_into_columns() {
    assert_eq!(q("select unnest(s) from t order by id"), "1,x|null,null|null,z|4,null|5,é");
    assert_eq!(k("select unnest({'a': 1, 'b': 2})"), "1,2");
    assert_eq!(q("select id, unnest(s) from t where id < 3 order by id"), "1,1,x|2,null,null");
    assert_eq!(q("select s.* from t where id = 1"), "1,x");
    assert_eq!(q("select s.* exclude (b) from t where id = 4"), "4");
    let df = ctx().sql("select unnest(s) from t").unwrap();
    assert_eq!(df.schema().to_string(), "[a: Int64, b: Utf8]");
    // lists of structs: unnest the list, then the struct
    assert_eq!(q("select unnest(ls) as e from n where id = 1"), "{x:1,y:'u'}|{x:2,y:null}");
    assert_eq!(q("select e.x, e.y from (select unnest(ls) as e from n) where e.x is not null order by e.x"), "1,u|2,null|5,v");
}

// ---------------------------------------------------------------------------
// aggregates
// ---------------------------------------------------------------------------

#[test]
fn aggregates_over_structs() {
    // array_agg keeps NULL structs, in scan order
    assert_eq!(q("select array_agg(s order by id) from t"), "[{a:1,b:'x'},null,{a:null,b:'z'},{a:4,b:null},{a:5,b:'é'}]");
    assert_eq!(q("select id % 2 as g, array_agg(s order by id) from t group by 1 order by 1"), "0,[null,{a:4,b:null}]|1,[{a:1,b:'x'},{a:null,b:'z'},{a:5,b:'é'}]");
    assert_eq!(q("select array_agg(s order by id) filter (where id > 2) from t"), "[{a:null,b:'z'},{a:4,b:null},{a:5,b:'é'}]");
    assert_eq!(q("select array_agg(s) from t where false"), "null");
    assert_eq!(q("select array_agg(ls order by id) from n where id in (1, 3)"), "[[{x:1,y:'u'},{x:2,y:null}],[]]");
    // min / max compare field by field, NULL fields last (as DuckDB)
    assert_eq!(q("select min(s), max(s) from t"), "{a:1,b:'x'},{a:null,b:'z'}");
    assert_eq!(q("select id % 2 as g, min(s), max(s) from t group by 1 order by 1"), "0,{a:4,b:null},{a:4,b:null}|1,{a:1,b:'x'},{a:null,b:'z'}");
    assert_eq!(q("select min(ls), max(ls) from n"), "[],[null,{x:null,y:'w'}]");
    // first / last skip NULL structs
    assert_eq!(q("select first(s), last(s) from t"), "{a:1,b:'x'},{a:5,b:'é'}");
    assert_eq!(q("select first(s), last(s) from t where id = 2"), "null,null");
    assert_eq!(q("select max_by(s, id), min_by(s, id) from t"), "{a:5,b:'é'},{a:1,b:'x'}");
    assert_eq!(q("select max_by(id, s.a), count(s), count(s.a) from t"), "5,4,3");
}

// ---------------------------------------------------------------------------
// expressions over structs
// ---------------------------------------------------------------------------

#[test]
fn case_coalesce_and_casts() {
    assert_eq!(q("select coalesce(s, {'a': 0, 'b': 'd'}) from t order by id"), "{a:1,b:'x'}|{a:0,b:'d'}|{a:null,b:'z'}|{a:4,b:null}|{a:5,b:'é'}");
    assert_eq!(q("select case when id > 2 then s end from t order by id"), "null|null|{a:null,b:'z'}|{a:4,b:null}|{a:5,b:'é'}");
    assert_eq!(q("select if(id = 1, s, {'a': -1, 'b': '-'}) from t where id <= 2 order by id"), "{a:1,b:'x'}|{a:-1,b:'-'}");
    // fields are cast to the common type
    assert_eq!(k("select coalesce(NULL::STRUCT(a INT), {'a': 1.5})"), "{a:1.5}");
    assert_eq!(q("select s::STRUCT(a DOUBLE, b VARCHAR) from t where id = 1"), "{a:1.0,b:'x'}");
    assert_eq!(k("select NULL::STRUCT(a INT, b VARCHAR[])"), "null");
    assert!(err("select coalesce({'a': 1}, {'b': 2})").contains("incompatible"));
}

#[test]
fn views_and_ctes_keep_struct_fields() {
    assert_eq!(q("with v as (select id, s from t) select v.s.a, s.b from v where id = 1"), "1,x");
    assert_eq!(q("select x.s.l[2] from (select s from n) x where x.s.a = 1"), "q");
    assert_eq!(q("select s.a from (select * from t) order by s.a nulls last limit 2"), "1|4");
}

#[test]
fn lazy_frames_from_sql_have_struct_types() {
    let c = ctx();
    let df = c.sql("select id, s from t").unwrap();
    let schema = df.schema();
    assert_eq!(schema.field(1).data_type(), &struct_of([("a".to_string(), DataType::Int64), ("b".to_string(), DataType::Utf8)]));
    // MemTable normalization: a struct with required fields and string views comes out canonical
    let fields: arrow::datatypes::Fields = vec![Field::new("v", DataType::Utf8View, false)].into();
    let sa = StructArray::new(fields.clone(), vec![Arc::new(StringViewArray::from(vec!["p", "q"]))], None);
    let schema = Arc::new(Schema::new(vec![Field::new("s", DataType::Struct(fields), false)]));
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(sa)]).unwrap();
    let c = SessionContext::new();
    c.register_batches("m", schema, vec![batch]);
    let df = c.sql("select s from m").unwrap();
    assert_eq!(df.schema().to_string(), "[m.s: Struct<v: Utf8>]");
    assert_eq!(rows_in(&c, "select s.v from m"), "p|q");
}

#[test]
fn comparisons_go_field_by_field() {
    assert_eq!(q("select s = {'a': 1, 'b': 'x'} from t order by id"), "true|null|false|false|false");
    assert_eq!(q("select id from t where s in ({'a': 4, 'b': NULL}, {'a': 1, 'b': 'x'}) order by id"), "1|4");
    assert_eq!(q("select id from t where s <> {'a': 1, 'b': 'x'} order by id"), "3|4|5");
    assert_eq!(q("select id from t where s > {'a': 1, 'b': 'x'} order by id"), "3|4|5");
    assert_eq!(q("select id from t where s is not distinct from {'a': 4, 'b': NULL} order by id"), "4");
    assert_eq!(q("select id, ls = [{'x': 5, 'y': 'v'}] from n order by id"), "1,false|2,null|3,false|4,false|5,true");
    // a NULL inside is the largest value and equals another NULL
    assert_eq!(k("select {'a': NULL::INT} = {'a': NULL::INT}, {'a': 1} = {'a': NULL::INT}, {'a': 1, 'b': 2} < {'a': 1, 'b': 3}, {'a': NULL::INT, 'b': 1} < {'a': 1, 'b': 0}"), "true,false,true,false");
    assert_eq!(k("select [{'x': 1}] = [{'x': 1}], NULL::STRUCT(a INT) = {'a': 1}"), "true,null");
}

#[test]
fn error_messages() {
    assert!(err("select id.a from t").contains("not a struct"));
    assert!(err("select s.a.b from t").contains("not a struct"));
    assert!(err("select unnest(s) as z from t").contains("alias"));
}

#[test]
fn struct_rename_and_insert_keep_nulls() {
    assert_eq!(q("select struct_rename(s, 'x', 'y') from t order by id"), "{x:1,y:'x'}|null|{x:null,y:'z'}|{x:4,y:null}|{x:5,y:'é'}");
    assert_eq!(q("select struct_rename(s, 'x', 'y').y from t where id = 1"), "x");
    assert!(err("select struct_rename(s, 'x') from t").contains("2 fields"));
    assert!(err("select struct_rename(s, 'x', 'X') from t").contains("twice"));
    assert_eq!(q("select struct_insert(s, c := s.a * 2) from t where id in (2, 5) order by id"), "{a:null,b:null,c:null}|{a:5,b:'é',c:10}");
}

#[test]
fn lazy_frame_unnest_expands_struct_columns() {
    let c = ctx();
    let lf = c.sql("select id, s from t").unwrap();
    let (_, b) = lf.unnest(&["s".to_string()], None).unwrap().collect().unwrap();
    assert_eq!(render(&b), "1,1,x|2,null,null|3,null,z|4,4,null|5,5,é");
    let u = lf.unnest(&["s".to_string()], Some("_")).unwrap();
    assert_eq!(u.schema().to_string(), "[t.id: Int64, s_a: Int64, s_b: Utf8]");
    assert_eq!(lf.struct_field_names(&workhouse_core::col("s")).unwrap(), Some(vec!["a".to_string(), "b".to_string()]));
    assert_eq!(lf.struct_field_names(&workhouse_core::col("id")).unwrap(), None);
    assert!(lf.unnest(&["id".to_string()], None).err().unwrap().to_string().contains("not a struct"));
    assert!(lf.unnest(&["nope".to_string()], None).err().unwrap().to_string().contains("no column"));
    let clash = c.sql("select id as a, s from t").unwrap();
    assert!(clash.unnest(&["s".to_string()], None).err().unwrap().to_string().contains("twice"));
}
