//! Nested JSON: objects and arrays read as `Struct` / `List` columns
//! (inferred from the sample, merged across records), the `nested = "text"`
//! option, NDJSON written from lists and structs, and the JSON text
//! functions (`json_extract`, `->`, `->>`, `json_array_length`, `to_json`,
//! `from_json`). Expected values are what DuckDB returns where it has the
//! same function (the Python tests check them against DuckDB itself).

mod support;

use std::path::PathBuf;

use support::*;
use workhouse_core::SessionContext;
use workhouse_core::io::StorageOptions;
use workhouse_core::io::json::{JsonNested, JsonOptions, read_json, register_json, write_json};

struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Dir {
        let p = std::env::temp_dir().join(format!("wh_json_nested_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Dir(p)
    }
    fn file(&self, name: &str, content: impl AsRef<[u8]>) -> String {
        let p = self.0.join(name);
        std::fs::write(&p, content).unwrap();
        p.to_str().unwrap().to_string()
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const NESTED: &str = concat!(
    r#"{"id": 1, "user": {"name": "ann", "tags": ["a", "b"], "geo": {"lat": 1.5, "lon": 2}}, "events": [{"k": "x", "n": 1}, {"k": "y"}]}"#, "\n",
    r#"{"id": 2, "user": {"name": "bob", "tags": []}, "events": []}"#, "\n",
    r#"{"id": 3, "user": null, "events": null}"#, "\n",
    r#"{"id": 4, "user": {"name": null, "tags": null, "geo": {"lat": 3, "lon": null}}, "events": [{"k": null, "n": 5}]}"#, "\n",
    r#"{"id": 5}"#, "\n",
);

fn ctx_with(path: &str, opts: JsonOptions) -> SessionContext {
    let ctx = SessionContext::new();
    register_json(&ctx, "t", path, opts, &StorageOptions::new(), false).unwrap();
    ctx
}

fn nested_ctx(dir: &Dir) -> SessionContext {
    ctx_with(&dir.file("n.ndjson", NESTED), JsonOptions::default())
}

fn k(sql: &str) -> String {
    rows_in(&SessionContext::new(), sql)
}

fn err(sql: &str) -> String {
    SessionContext::new().sql(sql).and_then(|d| d.collect()).err().unwrap_or_else(|| panic!("{sql} should fail")).to_string()
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

#[test]
fn objects_and_arrays_are_structs_and_lists() {
    let d = Dir::new("read");
    let ctx = nested_ctx(&d);
    let df = ctx.sql("select * from t").unwrap();
    assert_eq!(
        df.schema().to_string(),
        "[t.id: Int64, t.user: Struct<name: Utf8, tags: List<Utf8>, geo: Struct<lat: Float64, lon: Int64>>, t.events: List<Struct<k: Utf8, n: Int64>>]"
    );
    assert_eq!(
        rows_in(&ctx, "select id, user, events from t order by id"),
        "1,{name:'ann',tags:['a','b'],geo:{lat:1.5,lon:2}},[{k:'x',n:1},{k:'y',n:null}]|\
         2,{name:'bob',tags:[],geo:null},[]|\
         3,null,null|\
         4,{name:null,tags:null,geo:{lat:3.0,lon:null}},[{k:null,n:5}]|\
         5,null,null"
    );
    // a missing field and a null one read the same; a null object and an object of nulls differ
    assert_eq!(
        rows_in(&ctx, "select id, user is null, user.name is null, user.geo.lat from t order by id"),
        "1,false,false,1.5|2,false,false,null|3,true,true,null|4,false,true,3.0|5,true,true,null"
    );
    assert_eq!(rows_in(&ctx, "select id, user.tags[1], len(user.tags), events[1].k, len(events) from t order by id"), "1,a,2,x,2|2,null,0,null,0|3,null,null,null,null|4,null,null,null,1|5,null,null,null,null");
}

#[test]
fn unnest_and_aggregate_nested_json() {
    let d = Dir::new("agg");
    let ctx = nested_ctx(&d);
    assert_eq!(rows_in(&ctx, "select id, e.k, e.n from (select id, unnest(events) as e from t) order by id, e.k"), "1,x,1|1,y,null|4,null,5");
    assert_eq!(rows_in(&ctx, "select sum(e.n), count(e.k) from (select unnest(events) as e from t)"), "6,2");
    assert_eq!(rows_in(&ctx, "select sum(user.geo.lon), max(user.name), count(user) from t"), "2,bob,3");
    assert_eq!(rows_in(&ctx, "select id from t where user.geo.lat > 2 order by id"), "4");
}

#[test]
fn the_file_layout_does_not_change_the_result() {
    let d = Dir::new("layout");
    let want = rows_in(&nested_ctx(&d), "select id, user, events from t order by id");
    // a JSON array of the same records
    let lines: Vec<&str> = NESTED.lines().collect();
    let arr = d.file("n.json", format!("[\n  {}\n]\n", lines.join(",\n  ")));
    assert_eq!(rows_in(&ctx_with(&arr, JsonOptions::default()), "select id, user, events from t order by id"), want);
    // read in many small byte ranges
    let path = d.file("m.ndjson", NESTED);
    for chunk in [7, 64, 4096] {
        let opts = JsonOptions { chunk_bytes: Some(chunk), ..Default::default() };
        assert_eq!(rows_in(&ctx_with(&path, opts), "select id, user, events from t order by id"), want, "chunk {chunk}");
    }
}

#[test]
fn shapes_merge_across_records() {
    let d = Dir::new("merge");
    let text = concat!(
        r#"{"a": {"x": 1}, "b": [1, 2], "c": {"p": 1}, "d": [{"u": 1}]}"#, "\n",
        r#"{"a": {"y": "s", "x": 2.5}, "b": [3.5], "c": [1], "d": [{"v": true}, {"u": 2}]}"#, "\n",
        r#"{"a": {"x": 3}, "b": [], "c": 7, "d": []}"#, "\n",
    );
    let ctx = ctx_with(&d.file("m.ndjson", text), JsonOptions::default());
    let df = ctx.sql("select * from t").unwrap();
    // a gains y (fields are the union, in order of appearance), ints and floats merge to Float64;
    // c holds an object, an array and a number: text
    assert_eq!(
        df.schema().to_string(),
        "[t.a: Struct<x: Float64, y: Utf8>, t.b: List<Float64>, t.c: Utf8, t.d: List<Struct<u: Int64, v: Boolean>>]"
    );
    assert_eq!(
        rows_in(&ctx, "select a, b, c, d from t"),
        "{x:1.0,y:null},[1.0,2.0],{\"p\": 1},[{u:1,v:null}]|\
         {x:2.5,y:'s'},[3.5],[1],[{u:null,v:true},{u:2,v:null}]|\
         {x:3.0,y:null},[],7,[]"
    );
}

#[test]
fn nested_text_reads_json_text() {
    let d = Dir::new("text");
    let path = d.file("n.ndjson", NESTED);
    let ctx = ctx_with(&path, JsonOptions { nested: JsonNested::Text, ..Default::default() });
    let df = ctx.sql("select id, user, events from t").unwrap();
    assert_eq!(df.schema().to_string(), "[t.id: Int64, t.user: Utf8, t.events: Utf8]");
    assert_eq!(
        rows_in(&ctx, "select user, events from t where id = 2 or id = 4 order by id"),
        r#"{"name": "bob", "tags": []},[]|{"name": null, "tags": null, "geo": {"lat": 3, "lon": null}},[{"k": null, "n": 5}]"#
    );
    // the SQL option, in both spellings
    for opt in ["nested => 'text'", "nested := 'text'"] {
        let c = SessionContext::new();
        let df = c.sql(&format!("select user from read_json('{path}', {opt})")).unwrap();
        assert_eq!(df.schema().to_string(), "[read_json.user: Utf8]", "{opt}");
    }
    let c = SessionContext::new();
    let df = c.sql(&format!("select user from read_json('{path}')")).unwrap();
    assert!(df.schema().to_string().contains("Struct<name: Utf8"), "{}", df.schema());
    let e = c.sql(&format!("select user from read_json('{path}', nested => 'xml')")).err().unwrap().to_string();
    assert!(e.contains("nested"), "{e}");
}

#[test]
fn values_that_do_not_fit_are_reported() {
    let d = Dir::new("skew");
    let path = d.file("s.ndjson", "{\"a\": {\"x\": 1}}\n{\"a\": {\"x\": \"late\"}}\n");
    let ctx = ctx_with(&path, JsonOptions { infer_rows: 1, ..Default::default() });
    let e = ctx.sql("select * from t").unwrap().collect().unwrap_err().to_string();
    assert!(e.contains("column 'a.x'"), "{e}");
    // with the whole file in the sample, x is text
    let ctx = ctx_with(&path, JsonOptions::default());
    assert_eq!(rows_in(&ctx, "select a from t"), "{x:'1'}|{x:'late'}");
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

#[test]
fn lists_and_structs_are_written_as_arrays_and_objects() {
    let d = Dir::new("write");
    let ctx = nested_ctx(&d);
    let (schema, batches) = ctx.sql("select id, user, events from t order by id").unwrap().collect().unwrap();
    let out = d.file("out.ndjson", "");
    write_json(&out, &batches).unwrap();
    let text = std::fs::read_to_string(&out).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], r#"{"id":1,"user":{"name":"ann","tags":["a","b"],"geo":{"lat":1.5,"lon":2}},"events":[{"k":"x","n":1},{"k":"y","n":null}]}"#);
    assert_eq!(lines[1], r#"{"id":2,"user":{"name":"bob","tags":[],"geo":null},"events":[]}"#);
    assert_eq!(lines[2], r#"{"id":3,"user":null,"events":null}"#);
    assert_eq!(lines[3], r#"{"id":4,"user":{"name":null,"tags":null,"geo":{"lat":3.0,"lon":null}},"events":[{"k":null,"n":5}]}"#);
    // reading it back gives the same data and the same types
    let back = ctx_with(&out, JsonOptions::default());
    let again = back.sql("select id, user, events from t order by id").unwrap();
    assert_eq!(again.schema().field(1).data_type(), schema.field(1).data_type());
    assert_eq!(again.schema().field(2).data_type(), schema.field(2).data_type());
    assert_eq!(
        rows_in(&back, "select id, user, events from t order by id"),
        rows_in(&ctx, "select id, user, events from t order by id")
    );
}

#[test]
fn strings_inside_nested_values_are_escaped() {
    let ctx = SessionContext::new();
    let (_, batches) = ctx.sql("select {'q': 'a\"b\\c', 'l': ['é', NULL, 'x\ny']} as s").unwrap().collect().unwrap();
    let d = Dir::new("escape");
    let out = d.file("e.ndjson", "");
    write_json(&out, &batches).unwrap();
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "{\"s\":{\"q\":\"a\\\"b\\\\c\",\"l\":[\"é\",null,\"x\\ny\"]}}\n");
    let lf = read_json(&ctx, &out, JsonOptions::default(), &StorageOptions::new()).unwrap();
    let (_, back) = lf.collect().unwrap();
    assert_eq!(render(&back), "{q:'a\"b\\c',l:['é',null,'x\ny']}");
}

// ---------------------------------------------------------------------------
// JSON text functions
// ---------------------------------------------------------------------------

const DOC: &str = r#"{"a":{"b":[1,2,{"c":"x"}]},"n":null,"s":"x\ny","f":1.50,"t":true}"#;

fn doc(sql: &str) -> String {
    k(&sql.replace("DOC", &format!("'{DOC}'")))
}

#[test]
fn json_extract_follows_paths() {
    assert_eq!(doc(r#"select json_extract(DOC, '$.a.b[2].c'), json_extract(DOC, '$.a.b[0]'), json_extract(DOC, '$.a.b[#-1]'), json_extract(DOC, '$.a.b[-3]')"#), "\"x\",1,{\"c\":\"x\"},1");
    assert_eq!(doc("select json_extract(DOC, '$.a.b')"), "[1,2,{\"c\":\"x\"}]");
    // a JSON null is the text null, a missing path is NULL
    assert_eq!(doc("select json_extract(DOC, '$.n'), json_extract(DOC, '$.zz'), json_extract(DOC, '$.a.b[9]'), json_extract(DOC, '$.t.x')"), "null,null,null,null");
    assert_eq!(doc("select json_extract(DOC, '$.s'), json_extract(DOC, 's'), json_extract(DOC, '$.t')"), "\"x\\ny\",\"x\\ny\",true");
    assert_eq!(k(r#"select json_extract('{"a b":1}', '$."a b"'), json_extract('[5,6]', 1), json_extract('[5,6]', '$[1]'), json_extract('7', '$')"#), "1,6,6,7");
    assert_eq!(k("select json_extract(NULL, '$.a'), json_extract(NULL::VARCHAR, 'a')"), "null,null");
}

#[test]
fn json_extract_string_unquotes() {
    assert_eq!(doc("select json_extract_string(DOC, '$.s'), json_extract_string(DOC, '$.t'), json_extract_string(DOC, '$.a.b[2].c'), json_extract_string(DOC, 'n'), json_extract_string(DOC, '$.zz')"), "x\ny,true,x,null,null");
    assert_eq!(doc("select json_extract_string(DOC, '$.a.b[0]'), json_extract_string(DOC, '$.a.b[2]')"), "1,{\"c\":\"x\"}");
    assert_eq!(doc("select json_value(DOC, '$.s')"), "x\ny");
}

#[test]
fn arrows_are_extract_and_extract_string() {
    assert_eq!(k(r#"select '{"a":{"b":5}}' -> '$.a.b', '{"a":{"b":5}}' ->> '$.a.b', '{"a":{"b":5}}' -> 'a' -> 'b', '{"a":"s"}' ->> 'a'"#), "5,5,5,s");
    assert_eq!(k(r#"select '{"a":[1,2,3]}' -> 'a', '{"a":[1,2,3]}' ->> '$.a[1]', '[5,6]' -> 1"#), "[1,2,3],2,6");
    let ctx = SessionContext::new();
    let d = Dir::new("arrows");
    register_json(&ctx, "t", &d.file("x.ndjson", "{\"j\": \"{\\\"v\\\": 10}\"}\n{\"j\": \"{\\\"v\\\": 20}\"}\n"), JsonOptions::default(), &StorageOptions::new(), false).unwrap();
    assert_eq!(rows_in(&ctx, "select j ->> 'v', (j -> 'v') from t"), "10,10|20,20");
    assert_eq!(rows_in(&ctx, "select j -> 'v' ->> '$' from t"), "10|20");
    assert_eq!(rows_in(&ctx, "select sum(cast(j ->> '$.v' as bigint)) from t"), "30");
}

#[test]
fn json_array_length_counts_elements() {
    assert_eq!(k(r#"select json_array_length('[1,[2,3]]'), json_array_length('[]'), json_array_length('{"a":[1,2,3]}', '$.a'), json_array_length('{"a":1}'), json_array_length('5')"#), "2,0,3,0,0");
    assert_eq!(k(r#"select json_array_length('{"a":[1,2,3]}', '$.zz'), json_array_length(NULL)"#), "null,null");
}

#[test]
fn json_text_errors_are_clear() {
    assert!(err("select json_extract('not json', '$.a')").contains("invalid JSON"));
    assert!(err("select json_extract('{}', '$a')").contains("invalid JSON path"));
    assert!(err("select json_extract('{}', '$.a[')").contains("invalid JSON path"));
    assert!(err("select json_extract('{}', NULL)").contains("path"));
    assert!(err("select json_extract('{}')").contains("expects"));
}

#[test]
fn to_json_encodes_any_value() {
    assert_eq!(k("select to_json({'a': 1, 'b': [1, NULL, 2]}), to_json('str'), to_json(NULL::INT), to_json(1.5), to_json(true)"), "{\"a\":1,\"b\":[1,null,2]},\"str\",null,1.5,true");
    assert_eq!(k("select to_json([{'x': 'é\"'}]), to_json([]::INT[]), to_json({'a': NULL::INT})"), "[{\"x\":\"é\\\"\"}],[],{\"a\":null}");
    let ctx = SessionContext::new();
    let (schema, b) = ctx.sql("select 1 as id, {'a': 1, 'b': 'x'} as s union all select 2, NULL::STRUCT(a BIGINT, b VARCHAR)").unwrap().collect().unwrap();
    ctx.register_batches("t", schema, b);
    assert_eq!(rows_in(&ctx, "select id, to_json(s), json_extract_string(to_json(s), '$.b') from t order by id"), "1,{\"a\":1,\"b\":\"x\"},x|2,null,null");
}

#[test]
fn from_json_builds_typed_values() {
    assert_eq!(k(r#"select from_json('{"a":1,"b":[1,2]}', 'STRUCT(a INT, b INT[])')"#), "{a:1,b:[1,2]}");
    assert_eq!(k(r#"select from_json('[{"x":1,"y":"u"},{"x":2}]', 'STRUCT(x BIGINT, y VARCHAR)[]')"#), "[{x:1,y:'u'},{x:2,y:null}]");
    // extra members are ignored, absent ones are NULL, numbers can become text
    assert_eq!(k(r#"select from_json('{"a":1,"z":0}', 'STRUCT(a VARCHAR, c INT)')"#), "{a:'1',c:null}");
    assert_eq!(k(r#"select from_json('5', 'INT'), from_json('"x"', 'VARCHAR'), from_json('2.5', 'DOUBLE'), from_json('"2024-03-05"', 'DATE'), from_json('null', 'INT')"#), "5,x,2.5,2024-03-05,null");
    assert_eq!(k("select from_json(NULL, 'STRUCT(a INT)')"), "null");
    // typed fields are cast to the requested types
    let df = SessionContext::new().sql(r#"select from_json('{"a":1,"d":"2024-01-02"}', 'STRUCT(a TINYINT, d DATE)') as s"#).unwrap();
    assert_eq!(df.schema().to_string(), "[s: Struct<a: Int8, d: Date32>]");
    // round trip with to_json
    assert_eq!(k("select from_json(to_json({'a': 1, 'b': ['p', NULL]}), 'STRUCT(a BIGINT, b VARCHAR[])')"), "{a:1,b:['p',null]}");
    assert!(err(r#"select from_json('{"a":"x"}', 'STRUCT(a INT)')"#).contains("column 'json.a'") || err(r#"select from_json('{"a":"x"}', 'STRUCT(a INT)')"#).contains("expected"));
    assert!(err("select from_json('{}', 'nonsense')").contains("unknown data type"));
    assert!(err("select from_json('{}')").contains("expects"));
}
