/** Splitting a SQL file into its statements (pure): at `;` outside quotes and comments. */

/** The statements of `sql`, trimmed; those holding only comments are dropped. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const text = sql.slice(start, end).trim();
    if (text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim()) out.push(text);
  };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      // a quote ends at its next unescaped twin ('' or "" escape it)
      i++;
      while (i < sql.length && !(sql[i] === c && sql[i + 1] !== c)) i += sql[i] === c ? 2 : 1;
      i++;
    } else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === ";") {
      push(i);
      start = ++i;
    } else {
      i++;
    }
  }
  push(sql.length);
  return out;
}
