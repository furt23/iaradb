/** Quoting for the POSIX shell that runs a remote SSH command (pure). */

/** One argument, single-quoted. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

/** A path, quoted except a leading `~/` (left for the shell to expand). */
export function quotePath(p: string): string {
  if (p === "~") return "~";
  return p.startsWith("~/") ? `~/${shellQuote(p.slice(2))}` : shellQuote(p);
}
