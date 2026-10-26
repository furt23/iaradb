"use client";

import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql, StandardSQL } from "@codemirror/lang-sql";
import { forceLinting } from "@codemirror/lint";
import { unifiedMergeView } from "@codemirror/merge";
import { Prec, type Extension } from "@codemirror/state";
import { keymap, tooltips, type EditorView } from "@codemirror/view";
import { useColorScheme } from "@mui/material/styles";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useContext, useEffect, useMemo, useRef } from "react";

import type { EditorAssist } from "./assist";
import { kernelCompletion } from "./completion";
import { editorTheme } from "./editorTheme";
import { FindContext, findHighlight, setFindRegExp } from "./findHighlight";
import { kernelLinter } from "./lint";
import { signatureHelp } from "./signatureHelp";
import { sqlNamespace } from "./sqlNamespace";

/**
 * Completions, signatures and lint messages float over the page: inside the
 * editor they are clipped by the cell (a one-line cell hides them entirely).
 * CodeMirror gives the floating container the editor's theme classes.
 */
function floatingTooltips(): Extension {
  return typeof document === "undefined" ? [] : tooltips({ position: "fixed", parent: document.body });
}

export type EditorLanguage = "python" | "sql" | "markdown";

export interface CodeEditorProps {
  value: string;
  onChange?(value: string): void;
  language: EditorLanguage;
  /** Shift+Enter */
  onRun?(): void;
  /** Ctrl/Cmd+Enter */
  onRunInPlace?(): void;
  onSave?(): void;
  /** table -> columns, for SQL completion (a table by its display name, and by its full name in the default catalog) */
  schema?: Record<string, { name: string }[]>;
  readOnly?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  minHeight?: number;
  maxHeight?: number;
  lineNumbers?: boolean;
  /** completions, signature help and diagnostics from the kernel */
  assist?: EditorAssist;
  /** diagnostics are asked for again whenever this turns true (what the code reads from elsewhere may have changed) */
  relint?: boolean;
  /** the code before a change Iara proposes: the editor shows its value as a diff against it (removed lines in red, new ones in green), with keep/undo controls on each changed block unless read-only */
  original?: string;
}

function languageExtension(language: EditorLanguage, schema?: CodeEditorProps["schema"]): Extension {
  if (language === "python") return python();
  if (language === "markdown") return markdown();
  return sql({ dialect: StandardSQL, schema: sqlNamespace(schema ?? {}), upperCaseKeywords: false });
}

function assistExtensions(language: EditorLanguage, assist?: EditorAssist): Extension[] {
  if (!assist) return [];
  const out: Extension[] = [];
  if (assist.lint) out.push(kernelLinter(assist.lint));
  if (language === "python" && assist.complete) out.push(kernelCompletion(assist.complete));
  if (language === "python" && assist.signature) out.push(signatureHelp(assist.signature));
  return out;
}

export function CodeEditor(props: CodeEditorProps) {
  const { mode, systemMode } = useColorScheme();
  const scheme = (mode === "system" ? systemMode : mode) ?? "dark";
  // handlers in a ref: callers pass fresh closures on every render, and new
  // extensions would reconfigure the editor (dropping plugin state) per keystroke
  const handlers = useRef(props);
  handlers.current = props;
  const keys = useMemo(() => {
    const call = (name: "onRun" | "onRunInPlace" | "onSave") => () => {
      const f = handlers.current[name];
      if (!f) return false;
      f();
      return true;
    };
    return Prec.highest(
      keymap.of([
        { key: "Shift-Enter", run: call("onRun") },
        { key: "Mod-Enter", run: call("onRunInPlace") },
        { key: "Mod-s", run: call("onSave"), preventDefault: true },
      ]),
    );
  }, []);
  const assist = useMemo(() => assistExtensions(props.language, props.assist), [props.language, props.assist]);
  // rebuilt only for a new original or mode: reconfiguring the editor drops plugin state
  const merge = useMemo(
    () => (props.original === undefined ? [] : unifiedMergeView({ original: props.original, mergeControls: !props.readOnly, gutter: true })),
    [props.original, props.readOnly],
  );
  const extensions = useMemo(
    () => [languageExtension(props.language, props.schema), editorTheme(scheme), keys, findHighlight, floatingTooltips(), ...assist, merge],
    [props.language, props.schema, scheme, keys, assist, merge],
  );
  // in a notebook the find bar searches every cell: it replaces the editor's own search panel
  const find = useContext(FindContext);
  const regexp = find?.regexp ?? null;
  const view = useRef<EditorView | null>(null);
  const regexpRef = useRef(regexp);
  regexpRef.current = regexp;
  const onCreateEditor = useCallback((v: EditorView) => {
    view.current = v;
    v.dispatch({ effects: setFindRegExp.of(regexpRef.current) });
  }, []);
  useEffect(() => view.current?.dispatch({ effects: setFindRegExp.of(regexp) }), [regexp]);
  useEffect(() => {
    if (props.relint && view.current) forceLinting(view.current);
  }, [props.relint]);
  const onChange = useCallback((value: string) => handlers.current.onChange?.(value), []);
  // the kernel's completions replace the built-in ones (they include them)
  const kernelCompletes = props.language === "python" && !!props.assist?.complete;
  const readOnly = !!props.readOnly;
  const basicSetup = useMemo(
    () => ({
      lineNumbers: props.lineNumbers ?? true,
      foldGutter: false,
      highlightActiveLine: !readOnly,
      highlightActiveLineGutter: !readOnly,
      autocompletion: !kernelCompletes,
      bracketMatching: true,
      closeBrackets: true,
      indentOnInput: true,
      searchKeymap: !find,
      tabSize: 4,
    }),
    [props.lineNumbers, readOnly, kernelCompletes, find],
  );
  return (
    <CodeMirror
      value={props.value}
      onChange={onChange}
      extensions={extensions}
      theme="none"
      readOnly={props.readOnly}
      editable={!props.readOnly}
      onCreateEditor={onCreateEditor}
      autoFocus={props.autoFocus}
      placeholder={props.placeholder}
      minHeight={props.minHeight ? `${props.minHeight}px` : undefined}
      maxHeight={props.maxHeight ? `${props.maxHeight}px` : undefined}
      basicSetup={basicSetup}
    />
  );
}
