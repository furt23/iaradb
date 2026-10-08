import { describe, expect, it } from "vitest";

import { bucketsOf } from "./buckets";

describe("bucketsOf", () => {
  it("collects the buckets of tables and storage sections", () => {
    const toml = `
[workspace]
name = "w"

[tables.a]
path = "s3://sales-data/2024/*.parquet"

[tables.b]
path = "data/local.parquet"

[tables.c]
path = "s3a://raw-zone/events/"

[storage."s3://sales-data"]
region = "us-east-1"

[storage."s3://shared-lake/prefix"]
region = "us-east-1"
`;
    expect(bucketsOf(toml)).toEqual(["raw-zone", "sales-data", "shared-lake"]);
  });

  it("is empty without a config or with a broken one", () => {
    expect(bucketsOf(null)).toEqual([]);
    expect(bucketsOf("[tables.x\npath =")).toEqual([]);
  });
});
