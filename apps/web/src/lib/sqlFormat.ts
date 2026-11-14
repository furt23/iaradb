/** SQL laid out for reading (pure): keywords upper case, one clause per line. */

import { format } from "sql-formatter";

/** `sql` formatted in the engine's DuckDB-style dialect; text the formatter cannot parse comes back as it was. */
export function formatSql(sql: string): string {
  try {
    return format(sql, { language: "duckdb", keywordCase: "upper", tabWidth: 2, linesBetweenQueries: 1 });
  } catch {
    return sql;
  }
}
