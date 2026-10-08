/** Code assistance for notebook cells (see workhouse.kernel.assist). */

export interface CompletionItem {
  label: string;
  /** editor completion type: function, class, variable, property, keyword, namespace, text */
  type: string;
  /** parameters and return type, e.g. `(path: str) -> LazyFrame` */
  detail?: string;
  /** full signature */
  signature?: string;
  doc?: string;
}

export interface Completions {
  /** offset where the completed word starts (items replace code[from:cursor]) */
  from: number;
  items: CompletionItem[];
}

export interface SignatureHelp {
  name: string;
  params: string[];
  /** index of the parameter being typed (null: none) */
  active: number | null;
  returns: string | null;
  doc: string;
}

export interface Diagnostic {
  from: number;
  to: number;
  severity: "error" | "warning" | "info";
  message: string;
}

/** What the Studio's assist endpoint is asked for (one notebook cell). */
export type AssistRequest =
  | { op: "complete" | "signature"; path: string; cellId: string; code: string; cursor: number }
  | { op: "lint"; path: string; cellId: string; kind: "python" | "sql" | "markdown"; code: string };
