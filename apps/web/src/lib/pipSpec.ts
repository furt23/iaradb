/** pip requirement specs (PEP 508 without URLs and markers): pure, shared by the dialog and the server. */

const MAX_LENGTH = 200;
/** A distribution name, as PEP 508 allows it. */
const NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
/** The longest run of name characters at the start of a spec (checked by NAME). */
const NAME_RUN = /^[A-Za-z0-9._-]*/;
/** A PEP 440 public version. */
const VERSION = /^(\d+!)?\d+(\.\d+)*((a|b|rc)\d+)?(\.post\d+)?(\.dev\d+)?$/;
/** The release part of a version (`1!2.3.4` gives `2.3.4`). */
const RELEASE = /^(\d+!)?(\d+(\.\d+)*)/;
/** What `===` accepts: any non-empty run without spaces, commas or quotes. */
const ARBITRARY = /^[^\s,'"]+$/;
/** Longest operators first, so `<=` is not read as `<`. */
const OPERATORS = ["===", "~=", "==", "!=", "<=", ">=", "<", ">"];

function versionError(op: string, version: string): string | null {
  if (version === "") return "missing version";
  if (op === "===") return ARBITRARY.test(version) ? null : `bad version "${version}"`;
  const wildcard = (op === "==" || op === "!=") && version.endsWith(".*");
  const base = wildcard ? version.slice(0, -2) : version;
  if (!VERSION.test(base)) return `bad version "${version}"`;
  if (op === "~=" && RELEASE.exec(base)![2].split(".").length < 2) return "~= needs at least two version parts";
  return null;
}

/** `op version` clauses separated by commas, e.g. `>=1.5,<2`. */
function specifiersError(text: string): string | null {
  for (const clause of text.split(",")) {
    const c = clause.trim();
    if (c === "") return "empty version clause";
    const op = OPERATORS.find((o) => c.startsWith(o));
    if (op === undefined) return "unknown operator";
    const error = versionError(op, c.slice(op.length).trim());
    if (error) return error;
  }
  return null;
}

/** Why `spec` is not a valid requirement, or null when it is. */
export function pipSpecError(spec: string): string | null {
  const text = spec.trim();
  if (text === "") return "empty";
  if (text.length > MAX_LENGTH) return `longer than ${MAX_LENGTH} characters`;

  const name = NAME_RUN.exec(text)![0];
  if (!NAME.test(name)) return "not a package name";
  let rest = text.slice(name.length).trimStart();
  if (rest === "") return null;

  if (rest.startsWith("@") || rest.includes("://")) return "URLs are not supported";
  if (rest.startsWith(";")) return "environment markers are not supported";

  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) return "missing ]";
    const extras = rest.slice(1, close);
    if (extras.trim() === "") return "empty extras";
    for (const extra of extras.split(",")) {
      if (!NAME.test(extra.trim())) return "not a package name";
    }
    rest = rest.slice(close + 1).trimStart();
    if (rest === "") return null;
  }

  if (rest.startsWith("(")) return "parenthesized specifiers are not supported";
  return specifiersError(rest);
}
