import type { SystemTable } from "./index";

export const queries: SystemTable = {
  name: "queries",
  columns: [
    ["id", "string"],
    ["ts", "timestamp"],
    ["user", "string"],
    ["kernel", "string"],
    ["cluster", "string"],
    ["source", "string"],
    ["kind", "string"],
    ["query", "string"],
    ["elapsed_ms", "float"],
    ["rows", "int"],
    ["error", "string"],
    ["memory_peak", "int"],
    ["spilled_bytes", "int"],
  ],
};
