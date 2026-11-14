import type { SystemTable } from "./index";

export const queryTables: SystemTable = {
  name: "query_tables",
  columns: [
    ["query_id", "string"],
    ["ts", "timestamp"],
    ["user", "string"],
    ["kernel", "string"],
    ["source", "string"],
    ["access", "string"],
    ["table", "string"],
    ["location", "string"],
    ["version", "int"],
    ["operation", "string"],
  ],
};
