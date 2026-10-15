/** Where the Data pages and the SQL editor show a table. */

export function tableHref(name: string | null): string {
  return name ? `/data/${encodeURIComponent(name)}` : "/data";
}

/** The wrangler on a table. */
export function wrangleHref(name: string | null): string {
  return name ? `/wrangle/${encodeURIComponent(name)}` : "/wrangle";
}

/** The table a pathname shows (`/data/<name>` or `/wrangle/<name>`), if any. */
export function tableFromPathname(pathname: string): string | null {
  const m = /^\/(?:data|wrangle)\/([^/]+)$/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

export function sampleQuery(name: string): string {
  return `select *\nfrom ${name}\nlimit 100`;
}

/** The SQL editor with a query to run. */
export function sqlHref(query: string): string {
  return `/sql?q=${encodeURIComponent(query)}`;
}
