import { describe, expect, it } from "vitest";

import { splitStatements } from "./sqlStatements";

describe("splitStatements", () => {
  it("splits at semicolons outside quotes and comments", () => {
    const sql = `-- nightly refresh
create or replace table t as select ';' as a, 'it''s' as b; /* ; inside */
insert into t select "x;y", 'z' -- a comment; still
;
select 1`;
    expect(splitStatements(sql)).toEqual([
      "-- nightly refresh\ncreate or replace table t as select ';' as a, 'it''s' as b",
      '/* ; inside */\ninsert into t select "x;y", \'z\' -- a comment; still',
      "select 1",
    ]);
  });

  it("drops empty and comment-only statements", () => {
    expect(splitStatements("select 1;;\n-- the end\n")).toEqual(["select 1"]);
    expect(splitStatements("  ")).toEqual([]);
  });
});
